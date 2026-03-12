import cv2
import numpy as np
import pytesseract
import math
import os

# Set Tesseract path for Windows
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'


def _preprocess(img):
    """
    Return a clean binary image (black=foreground on white background).
    Handles the map's white background with dark elements.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Adaptive threshold is dramatically more robust to uneven lighting
    # (e.g. photos taken with a phone) or non-pure white backgrounds.
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv2.THRESH_BINARY_INV, 15, 5
    )
    # Small close to join slightly broken lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    return gray, binary


def _is_rectangular_like(approx, area, ar):
    """
    True if the contour is roughly rectangular.
    We allow up to 10 vertices to account for wavy lines or rounded corners,
    and a wide aspect ratio.
    """
    return len(approx) <= 10 and 0.25 <= ar <= 4.0 and area > 5


def _circularity(area, peri):
    if peri <= 0:
        return 0
    return 4 * math.pi * area / (peri * peri)


def _ocr_circle_number(gray, cx, cy, radius):
    """
    Crop the circle ROI from 'gray', invert so digit is dark on light background
    (original is white digit on black circle), then run Tesseract digit-only OCR.
    Returns an integer or None.
    """
    pad = int(radius * 0.4)
    x1 = max(0, cx - radius - pad)
    y1 = max(0, cy - radius - pad)
    x2 = min(gray.shape[1], cx + radius + pad)
    y2 = min(gray.shape[0], cy + radius + pad)

    roi = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return None

    # Scale up for better OCR accuracy
    roi_up = cv2.resize(roi, (roi.shape[1] * 4, roi.shape[0] * 4), interpolation=cv2.INTER_CUBIC)

    # The circle is black, the digit is white → invert so digit is dark
    _, roi_thresh = cv2.threshold(roi_up, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Tesseract: single character / word, digits only
    for psm in [10, 8, 7, 6]:
        cfg = f'--psm {psm} -c tessedit_char_whitelist=0123456789'
        txt = pytesseract.image_to_string(roi_thresh, config=cfg).strip()
        txt = ''.join(c for c in txt if c.isdigit())
        if txt:
            try:
                return int(txt)
            except ValueError:
                pass
    return None


def detect_tables_and_seats(image_path: str, progress_callback=None):
    """
    Full pipeline:
      1. Pre-process (grayscale + binary)
      2. Find contours with RETR_CCOMP so we can distinguish parent/child shapes
      3. Classify: table rectangles vs seat squares vs circular number markers
      4. OCR the circles to get table IDs
      5. Assign seats to nearest table
      6. Return structured list
    """
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

    # RETR_CCOMP: two-level hierarchy; avoids counting nested shapes twice
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)

    tables = []          # list of dicts
    seat_candidates = [] # list of (cx, cy, w, h) in image coords
    circle_markers = []  # list of dicts {cx, cy, radius, number}

    total_contours = len(contours)
    _prog(15, f"Analyzing {total_contours} shapes...")

    # ── STEP 1: classify contours ──────────────────────────────────────────────
    for i, cnt in enumerate(contours):
        if i % max(1, total_contours // 10) == 0:
            # Scale progress roughly from 15% to 60% during shape classification
            _prog(15 + int((i / total_contours) * 45), f"Classifying shape {i}/{total_contours}...")

        area = cv2.contourArea(cnt)
        if area < 6:
            continue

        peri = cv2.arcLength(cnt, True)
        circ = _circularity(area, peri)
        x, y, w, h = cv2.boundingRect(cnt)
        ar = float(w) / max(h, 1)

        # Exclude map border (occupies most of image)
        if area > total_px * 0.40:
            continue

        # ── Circles: black filled circle with white digit inside ──
        if circ > 0.85 and area > 80:
            cx, cy = x + w // 2, y + h // 2
            radius = max(w, h) // 2
            num = _ocr_circle_number(gray, cx, cy, radius)
            circle_markers.append({
                "cx": cx, "cy": cy,
                "radius": radius,
                "number": num,
                "area": area
            })
            continue

        approx = cv2.approxPolyDP(cnt, 0.035 * peri, True)

        # ── Tables: medium-to-large blocks ──
        # Area greater than 900, up to 35% of image.
        if area > 900 and area < total_px * 0.35:
            # Check if it looks roughly rectangular (not a crazy squiggle)
            if _is_rectangular_like(approx, area, ar):
                # Use minAreaRect to get rotation
                rect = cv2.minAreaRect(cnt)
                (cx, cy), (width, height), angle = rect
                
                # Normalize angle: OpenCV minAreaRect angle can be tricky depending on version
                # We want it to be -45 to 45.
                if width < height:
                    angle = angle - 90
                    width, height = height, width
                
                tables.append({
                    "bbox": (cx, cy, width, height, angle),
                    "center": (cx, cy),
                    "seats": [],
                    "table_id": None
                })
            continue

        # ── Seat candidates: small blocks ──
        # Between 8 and 900 pixels
        if area <= 900 and area >= 8:
            # Very generous aspect ratio for seats, up to 12 vertices (rounded small squares)
            if len(approx) <= 12 and 0.25 <= ar <= 4.0 and circ < 0.85:
                rect = cv2.minAreaRect(cnt)
                (cx, cy), (width, height), angle = rect
                
                if width < height:
                    angle = angle - 90
                    width, height = height, width

                seat_candidates.append({
                    "cx": cx,
                    "cy": cy,
                    "w": width,
                    "h": height,
                    "angle": angle
                })

    _prog(65, "De-duplicating detected shapes...")
    # ── STEP 2: de-duplicate very close seats ─────────────────────────────────
    def dedup(seats, min_dist=8):
        kept = []
        for s in seats:
            too_close = False
            for k in kept:
                if math.hypot(s["cx"] - k["cx"], s["cy"] - k["cy"]) < min_dist:
                    too_close = True
                    break
            if not too_close:
                kept.append(s)
        return kept

    seat_candidates = dedup(seat_candidates)

    _prog(75, "Assigning seats to tables...")
    # ── STEP 3: assign every seat candidate to its nearest table ─────────────
    # No hard distance cutoff — even seats drawn slightly away from the table
    # should still be assigned. We simply pick the closest table.
    def nearest_table(seat, tables):
        """Return the table whose bounding box edge is nearest to the seat centre."""
        best_t = None
        best_d = float('inf')
        sx, sy = seat["cx"], seat["cy"]
        for t in tables:
            # t["bbox"] is (cx, cy, w, h, angle)
            tcx, tcy, tw, th, tangle = t["bbox"]
            
            # Simple point-to-rotated-rect distance is hard; 
            # for assignment, we'll use distance to table center.
            dist = math.hypot(tcx - sx, tcy - sy)
            if dist < best_d:
                best_d = dist
                best_t = t
        return best_t

    for s in seat_candidates:
        # Skip if this seat point is already the centre of a detected table
        is_table = any(
            abs(s["cx"] - t["center"][0]) < 20 and abs(s["cy"] - t["center"][1]) < 20
            for t in tables
        )
        if is_table:
            continue

        t = nearest_table(s, tables)
        if t is not None:
            t["seats"].append({
                "position": (s["cx"], s["cy"]),
                "bbox": (s["cx"], s["cy"], s["w"], s["h"], s["angle"]), # Rotated bbox
                "occupied": False
            })

    _prog(85, "Mapping table IDs from OCR...")
    # ── STEP 4: assign table IDs from nearest circle marker ───────────────────
    assigned_ids = set()

    for t in tables:
        tcx, tcy, tw, th, tangle = t["bbox"]
        best_c = None
        best_d = float('inf')
        for c in circle_markers:
            d = math.hypot(tcx - c["cx"], tcy - c["cy"])
            if d < tw * 1.5 and d < best_d:
                best_d = d
                best_c = c
        if best_c and best_c["number"] is not None:
            t["table_id"] = best_c["number"]

    # Fill in any tables that didn't get an ID from OCR
    counter = 1
    for t in tables:
        if t["table_id"] is None or t["table_id"] in assigned_ids:
            while counter in assigned_ids:
                counter += 1
            t["table_id"] = counter
        assigned_ids.add(t["table_id"])

    _prog(90, "Building map output data...")
    # ── STEP 5: build output ──────────────────────────────────────────────────
    output = []
    for t in tables:
        seats_out = []
        for idx, s in enumerate(t["seats"]):
            cx, cy, sw, sh, sangle = s["bbox"]
            seats_out.append({
                "seat_id": idx + 1,
                "position": [cx, cy],
                "bbox": [cx, cy, sw, sh, sangle],
                "angle": sangle,
                "occupied": False
            })
        tcx, tcy, tw, th, tangle = t["bbox"]
        output.append({
            "table_id": t["table_id"],
            "contour": {
                "x": tcx,
                "y": tcy,
                "w": tw,
                "h": th,
                "angle": tangle
            },
            "angle": tangle,
            "seats": seats_out
        })

    _prog(95, "Generating visual debug map...")
    # ── STEP 6: generate a debug image for the user ──────────────────────────
    debug_img = img.copy()
    
    # Draw ALL contours faintly to see what the adaptive threshold found
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if 50 < area < total_px * 0.40:
            cv2.drawContours(debug_img, [cnt], -1, (200, 200, 255), 1)

    # Draw all tables in blue
    for t in tables:
        # t["bbox"] is (cx, cy, w, h, angle)
        rect = ((t["bbox"][0], t["bbox"][1]), (t["bbox"][2], t["bbox"][3]), t["bbox"][4])
        box = cv2.boxPoints(rect)
        box = np.int32(box)
        cv2.drawContours(debug_img, [box], 0, (255, 0, 0), 2)
        cv2.putText(debug_img, f"T{t['table_id']}", (int(t["bbox"][0]), int(t["bbox"][1])), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)
        
        # Draw all seats in green
        for s in t["seats"]:
            # s["bbox"] is (cx, cy, w, h, angle)
            s_rect = ((s["bbox"][0], s["bbox"][1]), (s["bbox"][2], s["bbox"][3]), s["bbox"][4])
            s_box = cv2.boxPoints(s_rect)
            s_box = np.int32(s_box)
            cv2.drawContours(debug_img, [s_box], 0, (0, 255, 0), 2)
            cv2.circle(debug_img, (int(s["bbox"][0]), int(s["bbox"][1])), 3, (0, 0, 255), -1)
            
    # Draw circle markers in magenta
    for c in circle_markers:
        cv2.circle(debug_img, (c["cx"], c["cy"]), c["radius"], (255, 0, 255), 2)
        if c.get("number") is not None:
            cv2.putText(debug_img, str(c["number"]), (c["cx"]-10, c["cy"]+5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)
    
    debug_path = os.path.join(os.path.dirname(image_path), "debug_" + os.path.basename(image_path))
    cv2.imwrite(debug_path, debug_img)

    _prog(100, "Done!")
    return output
