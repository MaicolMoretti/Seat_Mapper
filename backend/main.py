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

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    def _columns(table: str):
        cur.execute(f"PRAGMA table_info({table})")
        return {row[1] for row in cur.fetchall()}

    # tables: add detected_by
    if "detected_by" not in _columns("tables"):
        cur.execute("ALTER TABLE tables ADD COLUMN detected_by TEXT DEFAULT 'auto'")

    # seats: add detected_by
    if "detected_by" not in _columns("seats"):
        cur.execute("ALTER TABLE seats ADD COLUMN detected_by TEXT DEFAULT 'auto'")

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
    db = database.SessionLocal()
    try:
        def update_progress(percent, msg):
            progress_store[task_id] = {
                "progress": percent, "message": msg, "done": False, "error": False
            }

        # Clear previous data
        db.query(models.TableNumberOverride).delete()
        db.query(models.Seat).delete()
        db.query(models.Table).delete()
        db.query(models.MapImage).delete()
        db.commit()

        map_img = models.MapImage(filename="map.jpg", filepath=filepath)
        db.add(map_img)
        db.flush()

        tables_data = processor.detect_tables_and_seats(
            filepath, progress_callback=update_progress
        )

        for t_data in tables_data:
            table = models.Table(
                map_id=map_img.id,
                table_number=t_data["table_id"],
                contour_x=t_data["contour"]["x"],
                contour_y=t_data["contour"]["y"],
                contour_w=t_data["contour"]["w"],
                contour_h=t_data["contour"]["h"],
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
                    occupied=s_data["occupied"],
                    detected_by="auto",      # ← stamped by pipeline
                )
                db.add(seat)

        db.commit()
        progress_store[task_id] = {
            "progress": 100, "message": "Done!", "done": True, "error": False
        }
        # Notify clients about the new map
        asyncio.run_coroutine_threadsafe(broadcast_layout_update(), asyncio.get_event_loop())
    except Exception as e:
        progress_store[task_id] = {
            "progress": 100, "message": f"Error: {str(e)}", "done": True, "error": True
        }
    finally:
        db.close()


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
            },
            "detected_by": t.detected_by or "auto",
            "seats": [
                {
                    "id": s.id,
                    "position": [s.position_x, s.position_y],
                    "occupied": s.occupied,
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


@app.post("/seat/toggle/{seat_id}")
async def toggle_seat(seat_id: int, db: Session = Depends(get_db)):
    seat = db.query(models.Seat).filter(models.Seat.id == seat_id).first()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
    
    # Log for undo
    manual_router._log_action(db, "TOGGLE_OCCUPANCY", seat.id, {"occupied": seat.occupied})
    
    seat.occupied = not seat.occupied
    db.commit()
    await broadcast_layout_update()
    return {"id": seat.id, "occupied": seat.occupied}


@app.post("/table/{table_number}/add-seats")
async def add_seats(table_number: int, amount: int = Form(...), db: Session = Depends(get_db)):
    table = db.query(models.Table).filter(models.Table.table_number == table_number).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    free_seats = (
        db.query(models.Seat)
        .filter(models.Seat.table_id == table.id, models.Seat.occupied == False)
        .limit(amount)
        .all()
    )
    for seat in free_seats:
        seat.occupied = True
    db.commit()
    await broadcast_layout_update()
    return {"message": f"Added {len(free_seats)} seats (marked as occupied)"}


@app.post("/table/{table_number}/remove-seats")
async def remove_seats(table_number: int, amount: int = Form(...), db: Session = Depends(get_db)):
    table = db.query(models.Table).filter(models.Table.table_number == table_number).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    occupied_seats = (
        db.query(models.Seat)
        .filter(models.Seat.table_id == table.id, models.Seat.occupied == True)
        .limit(amount)
        .all()
    )
    for seat in occupied_seats:
        seat.occupied = False
    db.commit()
    await broadcast_layout_update()
    return {"message": f"Removed {len(occupied_seats)} seats (marked as free)"}


@app.get("/stats")
def get_stats(db: Session = Depends(get_db)):
    num_tables = db.query(models.Table).count()
    total_seats = db.query(models.Seat).count()
    occupied_seats = db.query(models.Seat).filter(models.Seat.occupied == True).count()
    free_seats = total_seats - occupied_seats
    return {
        "num_tables": num_tables,
        "total_seats": total_seats,
        "occupied_seats": occupied_seats,
        "free_seats": free_seats,
    }
