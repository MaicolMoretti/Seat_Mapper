import os
from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from database import models, database
from vision import processor
from routers import manual as manual_router
from typing import List, Optional
import shutil
import uuid
import asyncio
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi import BackgroundTasks, WebSocket, WebSocketDisconnect, Header
import json
from ws_manager import manager, broadcast_layout_update

app = FastAPI(title="Seat Assignment API")
main_loop = None

# Setup CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For dev only, configure properly in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register the manual-editing router
app.include_router(manual_router.router)

async def heartbeat():
    while True:
        await manager.broadcast({"type": "PING"})
        await asyncio.sleep(20)

@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()
    asyncio.create_task(heartbeat())

# Global dict to hold progress for each upload task
progress_store = {}

# ─── WebSocket Manager ───────────────────────────────────────────────────────
# (Moved to ws_manager.py)

# ─── Permission Helper ───────────────────────────────────────────────────────
# (Moved to dependencies.py)

# Init DB (creates new tables / columns on first run, no-op on existing ones)
models.Base.metadata.create_all(bind=database.engine)

# ─── SQLite migration helper ────────────────────────────────────────────────
# SQLAlchemy's create_all does NOT add missing columns to existing tables in
# SQLite.  We handle this ourselves with a lightweight ALTER TABLE if needed.
def _migrate_sqlite():
    import sqlite3
    db_path = os.path.join(os.path.dirname(__file__), "database.db")
    if not os.path.exists(db_path):
        return  # fresh DB, create_all already covered it

    conn = sqlite3.connect(db_path, timeout=30.0)
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")

    def _columns(table: str):
        cur.execute(f"PRAGMA table_info({table})")
        return {row[1] for row in cur.fetchall()}

    # tables: add detected_by
    if "detected_by" not in _columns("tables"):
        cur.execute("ALTER TABLE tables ADD COLUMN detected_by TEXT DEFAULT 'auto'")

    # seats: add detected_by and angle
    if "detected_by" not in _columns("seats"):
        cur.execute("ALTER TABLE seats ADD COLUMN detected_by TEXT DEFAULT 'auto'")
    
    # tables: add angle
    if "angle" not in _columns("tables"):
        cur.execute("ALTER TABLE tables ADD COLUMN angle FLOAT DEFAULT 0.0")
        
    # seats: add angle
    if "angle" not in _columns("seats"):
        cur.execute("ALTER TABLE seats ADD COLUMN angle FLOAT DEFAULT 0.0")

    conn.commit()
    conn.close()

_migrate_sqlite()

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
os.makedirs(FRONTEND_DIR, exist_ok=True)
app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")

@app.get("/", response_class=HTMLResponse)
async def read_index():
    with open(os.path.join(FRONTEND_DIR, "index.html"), "r") as f:
        return f.read()

from dependencies import get_db, get_client_type, require_desktop

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial state/welcome if needed
        await websocket.send_json({"type": "CONNECTED", "message": "Real-time sync active"})
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(websocket)


# ─── Progress stream ─────────────────────────────────────────────────────────
@app.get("/upload-progress/{task_id}")
async def upload_progress(task_id: str):
    import json
    async def event_generator():
        while True:
            state = progress_store.get(
                task_id,
                {"progress": 0, "message": "Waiting...", "done": False, "error": False},
            )
            yield f"data: {json.dumps(state)}\n\n"
            if state["done"] or state.get("error"):
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


def process_map_background(task_id: str, filepath: str):
    def update_progress(percent, msg):
        progress_store[task_id] = {
            "progress": percent, "message": msg, "done": False, "error": False
        }

    try:
        # Step 1: Detect tables & seats via computer vision FIRST (No DB lock during heavy OCR)
        tables_data = processor.detect_tables_and_seats(
            filepath, progress_callback=update_progress
        )

        # Step 2: Save to database in a quick atomic transaction
        db = database.SessionLocal()
        try:
            # Clear previous data
            db.query(models.TableNumberOverride).delete()
            db.query(models.Seat).delete()
            db.query(models.Table).delete()
            db.query(models.MapImage).delete()

            map_img = models.MapImage(filename="map.jpg", filepath=filepath)
            db.add(map_img)
            db.flush()

            for t_data in tables_data:
                table = models.Table(
                    map_id=map_img.id,
                    table_number=t_data["table_id"],
                    contour_x=t_data["contour"]["x"],
                    contour_y=t_data["contour"]["y"],
                    contour_w=t_data["contour"]["w"],
                    contour_h=t_data["contour"]["h"],
                    angle=t_data["contour"].get("angle", 0.0),
                    detected_by="auto",          # ← stamped by pipeline
                )
                db.add(table)
                db.flush()

                for s_data in t_data["seats"]:
                    seat = models.Seat(
                        table_id=table.id,
                        seat_number=s_data["seat_id"],
                        position_x=s_data["position"][0],
                        position_y=s_data["position"][1],
                        angle=s_data.get("angle", 0.0),
                        occupied=s_data["occupied"],
                        detected_by="auto",      # ← stamped by pipeline
                    )
                    db.add(seat)

            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

        progress_store[task_id] = {
            "progress": 100, "message": "Done!", "done": True, "error": False
        }
        # Notify clients about the new map (Thread-safe)
        if main_loop:
            main_loop.call_soon_threadsafe(
                lambda: asyncio.create_task(broadcast_layout_update())
            )
    except Exception as e:
        progress_store[task_id] = {
            "progress": 100, "message": f"Error: {str(e)}", "done": True, "error": True
        }



