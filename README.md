# SeatMapper

A complete web application that manages seat assignments for tables in a public square using a map image. It uses Computer Vision (OpenCV) and Tesseract OCR to automatically detect tables, seats, and table numbers from a JPG map layout.

## Project Structure

```text
project-root/
│
├── backend/
│   ├── main.py              # FastAPI application & API endpoints
│   ├── requirements.txt     # Python dependencies
│   ├── database/"
│   │   ├── database.py      # SQLite connection setup
│   │   └── models.py        # SQLAlchemy ORM models
│   └── vision/
│       └── processor.py     # OpenCV & UI vision logic for detecting map elements
│
├── frontend/
│   ├── index.html           # Main HTML structure
│   └── app.js               # React application (via Babel CDN)
│
├── uploads/                 # Directory where the map image is stored
├── database.db              # SQLite database (auto-created on first run)
└── README.md                # This file
```

## Features

- **Automatic Map Processing**: Detects tables, seats, and numbered markers.
- **Seat Management**: Click on seats in the map to toggle Occupied/Free state.
- **Control Panel**: Add or Remove occupants in bulk per table.
- **Real-Time Statistics**: Live counters of free vs occupied seats.
- **Data Persistence**: Reloads map and states automatically upon restarting backend via SQLite database.

## Architecture

* **Backend**: Python 3, FastAPI, SQLAlchemy (SQLite), OpenCV for contour detection, Pytesseract for number extraction.
* **Frontend**: React 18, TailwindCSS. Uses absolute CDNs for Babel & React to run directly in the browser without node version constraints. served dynamically and statically via FastAPI.

## Prerequisites

1. **Python 3.8+**
2. **Tesseract OCR Engine**
   - You **must** have Tesseract OCR installed on your system.
   - Download for Windows from: [UB-Mannheim Tesseract Installer](https://github.com/UB-Mannheim/tesseract/wiki)
   - If `pytesseract` cannot find `tesseract.exe`, edit `backend/vision/processor.py` and uncomment/update this line:
     `pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'`

## Installation & Running

Follow these steps precisely:

1. **Open a terminal (PowerShell or CMD)** and navigate to the project directory:
   ```bash
   cd "backend"
   ```

2. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```
   *(We recommend using a python virtual environment, `python -m venv venv` beforehand)*

3. **Start the FastAPI server**:
   ```bash
   uvicorn main:app --reload --host localhost --port 8000
   ```

4. **Access the application**:
   Open a browser and navigate to:
   http://localhost:8000/

## Usage Guide
1. **Upload a Map**: Click the "**Upload New Map**" button at the bottom left panel and select your schematic square layout (JPG). Wait about 3-5 seconds for the computer vision processor to find tables and calculate statistics.
2. **Control Bulk Seats**: Type the `table number` in the Control Panel, type an integer amount of seats, and click "Occupy Seats" or "Free Seats".
3. **Direct Map View**: Hover over the seats directly on the map graphic, and click them to toggle individual occupancy (a Red Dot will appear).

## Detection Improvement Tips
If the detector is missing labels or tables:
- **Contrast**: Ensure your text markers are purely black and solid, and your background is white.
- **Size**: Tables should be clear rectangles, and seats should be consistent small squares along the outline. 
- **Modifications**: You can adjust `area` thresholds or `cv2.threshold` values inside `backend/vision/processor.py`.
