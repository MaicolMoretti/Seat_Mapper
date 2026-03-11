import asyncio
import websockets
import json
import requests
import time

# Configuration
BASE_URL = "http://localhost:8000"
WS_URL = "ws://localhost:8000/ws"

async def test_sync():
    print("Testing WebSocket synchronization...")
    
    # Connect
    async with websockets.connect(WS_URL) as ws:
        print("Connected to WebSocket.")
        
        async def recv_msg():
            while True:
                m = await asyncio.wait_for(ws.recv(), timeout=5)
                d = json.loads(m)
                if d["type"] == "PING":
                    continue
                return d

        # Check welcome message
        welcome = await ws.recv() # Welcome is usually first
        print(f"Received welcome: {welcome}")
        
        layout_res = requests.get(f"{BASE_URL}/layout")
        layout = layout_res.json()
        if not layout:
            print("Error: No layout found.")
            return

        seat_id = layout[0]["seats"][0]["id"]
        print(f"Triggering toggle on seat {seat_id}...")
        requests.post(f"{BASE_URL}/seat/toggle/{seat_id}")
        
        # Wait for broadcast updates (LAYOUT and STATS)
        updates = []
        for _ in range(2):
            updates.append(await recv_msg())
        
        print(f"Received updates: {[u['type'] for u in updates]}")
        types = {u["type"] for u in updates}
        if "LAYOUT_UPDATE" in types and "STATS_UPDATE" in types:
            print("SUCCESS: Real-time sync verified!")
        else:
            print("FAILURE: Sync updates incomplete.")
            return

        # Test Undo
        print("Triggering Undo...")
        requests.post(f"{BASE_URL}/manual/undo", headers={"X-Client-Type": "desktop"})
        
        undo_update = await recv_msg()
        print(f"Received undo update: {undo_update}")
        if undo_update["type"] == "LAYOUT_UPDATE":
            print("SUCCESS: Undo synchronization verified!")
        else:
            print("FAILURE: Undo update not received.")

if __name__ == "__main__":
    print("Note: Ensure the server is running on localhost:8000 before starting this test.")
    try:
        asyncio.run(test_sync())
    except Exception as e:
        print(f"Error during test: {e}")
