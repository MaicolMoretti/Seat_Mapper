import cv2
import numpy as np
import pytesseract
import math
import os

# Set Tesseract path for Windows
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'


def _preprocess(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 15, 5
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    return gray, binary


def _circularity(area, peri):
    if peri <= 0:
        return 0
    return 4 * math.pi * area / (peri * peri)


def _ocr_circle_number(gray, cx, cy, radius):
    pad = int(radius * 0.4)
    x1 = max(0, cx - radius - pad)
    y1 = max(0, cy - radius - pad)
    x2 = min(gray.shape[1], cx + radius + pad)
    y2 = min(gray.shape[0], cy + radius + pad)
    roi = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return None
    roi_up = cv2.resize(roi, (roi.shape[1] * 3, roi.shape[0] * 3), interpolation=cv2.INTER_CUBIC)
    _, thresh_inv = cv2.threshold(roi_up, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    thresh_norm = 255 - thresh_inv
    for img_variant in [thresh_inv, thresh_norm]:
        for psm in [7, 10]:
            cfg = f'--psm {psm} -c tessedit_char_whitelist=0123456789'
            try:
                txt = pytesseract.image_to_string(img_variant, config=cfg).strip()
                txt = ''.join(c for c in txt if c.isdigit())
                if txt and len(txt) <= 3:
                    val = int(txt)
                    if 1 <= val <= 200:
                        return val
            except Exception:
                pass
    return None


def detect_tables_and_seats(image_path: str, progress_callback=None):
    def _prog(percent, msg):
        if progress_callback:
            progress_callback(percent, msg)

    _prog(5, "Loading image...")
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot open image: {image_path}")

    h_img, w_img = img.shape[:2]
    total_px = h_img * w_img

    _prog(10, "Preprocessing image...")
    gray, binary = _preprocess(img)

    contours, hierarchy = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)

    circle_markers = []
    tables = {}  # Indexed by contour index

    total_contours = len(contours)
    _prog(15, f"Analyzing {total_contours} shapes using hierarchy...")

    # PASS 1: Find tables and circles
    for i, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        if area < 50 or area > total_px * 0.40:
            continue
            
        peri = cv2.arcLength(cnt, True)
        circ = _circularity(area, peri)
        
        # Circles
        if circ > 0.72 and 150 <= area <= 3000:
            x, y, w, h = cv2.boundingRect(cnt)
            if 0.8 <= w / max(h, 1) <= 1.25:
                cx_c, cy_c = x + w // 2, y + h // 2
                radius = max(w, h) // 2
                num = _ocr_circle_number(gray, cx_c, cy_c, radius)
                circle_markers.append({
                    "cx": cx_c, "cy": cy_c,
                    "radius": radius,
                    "number": num
                })
        # Tables (rectangles from 800 to 500,000 px)
        elif 800 <= area <= 500000 and circ < 0.85:
            rect = cv2.minAreaRect(cnt)
            (cx, cy), (rw, rh), angle = rect
            if rw < rh:
                angle = angle - 90
                rw, rh = rh, rw
                
            tables[i] = {
                "bbox": (cx, cy, rw, rh, angle),
                "center": (cx, cy),
                "seats": [],
                "table_id": None
            }

    # PASS 2: Find seats (inner contours)
    for i, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        parent_idx = hierarchy[0][i][3]
        
        # Inner contours that belong to a known table
        if parent_idx != -1 and parent_idx in tables:
            # Seats should be small rectangles, usually 30 to 5000 px
            if 30 <= area <= 5000:
                rect = cv2.minAreaRect(cnt)
                (cx, cy), (rw, rh), angle = rect
                if rw < rh:
                    angle = angle - 90
                    rw, rh = rh, rw
                    
                tables[parent_idx]["seats"].append({
                    "position": (cx, cy),
                    "bbox": (cx, cy, rw, rh, angle),
                    "occupied": False
                })

    # Convert tables dict to list, filter out tables with no seats
    tables_list = [t for t in tables.values() if len(t["seats"]) >= 2]
    
    _prog(70, f"Found {len(tables_list)} tables. De-duplicating seats...")

    # De-duplicate seats inside tables (sometimes two nested inner contours are detected)
    for t in tables_list:
        kept_seats = []
        for s in t["seats"]:
            too_close = any(
                math.hypot(s["position"][0] - k["position"][0], s["position"][1] - k["position"][1]) < 8
                for k in kept_seats
            )
            if not too_close:
                kept_seats.append(s)
        t["seats"] = kept_seats

    _prog(80, "Assigning table IDs from OCR circles...")

    assigned_ids = set()
    for t in tables_list:
        tcx, tcy, tw, th, _ = t["bbox"]
        best_c = None
        best_d = float("inf")
        # Find nearest circle marker
        for c in circle_markers:
            d = math.hypot(tcx - c["cx"], tcy - c["cy"])
            # Threshold: circle must be near the table
            if d < tw * 2.0 and d < best_d:
                best_d = d
                best_c = c
        if best_c and best_c.get("number") is not None:
            t["table_id"] = best_c["number"]

    # Fill IDs for tables that didn't get an OCR match
    counter = 1
    for t in tables_list:
        if t["table_id"] is None or t["table_id"] in assigned_ids:
            while counter in assigned_ids:
                counter += 1
            t["table_id"] = counter
        assigned_ids.add(t["table_id"])

    _prog(90, "Building output...")

    output = []
    for t in tables_list:
        tcx, tcy, tw, th, tangle = t["bbox"]
        seats_out = []
        for idx, s in enumerate(t["seats"]):
            cx, cy = s["position"]
            sw, sh = s["bbox"][2], s["bbox"][3]
            sangle = s["bbox"][4]
            seats_out.append({
                "seat_id": idx + 1,
                "position": [cx, cy],
                "bbox": [cx, cy, sw, sh, sangle],
                "angle": sangle,
                "occupied": False
            })
        output.append({
            "table_id": t["table_id"],
            "contour": {"x": tcx, "y": tcy, "w": tw, "h": th, "angle": tangle},
            "angle": tangle,
            "seats": seats_out
        })

    _prog(95, "Generating debug image...")

    debug_img = img.copy()

    for t in output:
        c = t["contour"]
        cx_i, cy_i = int(c["x"]), int(c["y"])
        
        # Draw table rotated rect
        rect = ((c["x"], c["y"]), (c["w"], c["h"]), c["angle"])
        box = cv2.boxPoints(rect)
        box = np.int32(box)
        cv2.drawContours(debug_img, [box], 0, (255, 0, 0), 2)
        
        cv2.putText(debug_img, f"T{t['table_id']}", (cx_i - 20, cy_i - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 0, 0), 3)
                    
        for s in t["seats"]:
            s_rect = ((s["bbox"][0], s["bbox"][1]), (s["bbox"][2], s["bbox"][3]), s["bbox"][4])
            s_box = cv2.boxPoints(s_rect)
            s_box = np.int32(s_box)
            cv2.drawContours(debug_img, [s_box], 0, (0, 200, 0), 2)
            cv2.circle(debug_img, (int(s["position"][0]), int(s["position"][1])), 4, (0, 0, 255), -1)

    for c in circle_markers:
        cv2.circle(debug_img, (c["cx"], c["cy"]), c["radius"], (255, 0, 255), 2)
        if c.get("number") is not None:
            cv2.putText(debug_img, str(c["number"]), (c["cx"] - 15, c["cy"] + 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 3)

    debug_path = os.path.join(os.path.dirname(image_path), "debug_" + os.path.basename(image_path))
    cv2.imwrite(debug_path, debug_img)

    _prog(100, "Done!")
    return output
