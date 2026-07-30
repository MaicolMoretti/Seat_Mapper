import asyncio
import websockets
import httpx
import json
import random
import time
import statistics
import sys
from typing import List, Dict
import psutil
import os

API_BASE = "http://127.0.0.1:8000"
WS_BASE = "ws://127.0.0.1:8000/ws"

class StressTestMonitor:
    def __init__(self):
        self.running = False
        self.latencies = []
        self.errors = 0
        self.ws_messages_received = 0
        self.start_time = 0
        self.cpu_samples = []
        self.mem_samples = []
        self.process = psutil.Process(os.getpid())
        # To monitor the server, we'd theoretically need its PID, but we'll monitor system-wide or this test script process
        # We will assume server is running locally. To get accurate Server CPU, we'd need its PID.
        # For this script, we'll track global CPU to ensure we don't melt the PC, and the script's own footprint.

    async def _monitor_loop(self):
        while self.running:
            self.cpu_samples.append(psutil.cpu_percent(interval=None))
            self.mem_samples.append(psutil.virtual_memory().percent)
            await asyncio.sleep(1)

    def start(self):
        self.running = True
        self.start_time = time.time()
        self.latencies.clear()
        self.errors = 0
        self.ws_messages_received = 0
        self.cpu_samples.clear()
        self.mem_samples.clear()
        psutil.cpu_percent(interval=None) # Prime the CPU check
        asyncio.create_task(self._monitor_loop())

    def stop(self):
        self.running = False
        duration = time.time() - self.start_time
        avg_lat = statistics.mean(self.latencies) if self.latencies else 0
        max_lat = max(self.latencies) if self.latencies else 0
        avg_cpu = statistics.mean(self.cpu_samples) if self.cpu_samples else 0
        avg_mem = statistics.mean(self.mem_samples) if self.mem_samples else 0
        
        return {
            "duration_sec": round(duration, 2),
            "requests_sent": len(self.latencies),
            "errors": self.errors,
            "ws_messages_received": self.ws_messages_received,
            "avg_latency_ms": round(avg_lat * 1000, 2),
            "max_latency_ms": round(max_lat * 1000, 2),
            "throughput_req_sec": round(len(self.latencies) / duration, 2) if duration > 0 else 0,
            "avg_sys_cpu_percent": round(avg_cpu, 2),
            "avg_sys_mem_percent": round(avg_mem, 2)
        }

monitor = StressTestMonitor()

class SimulatedClient:
    def __init__(self, client_id: str):
        self.client_id = client_id
        self.ws = None
        self.running = False
        self.http_client = httpx.AsyncClient(base_url=API_BASE, timeout=10.0)
        self.state = []
        self.valid_seat_ids = []

    async def connect_ws(self):
        try:
            self.ws = await websockets.connect(WS_BASE)
            # Send initial ping or wait for welcome
            response = await self.ws.recv()
            while self.running:
                try:
                    msg_str = await asyncio.wait_for(self.ws.recv(), timeout=5.0)
                    monitor.ws_messages_received += 1
                    msg = json.loads(msg_str)
                    if msg.get("type") == "PING":
                        await self.ws.send(json.dumps({"type": "PONG"}))
                    elif msg.get("type") == "LAYOUT_UPDATE":
                        # We could fetch state here, but to avoid hammering the server on every broadcast
                        # we'll just register the event.
                        pass
                except asyncio.TimeoutError:
                    continue
                except websockets.exceptions.ConnectionClosed:
                    if self.running:
                        # Attempt reconnect
                        await asyncio.sleep(1)
                        self.ws = await websockets.connect(WS_BASE)
        except Exception as e:
            if self.running:
                print(f"[{self.client_id}] WS Error: {e}")

    async def fetch_layout(self):
        t0 = time.time()
        try:
            r = await self.http_client.get("/layout")
            monitor.latencies.append(time.time() - t0)
            if r.status_code == 200:
                self.state = r.json()
                self._extract_seat_ids()
            else:
                monitor.errors += 1
        except Exception as e:
            monitor.latencies.append(time.time() - t0)
            monitor.errors += 1

    def _extract_seat_ids(self):
        self.valid_seat_ids = []
        for t in self.state:
            for s in t["seats"]:
                self.valid_seat_ids.append(s["id"])

    async def toggle_random_seat(self):
        if not self.valid_seat_ids:
            return
        seat_id = random.choice(self.valid_seat_ids)
        t0 = time.time()
        try:
            r = await self.http_client.post(f"/seat/toggle/{seat_id}")
            monitor.latencies.append(time.time() - t0)
            if r.status_code != 200:
                monitor.errors += 1
        except Exception as e:
            monitor.latencies.append(time.time() - t0)
            monitor.errors += 1

    async def start(self):
        self.running = True
        asyncio.create_task(self.connect_ws())
        await self.fetch_layout() # Get initial state

    async def stop(self):
        self.running = False
        if self.ws:
            await self.ws.close()
        await self.http_client.aclose()


