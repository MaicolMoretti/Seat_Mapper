"""
Manual layout editor endpoints.

All mutations stamp detected_by = "manual" on the affected rows and use
optimistic nearest-table assignment for seats added without a table_id.
"""
import math
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

import json
import time
from database import models, database

router = APIRouter(prefix="/manual", tags=["manual"])

def _log_action(db: Session, action_type: str, target_id: int, old_state: dict):
    log = models.ActionLog(
        action_type=action_type,
        target_id=target_id,
        old_state=json.dumps(old_state),
        timestamp=time.time()
    )
    db.add(log)
    db.commit() # Ensure log is persisted


from dependencies import get_db, require_desktop
from ws_manager import broadcast_layout_update


# ─── Pydantic schemas ─────────────────────────────────────────────────────────
class AddSeatRequest(BaseModel):
    x: int
    y: int
    angle: Optional[float] = 0.0
    table_id: Optional[int] = None   # if omitted, nearest table is used


class RemoveSeatRequest(BaseModel):
    seat_id: int


class MoveSeatRequest(BaseModel):
    seat_id: int
    x: int
    y: int


class AddTableRequest(BaseModel):
    x: int
    y: int
    w: int
    h: int
    angle: Optional[float] = 0.0


class RemoveTableRequest(BaseModel):
    table_id: int


class UpdateTableNumberRequest(BaseModel):
    table_id: int
    manual_number: int


# ─── Helpers ──────────────────────────────────────────────────────────────────
def _nearest_table(db: Session, x: int, y: int) -> Optional[models.Table]:
    """Return the Table whose bounding box is nearest to (x, y)."""
    tables = db.query(models.Table).all()
    best = None
    best_d = float("inf")
    for t in tables:
        tx, ty, tw, th = t.contour_x, t.contour_y, t.contour_w, t.contour_h
        dx = max(tx - x, 0, x - (tx + tw))
        dy = max(ty - y, 0, y - (ty + th))
        d = math.hypot(dx, dy)
        if d < best_d:
            best_d = d
            best = t
    return best


def _next_seat_number(db: Session, table_id: int) -> int:
    seats = db.query(models.Seat).filter(models.Seat.table_id == table_id).all()
    used = {s.seat_number for s in seats if s.seat_number is not None}
    n = 1
    while n in used:
        n += 1
    return n


# ─── Seat endpoints ───────────────────────────────────────────────────────────
@router.post("/add-seat", dependencies=[Depends(require_desktop)])
async def add_seat(req: AddSeatRequest, db: Session = Depends(get_db)):
    if req.table_id is not None:
        table = db.query(models.Table).filter(models.Table.id == req.table_id).first()
        if not table:
            raise HTTPException(status_code=404, detail="Table not found")
    else:
        table = _nearest_table(db, req.x, req.y)
        if not table:
            raise HTTPException(status_code=404, detail="No tables exist — add a table first")

    seat = models.Seat(
        table_id=table.id,
        seat_number=_next_seat_number(db, table.id),
        position_x=req.x,
        position_y=req.y,
        angle=req.angle or 0.0,
        occupied=False,
        detected_by="manual",
    )
    db.add(seat)
    db.commit()
    db.refresh(seat)
    
    _log_action(db, "ADD_SEAT", seat.id, {})
    db.commit()
    
    await broadcast_layout_update()
    return {"id": seat.id, "table_id": table.id, "x": seat.position_x, "y": seat.position_y}


@router.post("/remove-seat")
async def remove_seat(req: RemoveSeatRequest, db: Session = Depends(get_db)):
    seat = db.query(models.Seat).filter(models.Seat.id == req.seat_id).first()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
    
    _log_action(db, "REMOVE_SEAT", seat.id, {
        "table_id": seat.table_id,
        "seat_number": seat.seat_number,
        "x": seat.position_x,
        "y": seat.position_y,
        "occupied": seat.occupied,
        "detected_by": seat.detected_by
    })
    db.delete(seat)
    db.commit()
    await broadcast_layout_update()
    return {"deleted": req.seat_id}


