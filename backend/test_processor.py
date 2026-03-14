import os
import sys
from processor import detect_tables_and_seats

try:
    path = 'C:/Users/maico/Desktop/Assegnazione_tavoli_2/Web app/backend/uploads/map.jpg'
    output = detect_tables_and_seats(path, lambda p, m: print(f"{p}%: {m}"))
    print(f"Success! Detected {len(output)} tables.")
    seats = sum(len(t['seats']) for t in output)
    print(f"Detected {seats} seats across all tables.")
    
    # Check the actual debug image was created
    debug_path = os.path.join(os.path.dirname(path), "debug_" + os.path.basename(path))
    if os.path.exists(debug_path):
        print("Debug map generated successfully at " + debug_path)
        
except Exception as e:
    print(f"Error: {e}")
