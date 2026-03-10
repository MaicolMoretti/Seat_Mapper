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

from database import models, database

router = APIRouter(prefix="/manual", tags=["manual"])


# ─── DB dependency ────────────────────────────────────────────────────────────
def get_db():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── Pydantic schemas ─────────────────────────────────────────────────────────
class AddSeatRequest(BaseModel):
    x: int
    y: int
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
@router.post("/add-seat")
def add_seat(req: AddSeatRequest, db: Session = Depends(get_db)):
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
        occupied=False,
        detected_by="manual",
    )
    db.add(seat)
    db.commit()
    db.refresh(seat)
    return {"id": seat.id, "table_id": table.id, "x": seat.position_x, "y": seat.position_y}


@router.post("/remove-seat")
def remove_seat(req: RemoveSeatRequest, db: Session = Depends(get_db)):
    seat = db.query(models.Seat).filter(models.Seat.id == req.seat_id).first()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
    db.delete(seat)
    db.commit()
    return {"deleted": req.seat_id}


@router.post("/move-seat")
def move_seat(req: MoveSeatRequest, db: Session = Depends(get_db)):
    seat = db.query(models.Seat).filter(models.Seat.id == req.seat_id).first()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
    seat.position_x = req.x
    seat.position_y = req.y
    seat.detected_by = "manual"
    db.commit()
    return {"id": seat.id, "x": seat.position_x, "y": seat.position_y}


# ─── Table endpoints ──────────────────────────────────────────────────────────
@router.post("/add-table")
def add_table(req: AddTableRequest, db: Session = Depends(get_db)):
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
        detected_by="manual",
    )
    db.add(table)
    db.commit()
    db.refresh(table)
    return {
        "id": table.id,
        "table_number": table.table_number,
        "contour": {"x": req.x, "y": req.y, "w": req.w, "h": req.h},
        "detected_by": "manual",
    }


@router.post("/remove-table")
def remove_table(req: RemoveTableRequest, db: Session = Depends(get_db)):
    table = db.query(models.Table).filter(models.Table.id == req.table_id).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    db.delete(table)    # cascade deletes seats + override
    db.commit()
    return {"deleted": req.table_id}


# ─── Table-number override endpoint ──────────────────────────────────────────
@router.post("/update-table-number")
def update_table_number(req: UpdateTableNumberRequest, db: Session = Depends(get_db)):
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
    return {"table_id": req.table_id, "manual_number": req.manual_number}