# --- Scenarios ---

async def scenario_1_concurrency(num_clients: int, duration: int):
    print(f"\n--- Starting Scenario 1: {num_clients} Concurrent Clients ({duration}s) ---")
    monitor.start()
    clients = [SimulatedClient(f"C{i}") for i in range(num_clients)]
    
    for c in clients:
        await c.start()
        
    await asyncio.sleep(2) # Stabilize connections
    
    end_time = time.time() + duration
    while time.time() < end_time:
        # Every client picks a random sensible delay to simulate human/API interaction
        tasks = []
        for c in clients:
            if random.random() > 0.3: # 70% chance to act this cycle
                tasks.append(c.toggle_random_seat())
        if tasks:
            await asyncio.gather(*tasks)
        await asyncio.sleep(random.uniform(0.5, 2.0))
        
    for c in clients:
        await c.stop()
        
    res = monitor.stop()
    print(json.dumps(res, indent=2))
    return res


async def scenario_2_burst(num_updates: int, rate_per_sec: int):
    print(f"\n--- Starting Scenario 2: Burst Load ({num_updates} updates at {rate_per_sec}/s) ---")
    monitor.start()
    client = SimulatedClient("BurstClient")
    await client.start()
    
    interval = 1.0 / rate_per_sec
    for i in range(num_updates):
        await client.toggle_random_seat()
        await asyncio.sleep(interval)
        
    await asyncio.sleep(2) # Finish processing
    await client.stop()
    res = monitor.stop()
    print(json.dumps(res, indent=2))
    return res

async def scenario_3_network_recovery(num_clients: int, duration: int):
    print(f"\n--- Starting Scenario 3: Network Interruption & Recovery ({num_clients} clients, {duration}s) ---")
    monitor.start()
    clients = [SimulatedClient(f"C{i}") for i in range(num_clients)]
    for c in clients:
        await c.start()
        
    end_time = time.time() + duration
    while time.time() < end_time:
        # Randomly disconnect one client
        unlucky = random.choice(clients)
        if unlucky.ws:
            print(f"[{unlucky.client_id}] Simulating disconnect...")
            await unlucky.ws.close()
            await asyncio.sleep(3) # Stay down for 3 seconds
            
        tasks = []
        for c in clients:
            tasks.append(c.toggle_random_seat())
        await asyncio.gather(*tasks)
        await asyncio.sleep(1)
        
    for c in clients:
        await c.stop()
    res = monitor.stop()
    print(json.dumps(res, indent=2))
    return res

async def scenario_4_stability(num_clients: int, duration_min: int):
    duration_sec = duration_min * 60
    print(f"\n--- Starting Scenario 4: Long-Run Stability ({num_clients} clients, {duration_min} min) ---")
    monitor.start()
    clients = [SimulatedClient(f"C{i}") for i in range(num_clients)]
    for c in clients:
        await c.start()
        
    end_time = time.time() + duration_sec
    last_report = time.time()
    
    while time.time() < end_time:
        tasks = []
        for c in clients:
            if random.random() > 0.5:
                tasks.append(c.toggle_random_seat())
        if tasks:
            await asyncio.gather(*tasks)
            
        if time.time() - last_report > 30:
            elapsed_min = round((time.time() - monitor.start_time) / 60, 1)
            print(f"  ... Stability run in progress: {elapsed_min}/{duration_min} min")
            last_report = time.time()
            
        await asyncio.sleep(random.uniform(1.0, 3.0))
        
    for c in clients:
        await c.stop()
    res = monitor.stop()
    print(json.dumps(res, indent=2))
    return res

async def run_all():
    print("Beginning Stress Test Suite...")
    
    # Pre-flight check
    try:
        async with httpx.AsyncClient() as client:
            await client.get(f"{API_BASE}/layout")
    except Exception as e:
        print(f"FAILED TO CONNECT TO API AT {API_BASE}. Is the server running?")
        return

    # 1. Concurrency ramp-up
    await scenario_1_concurrency(2, 5)
    await scenario_1_concurrency(6, 5)
    
    # 2. Burst load
    await scenario_2_burst(50, 10) # 50 updates at 10/s
    
    # 3. Recovery
    await scenario_3_network_recovery(4, 10)
    
    # 4. Long run (Representative short sample for metrics)
    await scenario_4_stability(4, 1) # 1 minute instead of 10 for report generation

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(run_all())
