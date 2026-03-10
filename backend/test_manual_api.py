"""
Smoke tests for the manual layout API.
Run AFTER starting the server: uvicorn main:app --reload

Usage:
    cd "c:\\Users\\maico\\Desktop\\Assegnazione_tavoli_2\\Web app\\backend"
    python test_manual_api.py
"""
import requests
import sys

BASE = "http://localhost:8000"

def ok(label):
    print(f"  ✓  {label}")

def fail(label, detail=""):
    print(f"  ✗  {label}: {detail}")
    sys.exit(1)

def test():
    print("\n── GET /layout ─────────────────────────────────────────────────")
    r = requests.get(f"{BASE}/layout")
    assert r.status_code == 200, fail("/layout status", r.status_code)
    layout = r.json()
    ok(f"/layout returned {len(layout)} tables")

    # We need at least one table to run downstream tests; add one manually
    print("\n── POST /manual/add-table ──────────────────────────────────────")
    r = requests.post(f"{BASE}/manual/add-table", json={"x": 50, "y": 50, "w": 100, "h": 80})
    assert r.status_code == 200, fail("add-table", r.text)
    table = r.json()
    table_id = table["id"]
    table_num = table["table_number"]
    ok(f"Added table id={table_id} number={table_num}")

    print("\n── POST /manual/add-seat ───────────────────────────────────────")
    r = requests.post(f"{BASE}/manual/add-seat", json={"x": 100, "y": 90})
    assert r.status_code == 200, fail("add-seat", r.text)
    seat = r.json()
    seat_id = seat["id"]
    ok(f"Added seat id={seat_id} → table {seat['table_id']}")

    print("\n── GET /layout — verify seat present ───────────────────────────")
    r = requests.get(f"{BASE}/layout")
    flat_seats = [s for t in r.json() for s in t["seats"]]
    assert any(s["id"] == seat_id for s in flat_seats), fail("seat not in layout")
    matching_seat = next(s for s in flat_seats if s["id"] == seat_id)
    assert matching_seat["detected_by"] == "manual", fail("detected_by wrong", matching_seat)
    ok(f"Seat visible in /layout with detected_by=manual")

    print("\n── POST /manual/move-seat ──────────────────────────────────────")
    r = requests.post(f"{BASE}/manual/move-seat", json={"seat_id": seat_id, "x": 110, "y": 95})
    assert r.status_code == 200, fail("move-seat", r.text)
    ok("Moved seat to (110, 95)")

    print("\n── POST /manual/update-table-number ────────────────────────────")
    r = requests.post(f"{BASE}/manual/update-table-number",
                      json={"table_id": table_id, "manual_number": 99})
    assert r.status_code == 200, fail("update-table-number", r.text)
    ok("Set table number override → 99")

    print("\n── GET /layout — verify override ───────────────────────────────")
    r = requests.get(f"{BASE}/layout")
    t = next((t for t in r.json() if t["id"] == table_id), None)
    assert t is not None, fail("table not found in layout")
    assert t["table_number"] == 99, fail("override not applied", t)
    assert t["number_overridden"] is True, fail("number_overridden flag wrong", t)
    ok("Override reflected: table_number=99, number_overridden=True")

    print("\n── POST /manual/remove-seat ────────────────────────────────────")
    r = requests.post(f"{BASE}/manual/remove-seat", json={"seat_id": seat_id})
    assert r.status_code == 200, fail("remove-seat", r.text)
    ok(f"Removed seat id={seat_id}")

    print("\n── GET /layout — verify seat gone ──────────────────────────────")
    r = requests.get(f"{BASE}/layout")
    flat_seats = [s for t in r.json() for s in t["seats"]]
    assert not any(s["id"] == seat_id for s in flat_seats), fail("seat still in layout")
    ok("Seat no longer in /layout")

    print("\n── POST /manual/remove-table ───────────────────────────────────")
    r = requests.post(f"{BASE}/manual/remove-table", json={"table_id": table_id})
    assert r.status_code == 200, fail("remove-table", r.text)
    ok(f"Removed table id={table_id}")

    print("\n── GET /layout — verify table gone ─────────────────────────────")
    r = requests.get(f"{BASE}/layout")
    assert not any(t["id"] == table_id for t in r.json()), fail("table still in layout")
    ok("Table no longer in /layout")

    print("\n" + "─" * 60)
    print("  All smoke tests passed ✓")


if __name__ == "__main__":
    test()
