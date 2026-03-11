from typing import List
from fastapi import WebSocket

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        # Create a copy of the list to avoid issues when removing items during iteration
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception as e:
                print(f"Broadcast error for a connection: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

async def broadcast_layout_update():
    """Helper to notify all clients to refresh layout/stats."""
    await manager.broadcast({"type": "LAYOUT_UPDATE"})
    await manager.broadcast({"type": "STATS_UPDATE"})
