from database.database import SessionLocal, engine
from database import models
import json

# Ensure tables are created
models.Base.metadata.create_all(bind=engine)

db = SessionLocal()
logs = db.query(models.ActionLog).all()
print(f"Total logs: {len(logs)}")
for log in logs:
    print(f"ID: {log.id}, Type: {log.action_type}, Target: {log.target_id}")
db.close()
