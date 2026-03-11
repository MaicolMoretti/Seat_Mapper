from typing import Optional
from fastapi import Header, HTTPException, Depends
from database import database

def get_db():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_client_type(x_client_type: Optional[str] = Header(None)):
    """
    Returns 'desktop' or 'mobile' based on header.
    Defaults to 'desktop' if omitted.
    """
    if x_client_type == "mobile":
        return "mobile"
    return "desktop"

def require_desktop(client_type: str = Depends(get_client_type)):
    if client_type == "mobile":
        raise HTTPException(
            status_code=403, 
            detail="Action not allowed on mobile devices (Desktop required)"
        )
