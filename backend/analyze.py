import cv2
import numpy as np

img = cv2.imread('C:/Users/maico/Desktop/Assegnazione_tavoli_2/Web app/backend/uploads/map.jpg')
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
binary = cv2.adaptiveThreshold(
    gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv2.THRESH_BINARY_INV, 15, 5
)
kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

contours, hierarchy = cv2.findContours(binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)

tables = {}

for i, cnt in enumerate(contours):
    area = cv2.contourArea(cnt)
    parent_idx = hierarchy[0][i][3]
    
    if parent_idx == -1:
        if area > 3000 and area < img.shape[0]*img.shape[1]*0.4:
            tables[i] = {"contour": cnt, "seats": []}
            
for i, cnt in enumerate(contours):
    area = cv2.contourArea(cnt)
    parent_idx = hierarchy[0][i][3]
    
    if parent_idx != -1 and parent_idx in tables:
        if area > 100:
            tables[parent_idx]["seats"].append(cnt)

print(f"Total tables: {len(tables)}")
total_seats = sum(len(t["seats"]) for t in tables.values())
print(f"Total seats precisely assigned to tables: {total_seats}")

# Print distribution
import collections
seat_counts = collections.Counter([len(t["seats"]) for t in tables.values()])
print(f"Seat counts per table: {dict(seat_counts)}")