@app.post("/upload-map")
async def upload_map(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    task_id = str(uuid.uuid4())
    progress_store[task_id] = {
        "progress": 0, "message": "Received image...", "done": False, "error": False
    }

    filepath = os.path.join(UPLOAD_DIR, "map.jpg")
    with open(filepath, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    background_tasks.add_task(process_map_background, task_id, filepath)
    return {"message": "Upload started", "task_id": task_id}


@app.get("/map")
def get_map(db: Session = Depends(get_db)):
    map_img = db.query(models.MapImage).first()
    if not map_img:
        return {"filename": None, "url": None}
    return {"filename": map_img.filename, "url": f"/uploads/{map_img.filename}"}


# ─── /layout — merged auto+manual view with number overrides ─────────────────
@app.get("/layout")
def get_layout(db: Session = Depends(get_db)):
    """
    Returns all tables and their seats.
    - detected_by indicates origin ("auto" or "manual")
    - table_number is the resolved number: manual override takes priority over OCR
    """
    tables = db.query(models.Table).all()
    # Build override map
    overrides = {
        o.table_id: o.manual_number
        for o in db.query(models.TableNumberOverride).all()
    }
    result = []
    for t in tables:
        seats = db.query(models.Seat).filter(models.Seat.table_id == t.id).all()
        resolved_number = overrides.get(t.id, t.table_number)
        has_override = t.id in overrides
        result.append({
            "id": t.id,
            "table_number": resolved_number,
            "table_number_original": t.table_number,
            "number_overridden": has_override,
            "contour": {
                "x": t.contour_x, "y": t.contour_y,
                "w": t.contour_w, "h": t.contour_h,
                "angle": t.angle or 0.0,
            },
            "detected_by": t.detected_by or "auto",
            "seats": [
                {
                    "id": s.id,
                    "position": [s.position_x, s.position_y],
                    "angle": s.angle or 0.0,
                    "occupied": s.occupied,
                    "occupied_at": s.occupied_at,
                    "detected_by": s.detected_by or "auto",
                }
                for s in seats
            ],
        })
    return result


# ─── Legacy /tables (kept for backward compat, delegates to /layout) ─────────
@app.get("/tables")
def get_tables(db: Session = Depends(get_db)):
    return get_layout(db)


import time
from datetime import datetime

def _record_occupancy_change(db: Session, newly_occupied_count: int = 0):
    """Records an occupancy event log and updates cumulative total occupied events counter."""
    now = time.time()
    time_str = datetime.fromtimestamp(now).strftime("%H:%M:%S")
    
    total_seats = db.query(models.Seat).count()
    occupied_seats = db.query(models.Seat).filter(models.Seat.occupied == True).count()
    
    # Update total cumulative events counter if newly_occupied_count > 0
    if newly_occupied_count > 0:
        counter = db.query(models.StatsCounter).filter(models.StatsCounter.key == "total_occupied_events").first()
        if not counter:
            counter = models.StatsCounter(key="total_occupied_events", value=0)
            db.add(counter)
        counter.value += newly_occupied_count
    
    # Save occupancy log entry
    log_entry = models.OccupancyLog(
        timestamp=now,
        time_str=time_str,
        occupied_seats=occupied_seats,
        total_seats=total_seats
    )
    db.add(log_entry)
    db.commit()

@app.post("/seat/toggle/{seat_id}")
async def toggle_seat(seat_id: int, db: Session = Depends(get_db)):
    seat = db.query(models.Seat).filter(models.Seat.id == seat_id).first()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
    
    was_occupied = seat.occupied
    seat.occupied = not seat.occupied
    seat.occupied_at = time.time() if seat.occupied else None
    
    # If it transitioned from False to True, increment cumulative by 1
    newly_occupied = 1 if (not was_occupied and seat.occupied) else 0
    _record_occupancy_change(db, newly_occupied)
    
    await broadcast_layout_update()
    await manager.broadcast({"type": "STATS_UPDATE"})
    return {"id": seat.id, "occupied": seat.occupied}


@app.post("/seat/clear-all")
async def clear_all_seats(db: Session = Depends(get_db)):
    db.query(models.Seat).update({models.Seat.occupied: False, models.Seat.occupied_at: None})
    db.commit()
    _record_occupancy_change(db, 0)
    await broadcast_layout_update()
    await manager.broadcast({"type": "STATS_UPDATE"})
    return {"message": "All seats cleared"}


def _resolve_table_by_number(db: Session, table_number: int):
    """Find a table by its *resolved* number (override takes priority)."""
    override = (
        db.query(models.TableNumberOverride)
        .filter(models.TableNumberOverride.manual_number == table_number)
        .first()
    )
    if override:
        return db.query(models.Table).filter(models.Table.id == override.table_id).first()
    return db.query(models.Table).filter(models.Table.table_number == table_number).first()


@app.post("/table/{table_number}/add-seats")
async def add_seats(table_number: int, amount: int = Form(...), db: Session = Depends(get_db)):
    table = _resolve_table_by_number(db, table_number)
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    free_seats = (
        db.query(models.Seat)
        .filter(models.Seat.table_id == table.id, models.Seat.occupied == False)
        .order_by(models.Seat.detected_by.asc())
        .limit(amount)
        .all()
    )
    now = time.time()
    for seat in free_seats:
        seat.occupied = True
        seat.occupied_at = now
    db.commit()
    
    _record_occupancy_change(db, len(free_seats))
    
    await broadcast_layout_update()
    await manager.broadcast({"type": "STATS_UPDATE"})
    return {"message": f"Added {len(free_seats)} seats (marked as occupied)"}


@app.post("/table/{table_number}/remove-seats")
async def remove_seats(table_number: int, amount: int = Form(...), db: Session = Depends(get_db)):
    table = _resolve_table_by_number(db, table_number)
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    occupied_seats = (
        db.query(models.Seat)
        .filter(models.Seat.table_id == table.id, models.Seat.occupied == True)
        .order_by(models.Seat.occupied_at.asc())
        .limit(amount)
        .all()
    )
    for seat in occupied_seats:
        seat.occupied = False
        seat.occupied_at = None
    db.commit()
    
    _record_occupancy_change(db, 0)
    
    await broadcast_layout_update()
    await manager.broadcast({"type": "STATS_UPDATE"})
    return {"message": f"Removed {len(occupied_seats)} seats (marked as free)"}


@app.get("/stats")
def get_stats(db: Session = Depends(get_db)):
    num_tables = db.query(models.Table).count()
    total_seats = db.query(models.Seat).count()
    occupied_seats = db.query(models.Seat).filter(models.Seat.occupied == True).count()
    free_seats = total_seats - occupied_seats
    
    counter = db.query(models.StatsCounter).filter(models.StatsCounter.key == "total_occupied_events").first()
    total_occupied_events = counter.value if counter else 0
    
    return {
        "num_tables": num_tables,
        "total_seats": total_seats,
        "occupied_seats": occupied_seats,
        "free_seats": free_seats,
        "total_occupied_events": total_occupied_events
    }


@app.get("/stats/history")
def get_stats_history(db: Session = Depends(get_db)):
    logs = db.query(models.OccupancyLog).order_by(models.OccupancyLog.timestamp.asc()).all()
    
    counter = db.query(models.StatsCounter).filter(models.StatsCounter.key == "total_occupied_events").first()
    total_occupied_events = counter.value if counter else 0
    
    if not logs:
        # If no logs exist yet, capture initial snapshot
        _record_occupancy_change(db, 0)
        logs = db.query(models.OccupancyLog).order_by(models.OccupancyLog.timestamp.asc()).all()
        
    history = [
        {
            "id": l.id,
            "timestamp": l.timestamp,
            "time_str": l.time_str,
            "occupied_seats": l.occupied_seats,
            "total_seats": l.total_seats
        }
        for l in logs
    ]
    
    occupied_vals = [h["occupied_seats"] for h in history]
    max_peak = max(occupied_vals) if occupied_vals else 0
    min_peak = min(occupied_vals) if occupied_vals else 0
    
    return {
        "total_occupied_events": total_occupied_events,
        "max_peak": max_peak,
        "min_peak": min_peak,
        "history": history
    }


@app.post("/stats/reset")
async def reset_stats(db: Session = Depends(get_db)):
    db.query(models.OccupancyLog).delete()
    counter = db.query(models.StatsCounter).filter(models.StatsCounter.key == "total_occupied_events").first()
    if counter:
        counter.value = 0
    db.commit()
    
    # Record initial reset point
    _record_occupancy_change(db, 0)
    
    await manager.broadcast({"type": "STATS_UPDATE"})
    return {"message": "Statistiche azzerate con successo"}

