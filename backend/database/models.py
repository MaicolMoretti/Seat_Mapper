from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Float
from sqlalchemy.orm import relationship
from .database import Base

class MapImage(Base):
    __tablename__ = "map_images"
    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, index=True)
    filepath = Column(String)

class Table(Base):
    __tablename__ = "tables"
    id = Column(Integer, primary_key=True, index=True)
    map_id = Column(Integer, ForeignKey("map_images.id"))
    table_number = Column(Integer, index=True)
    
    # Bounding box for the table contour
    contour_x = Column(Integer)
    contour_y = Column(Integer)
    contour_w = Column(Integer)
    contour_h = Column(Integer)

    # "auto" = detected by vision pipeline, "manual" = added by user
    detected_by = Column(String, default="auto")
    
    seats = relationship("Seat", back_populates="table", cascade="all, delete-orphan")
    number_override = relationship(
        "TableNumberOverride",
        back_populates="table",
        uselist=False,
        cascade="all, delete-orphan"
    )

class Seat(Base):
    __tablename__ = "seats"
    id = Column(Integer, primary_key=True, index=True)
    table_id = Column(Integer, ForeignKey("tables.id"))
    seat_number = Column(Integer)  # Local ID for the seat
    
    # Position of the seat (centre point)
    position_x = Column(Integer)
    position_y = Column(Integer)
    
    occupied = Column(Boolean, default=False)

    # "auto" = detected by vision pipeline, "manual" = added by user
    detected_by = Column(String, default="auto")
    
    table = relationship("Table", back_populates="seats")

class TableNumberOverride(Base):
    """Stores a user-supplied table number that permanently overrides OCR output."""
    __tablename__ = "table_number_overrides"
    id = Column(Integer, primary_key=True, index=True)
    table_id = Column(Integer, ForeignKey("tables.id"), unique=True)
    manual_number = Column(Integer, nullable=False)

    table = relationship("Table", back_populates="number_override")

class ActionLog(Base):
    """Stores actions for Undo functionality."""
    __tablename__ = "action_logs"
    id = Column(Integer, primary_key=True, index=True)
    action_type = Column(String)  # e.g., "TOGGLE_SEAT", "ADD_SEAT", etc.
    target_id = Column(Integer)   # e.g., seat_id or table_id
    old_state = Column(String)    # JSON string of the state before action
    timestamp = Column(Float)