@router.post("/move-seat", dependencies=[Depends(require_desktop)])
async def move_seat(req: MoveSeatRequest, db: Session = Depends(get_db)):
    seat = db.query(models.Seat).filter(models.Seat.id == req.seat_id).first()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
        
    _log_action(db, "MOVE_SEAT", seat.id, {
        "x": seat.position_x,
        "y": seat.position_y
    })
    seat.position_x = req.x
    seat.position_y = req.y
    seat.detected_by = "manual"
    db.commit()
    await broadcast_layout_update()
    return {"id": seat.id, "x": seat.position_x, "y": seat.position_y}


# ─── Table endpoints ──────────────────────────────────────────────────────────
@router.post("/add-table", dependencies=[Depends(require_desktop)])
async def add_table(req: AddTableRequest, db: Session = Depends(get_db)):
    # Resolve map_id from the existing MapImage (always uses the single one)
    map_img = db.query(models.MapImage).first()
    map_id = map_img.id if map_img else None

    # Auto-assign a unique table number
    existing_numbers = {t.table_number for t in db.query(models.Table).all()}
    # also account for overrides
    overrides = {o.table_id: o.manual_number for o in db.query(models.TableNumberOverride).all()}
    for tid, mn in overrides.items():
        existing_numbers.add(mn)

    n = 1
    while n in existing_numbers:
        n += 1

    table = models.Table(
        map_id=map_id,
        table_number=n,
        contour_x=req.x,
        contour_y=req.y,
        contour_w=req.w,
        contour_h=req.h,
        angle=req.angle or 0.0,
        detected_by="manual",
    )
    db.add(table)
    db.commit()
    db.refresh(table)
    await broadcast_layout_update()
    return {
        "id": table.id,
        "table_number": table.table_number,
        "contour": {"x": req.x, "y": req.y, "w": req.w, "h": req.h, "angle": table.angle},
        "detected_by": "manual",
    }


@router.post("/remove-table", dependencies=[Depends(require_desktop)])
async def remove_table(req: RemoveTableRequest, db: Session = Depends(get_db)):
    table = db.query(models.Table).filter(models.Table.id == req.table_id).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    db.delete(table)    # cascade deletes seats + override
    db.commit()
    await broadcast_layout_update()
    return {"deleted": req.table_id}


# ─── Table-number override endpoint ──────────────────────────────────────────
@router.post("/update-table-number", dependencies=[Depends(require_desktop)])
async def update_table_number(req: UpdateTableNumberRequest, db: Session = Depends(get_db)):
    table = db.query(models.Table).filter(models.Table.id == req.table_id).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    override = (
        db.query(models.TableNumberOverride)
        .filter(models.TableNumberOverride.table_id == req.table_id)
        .first()
    )
    if override:
        override.manual_number = req.manual_number
    else:
        override = models.TableNumberOverride(
            table_id=req.table_id,
            manual_number=req.manual_number,
        )
        db.add(override)
    db.commit()
    await broadcast_layout_update()
    return {"table_id": req.table_id, "manual_number": req.manual_number}

@router.post("/undo", dependencies=[Depends(require_desktop)])
async def undo(db: Session = Depends(get_db)):
    last_log = db.query(models.ActionLog).order_by(models.ActionLog.id.desc()).first()
    if not last_log:
        raise HTTPException(status_code=400, detail="Nothing to undo")
    
    state = json.loads(last_log.old_state)
    try:
        if last_log.action_type == "ADD_SEAT":
            seat = db.query(models.Seat).filter(models.Seat.id == last_log.target_id).first()
            if seat:
                db.delete(seat)
        
        elif last_log.action_type == "REMOVE_SEAT":
            seat = models.Seat(
                table_id=state["table_id"],
                seat_number=state["seat_number"],
                position_x=state["x"],
                position_y=state["y"],
                occupied=state["occupied"],
                detected_by=state["detected_by"]
            )
            db.add(seat)
            
        elif last_log.action_type == "MOVE_SEAT":
            seat = db.query(models.Seat).filter(models.Seat.id == last_log.target_id).first()
            if seat:
                seat.position_x = state["x"]
                seat.position_y = state["y"]
        
        elif last_log.action_type == "TOGGLE_OCCUPANCY":
            seat = db.query(models.Seat).filter(models.Seat.id == last_log.target_id).first()
            if seat:
                seat.occupied = state["occupied"]
        
        # Add cases for tables if needed later...
        
        db.delete(last_log)
        db.commit()
        await broadcast_layout_update()
        return {"message": "Undo successful", "action": last_log.action_type}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Undo failed: {str(e)}")
