const { useState, useEffect, useRef, useCallback } = React;

// ─── Constants ──────────────────────────────────────────────────────────────
const API_BASE = window.location.origin; // Dynamically resolve for local network / ngrok
const WS_BASE = window.location.origin.replace(/^http/, 'ws');
const SEAT_HIT_RADIUS = 24;        // px in image space for click detection
const OCCUPIED_COLOR = '#ef4444'; // red-500
const AUTO_COLOR = '#22c55e'; // green-500  — auto-detected
const MANUAL_COLOR = '#3b82f6'; // blue-500   — manually added/edited
const OVERRIDE_COLOR = '#f59e0b'; // amber-500  — number overridden
const TABLE_AREA_ALPHA = 0.08;     // fill opacity for table rect

// ─── Tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
    { id: 'addSeat', label: '+ Aggiungi posto', icon: '🪑', hint: 'Click on the map to place a new seat' },
    { id: 'removeSeat', label: '✕ Rimuovi posto', icon: '❌', hint: 'Click an existing seat to delete it' },
    { id: 'addTable', label: '+ Aggiungi tavolo', icon: '⬜', hint: 'Drag to draw a new table region' },
    { id: 'removeTable', label: '✕ Rimuovi tavolo', icon: '🗑', hint: 'Click inside a table to delete it' },
    { id: 'editNumber', label: '✎ Modifica numero', icon: '🔢', hint: 'Click a table label to rename it' },
];

// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
    const [mapData, setMapData] = useState(null);
    const [tables, setTables] = useState([]);
    const [stats, setStats] = useState({ num_tables: 0, total_seats: 0, occupied_seats: 0, free_seats: 0 });

    // Device detection & Permissions
    const [clientType, setClientType] = useState('desktop');
    useEffect(() => {
        const checkDevice = () => {
            const mobile = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);
            setClientType(mobile ? 'mobile' : 'desktop');
        };
        checkDevice();
        window.addEventListener('resize', checkDevice);
        return () => window.removeEventListener('resize', checkDevice);
    }, []);

    const isMobile = clientType === 'mobile';

    // Upload & Progress
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [message, setMessage] = useState('');

    // Control panel
    const [selTable, setSelTable] = useState('');
    const [seatsAmount, setSeatsAmount] = useState('');

    // Edit mode
    const [editMode, setEditMode] = useState(false);
    const [activeTool, setActiveTool] = useState(null);

    // Inline number editing
    const [editingTableId, setEditingTableId] = useState(null);
    const [editNumberValue, setEditNumberValue] = useState('');

    // Viewport state
    const [scale, setScale] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const isPanning = useRef(false);
    const lastMouse = useRef({ x: 0, y: 0 });
    const touchStartDist = useRef(null);
    const touchStartScale = useRef(1);
    const lastTouch = useRef({ x: 0, y: 0 });
    const hasDragged = useRef(false);

    // Add-table draw state
    const drawStart = useRef(null);   // { imgX, imgY } when mouse down
    const drawRect = useRef(null);   // { x, y, w, h } current preview

    const canvasRef = useRef(null);
    const imgRef = useRef(null);
    const tablesRef = useRef([]);
    const activeToolRef = useRef(null);
    const editModeRef = useRef(false);

    useEffect(() => { tablesRef.current = tables; }, [tables]);
    useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
    useEffect(() => { editModeRef.current = editMode; }, [editMode]);

    // ─── Data loading ───────────────────────────────────────────────────
    const fetchTables = useCallback(async () => {
        const r = await fetch(`${API_BASE}/layout`);
        setTables(await r.json());
    }, []);

    const fetchStats = useCallback(async () => {
        const r = await fetch(`${API_BASE}/stats`);
        setStats(await r.json());
    }, []);

    const fetchAll = useCallback(async () => {
        try {
            const [mr, tr, sr] = await Promise.all([
                fetch(`${API_BASE}/map`),
                fetch(`${API_BASE}/layout`),
                fetch(`${API_BASE}/stats`),
            ]);
            const mapJson = await mr.json();
            const tabJson = await tr.json();
            const statJson = await sr.json();
            if (mapJson.url) setMapData(mapJson);
            setTables(tabJson);
            setStats(statJson);
        } catch (e) { console.error('fetchAll', e); }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── WebSocket Sync ─────────────────────────────────────────────────
    useEffect(() => {
        let ws;
        let reconnectTimer;
        const connect = () => {
            console.log('Connecting to WebSocket...');
            ws = new WebSocket(`${WS_BASE}/ws`);
            ws.onopen = () => {
                console.log('WebSocket Connected');
                fetchAll(); // Resync state immediately upon connection
            };
            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (data.type === 'LAYOUT_UPDATE') fetchTables();
                if (data.type === 'STATS_UPDATE') fetchStats();
                if (data.type === 'PING') ws.send(JSON.stringify({ type: 'PONG' }));
            };
            ws.onclose = () => {
                console.log('WebSocket Disconnected, reconnecting...');
                reconnectTimer = setTimeout(connect, 3000);
            };
            ws.onerror = (err) => {
                console.error('WebSocket Error:', err);
                ws.close();
            };
        };
        connect();
        return () => {
            if (ws) ws.close();
            clearTimeout(reconnectTimer);
        };
    }, []); // Only once on mount

    // ─── Upload ─────────────────────────────────────────────────────────
    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setUploading(true);
        setUploadProgress(0);
        setMessage('Uploading map...');
        const fd = new FormData();
        fd.append('file', file);
        try {
            const res = await fetch(`${API_BASE}/upload-map`, { method: 'POST', body: fd });
            if (!res.ok) throw new Error(await res.text());
            const { task_id } = await res.json();
            const evtSource = new EventSource(`${API_BASE}/upload-progress/${task_id}`);
            evtSource.onmessage = (event) => {
                try {
                    const state = JSON.parse(event.data);
                    setUploadProgress(state.progress);
                    setMessage(state.message);
                    if (state.done) {
                        evtSource.close();
                        if (!state.error) {
                            fetchAll();
                            setTimeout(() => { setUploading(false); setMessage(''); }, 1000);
                        } else { setUploading(false); }
                    }
                } catch (parseErr) { console.error('SSE parse error', parseErr); }
            };
            evtSource.onerror = () => { evtSource.close(); setUploading(false); setMessage('Lost connection.'); };
        } catch (err) {
            setMessage('Upload failed: ' + err.message);
            setUploading(false);
        } finally { e.target.value = ''; }
    };

    // ─── Seat toggle ────────────────────────────────────────────────────
    const toggleSeat = useCallback(async (seatId) => {
        setTables(prev => prev.map(t => ({
            ...t,
            seats: t.seats.map(s => s.id === seatId ? { ...s, occupied: !s.occupied } : s)
        })));
        try {
            await fetch(`${API_BASE}/seat/toggle/${seatId}`, { method: 'POST' });
            fetchStats();
        } catch (e) { console.error('Toggle error', e); fetchTables(); }
    }, [fetchStats, fetchTables]);

    // ─── Canvas helpers ──────────────────────────────────────────────────
    const getScales = useCallback(() => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img || img.naturalWidth === 0) return null;
        const rect = img.getBoundingClientRect();
        return {
            scaleX: rect.width / img.naturalWidth,
            scaleY: rect.height / img.naturalHeight,
            rect,
        };
    }, []);

    const canvasToImg = useCallback((cx, cy) => {
        const s = getScales();
        if (!s) return null;
        return {
            imgX: cx / s.scaleX,
            imgY: cy / s.scaleY,
        };
    }, [getScales]);

    // ─── Canvas drawing ──────────────────────────────────────────────────
    const drawCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img || !img.complete || img.naturalWidth === 0) return;

        const rect = img.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        const scaleX = rect.width / img.naturalWidth;
        const scaleY = rect.height / img.naturalHeight;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (const table of tablesRef.current) {
            const { x, y, w, h, angle } = table.contour;
            const isManual = table.detected_by === 'manual';
            const isOverride = table.number_overridden;
            const tableColor = isManual ? MANUAL_COLOR : AUTO_COLOR;

            ctx.save();
            ctx.translate(x * scaleX, y * scaleY);
            ctx.rotate((angle * Math.PI) / 180);

            // Table bounding box fill
            ctx.fillStyle = isManual
                ? 'rgba(59,130,246,0.06)'
                : 'rgba(34,197,94,0.06)';
            ctx.fillRect(- (w * scaleX) / 2, - (h * scaleY) / 2, w * scaleX, h * scaleY);

            // Table bounding box stroke
            ctx.strokeStyle = tableColor;
            ctx.lineWidth = isManual ? 2.5 : 1.5;
            ctx.setLineDash(isManual ? [6, 3] : []);
            ctx.strokeRect(- (w * scaleX) / 2, - (h * scaleY) / 2, w * scaleX, h * scaleY);
            ctx.restore();

            // Table label
            const fontSize = Math.max(11, 13 * scaleX);
            const labelText = `T${table.table_number}${isOverride ? ' ✎' : ''}`;
            ctx.save();
            ctx.translate(x * scaleX, y * scaleY);
            ctx.font = `bold ${fontSize}px Inter, sans-serif`;
            const tw2 = ctx.measureText(labelText).width;
            ctx.fillStyle = isManual ? MANUAL_COLOR : (isOverride ? OVERRIDE_COLOR : AUTO_COLOR);
            ctx.fillText(labelText, -tw2/2, -(h * scaleY)/2 - 6);
            ctx.restore();

            // Seats
            for (const seat of table.seats) {
                const [sx, sy] = seat.position;
                const sAngle = seat.angle || 0;
                const px = sx * scaleX;
                const py = sy * scaleY;
                const half = Math.max(5, 7 * Math.min(scaleX, scaleY));
                const seatColor = seat.detected_by === 'manual' ? MANUAL_COLOR : AUTO_COLOR;

                ctx.save();
                ctx.translate(px, py);
                ctx.rotate((sAngle * Math.PI) / 180);

                ctx.strokeStyle = seatColor;
                ctx.lineWidth = seat.detected_by === 'manual' ? 2.5 : 1.5;
                ctx.setLineDash(seat.detected_by === 'manual' ? [4, 2] : []);
                ctx.strokeRect(-half, -half, half * 2, half * 2);
                ctx.setLineDash([]);

                if (seat.occupied) {
                    ctx.fillStyle = OCCUPIED_COLOR;
                    ctx.beginPath();
                    ctx.arc(0, 0, half * 0.65, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }

        // Draw add-table preview rect
        if (drawRect.current) {
            const { x, y, w, h } = drawRect.current;
            ctx.save();
            ctx.strokeStyle = MANUAL_COLOR;
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 4]);
            ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
            ctx.fillStyle = 'rgba(59,130,246,0.1)';
            ctx.fillRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
            ctx.restore();
        }
    }, []);

    useEffect(() => { drawCanvas(); }, [tables, mapData, drawCanvas]);
    useEffect(() => {
        const id = setTimeout(drawCanvas, 30);
        return () => clearTimeout(id);
    }, [scale, offset, drawCanvas]);

    // ─── Hit-test helpers ────────────────────────────────────────────────
    const hitSeat = (imgX, imgY) => {
        let best = null, bestDist = Infinity;
        for (const table of tablesRef.current) {
            for (const seat of table.seats) {
                const [sx, sy] = seat.position;
                const dist = Math.hypot(imgX - sx, imgY - sy);
                if (dist < SEAT_HIT_RADIUS && dist < bestDist) {
                    bestDist = dist; best = seat;
                }
            }
        }
        return best;
    };

    const hitTable = (imgX, imgY) => {
        for (const table of tablesRef.current) {
            const { x, y, w, h, angle } = table.contour;
            // Coordinate transformation to local rotated space
            const dx = imgX - x;
            const dy = imgY - y;
            const cos = Math.cos(-angle * Math.PI / 180);
            const sin = Math.sin(-angle * Math.PI / 180);
            const localX = dx * cos - dy * sin;
            const localY = dx * sin + dy * cos;
            
            if (Math.abs(localX) <= w / 2 && Math.abs(localY) <= h / 2) return table;
        }
        return null;
    };

    // ─── Manual API helpers ──────────────────────────────────────────────
    const api = useCallback(async (path, body) => {
        const res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Client-Type': clientType // Enforce on backend
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(err.detail || 'API error');
        }
        return res.json();
    }, [clientType]);

    // ─── Undo Action ─────────────────────────────────────────────────────
    const handleUndo = useCallback(async () => {
        if (isMobile) return;
        try {
            await api('/manual/undo');
        } catch (err) {
            alert("Undo failed: " + err.message);
        }
    }, [api, isMobile]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                handleUndo();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleUndo]);

    // ─── Canvas interaction ──────────────────────────────────────────────
    const handleMouseDown = (e) => {
        // Start pan (always available) and draw-table drag
        isPanning.current = true;
        hasDragged.current = false;
        lastMouse.current = { x: e.clientX, y: e.clientY };

        if (activeToolRef.current === 'addTable' && editModeRef.current) {
            const canvas = canvasRef.current;
            const rect = canvas.getBoundingClientRect();
            const ci = canvasToImg(e.clientX - rect.left, e.clientY - rect.top);
            if (ci) {
                drawStart.current = ci;
                drawRect.current = null;
            }
        }
    };

    const handleMouseMove = (e) => {
        if (!isPanning.current) return;
        const dx = e.clientX - lastMouse.current.x;
        const dy = e.clientY - lastMouse.current.y;
        if (Math.hypot(dx, dy) > 3) hasDragged.current = true;

        if (activeToolRef.current === 'addTable' && drawStart.current) {
            const canvas = canvasRef.current;
            const rect = canvas.getBoundingClientRect();
            const ci = canvasToImg(e.clientX - rect.left, e.clientY - rect.top);
            if (ci) {
                const x = Math.min(drawStart.current.imgX, ci.imgX);
                const y = Math.min(drawStart.current.imgY, ci.imgY);
                const w = Math.abs(ci.imgX - drawStart.current.imgX);
                const h = Math.abs(ci.imgY - drawStart.current.imgY);
                drawRect.current = { x, y, w, h };
                drawCanvas();
            }
        } else {
            // normal pan
            setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
            lastMouse.current = { x: e.clientX, y: e.clientY };
        }
    };

    const handleMouseUp = async (e) => {
        isPanning.current = false;

        if (activeToolRef.current === 'addTable' && drawStart.current && drawRect.current) {
            const { x, y, w, h } = drawRect.current;
            if (w > 10 && h > 10) {
                try {
                    await api('/manual/add-table', {
                        x: Math.round(x), y: Math.round(y),
                        w: Math.round(w), h: Math.round(h),
                    });
                    await fetchAll();
                } catch (err) { setMessage('Add table failed: ' + err.message); }
            }
            drawStart.current = null;
            drawRect.current = null;
            drawCanvas();
        }
    };

    // ─── Touch interaction ──────────────────────────────────────────────
    const handleTouchStart = (e) => {
        if (e.touches.length === 1) {
            isPanning.current = true;
            lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.touches.length === 2) {
            isPanning.current = false; // Disable pan during zoom
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            touchStartDist.current = dist;
            touchStartScale.current = scale;
        }
    };

    const handleTouchMove = (e) => {
        if (e.touches.length === 1 && isPanning.current) {
            const dx = e.touches[0].clientX - lastTouch.current.x;
            const dy = e.touches[0].clientY - lastTouch.current.y;
            setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
            lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.touches.length === 2 && touchStartDist.current) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const ratio = dist / touchStartDist.current;
            const nextScale = Math.min(Math.max(0.1, touchStartScale.current * ratio), 5);
            setScale(nextScale);
        }
    };

    const handleTouchEnd = () => {
        isPanning.current = false;
        touchStartDist.current = null;
    };

    const zoomIn = () => setScale(prev => Math.min(prev * 1.2, 5));
    const zoomOut = () => setScale(prev => Math.max(prev / 1.2, 0.1));

    const handleCanvasClick = useCallback(async (e) => {
        if (hasDragged.current) return;

        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img) return;

        const rect = img.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const imgX = cx * (img.naturalWidth / rect.width);
        const imgY = cy * (img.naturalHeight / rect.height);

        const tool = activeToolRef.current;

        // ── Normal mode: toggle seat occupancy ──────────────────────────
        if (!editModeRef.current || !tool) {
            const seat = hitSeat(imgX, imgY);
            if (seat) toggleSeat(seat.id);
            return;
        }

        // ── Edit-mode tools ─────────────────────────────────────────────
        if (tool === 'addSeat') {
            try {
                await api('/manual/add-seat', { x: Math.round(imgX), y: Math.round(imgY) });
                await fetchAll();
            } catch (err) { setMessage('Add seat failed: ' + err.message); }

        } else if (tool === 'removeSeat') {
            const seat = hitSeat(imgX, imgY);
            if (!seat) { setMessage('No seat found at that position.'); return; }
            try {
                await api('/manual/remove-seat', { seat_id: seat.id });
                await fetchAll();
            } catch (err) { setMessage('Remove seat failed: ' + err.message); }

        } else if (tool === 'removeTable') {
            const table = hitTable(imgX, imgY);
            if (!table) { setMessage('No table found at that position.'); return; }
            if (!window.confirm(`Delete table T${table.table_number} and all its seats?`)) return;
            try {
                await api('/manual/remove-table', { table_id: table.id });
                await fetchAll();
            } catch (err) { setMessage('Remove table failed: ' + err.message); }

        } else if (tool === 'editNumber') {
            const table = hitTable(imgX, imgY);
            if (!table) { setMessage('Click inside a table to edit its number.'); return; }
            setEditingTableId(table.id);
            setEditNumberValue(String(table.table_number));
        }
    }, [toggleSeat, api, fetchAll]);

    // ─── Commit inline number edit ───────────────────────────────────────
    const commitNumberEdit = useCallback(async () => {
        if (editingTableId === null) return;
        const n = parseInt(editNumberValue, 10);
        if (!isNaN(n) && n > 0) {
            try {
                await api('/manual/update-table-number', { table_id: editingTableId, manual_number: n });
                await fetchAll();
            } catch (err) { setMessage('Update number failed: ' + err.message); }
        }
        setEditingTableId(null);
        setEditNumberValue('');
    }, [editingTableId, editNumberValue, api, fetchAll]);

    // ─── Zoom / pan ──────────────────────────────────────────────────────
    const handleWheel = (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.12 : -0.12;
        setScale(z => Math.min(Math.max(0.15, z + delta), 12));
    };

    // ─── Control panel ───────────────────────────────────────────────────
    const callTableEndpoint = async (action) => {
        if (!selTable || !seatsAmount) return;
        const fd = new URLSearchParams({ amount: seatsAmount });
        const res = await fetch(`${API_BASE}/table/${selTable}/${action}`, {
            method: 'POST', body: fd,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const data = await res.json();
        setMessage(res.ok ? data.message : (data.detail || 'Error'));
        if (res.ok) { setSeatsAmount(''); fetchAll(); }
    };

    // ─── Cursor style ────────────────────────────────────────────────────
    const canvasCursor = () => {
        if (!editMode || !activeTool) return hasDragged.current ? 'grabbing' : 'crosshair';
        const cursors = {
            addSeat: 'cell',
            removeSeat: 'not-allowed',
            addTable: 'crosshair',
            removeTable: 'not-allowed',
            editNumber: 'text',
        };
        return cursors[activeTool] || 'crosshair';
    };

    // ─── Active tool hint ────────────────────────────────────────────────
    const activeToolHint = editMode && activeTool
        ? TOOLS.find(t => t.id === activeTool)?.hint
        : null;

    // ─── Inline number edit overlay (over canvas) ─────────────────────────
    const NumberEditOverlay = () => {
        if (editingTableId === null) return null;
        const table = tablesRef.current.find(t => t.id === editingTableId);
        if (!table || !imgRef.current) return null;
        const img = imgRef.current;
        const rect = img.getBoundingClientRect();
        const scaleX = rect.width / img.naturalWidth;
        const scaleY = rect.height / img.naturalHeight;
        // Position input just above the table label
        const left = table.contour.x * scaleX + 4;
        const top = table.contour.y * scaleY - 34;
        return (
            <div style={{
                position: 'absolute', left: `${left}px`, top: `${top}px`,
                zIndex: 50, display: 'flex', gap: '4px', alignItems: 'center',
                background: 'white', border: '2px solid #3b82f6', borderRadius: '6px',
                padding: '3px 6px', boxShadow: '0 4px 12px rgba(0,0,0,.18)',
            }}>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>T</span>
                <input
                    autoFocus
                    type="number" min="1"
                    value={editNumberValue}
                    onChange={e => setEditNumberValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitNumberEdit(); if (e.key === 'Escape') { setEditingTableId(null); } }}
                    onBlur={commitNumberEdit}
                    style={{
                        width: '52px', border: 'none', outline: 'none', fontSize: '14px',
                        fontWeight: 700, color: '#1e40af', padding: '0',
                    }}
                />
            </div>
        );
    };

    // ─── Render ──────────────────────────────────────────────────────────
    return (
        <div style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            height: '100vh',
            fontFamily: 'Inter,system-ui,sans-serif',
            background: '#f1f5f9',
            overflow: 'hidden'
        }}>

            {/* ── Sidebar ─────────────────────────────────────────────── */}
            <div style={{
                width: isMobile ? '100%' : '300px',
                height: isMobile ? 'auto' : '100%',
                maxHeight: isMobile ? '40vh' : '100%',
                flexShrink: 0, background: 'white',
                borderRight: isMobile ? 'none' : '1px solid #e2e8f0',
                borderTop: isMobile ? '1px solid #e2e8f0' : 'none',
                display: 'flex', flexDirection: 'column',
                padding: isMobile ? '12px 20px' : '20px',
                gap: isMobile ? '10px' : '16px',
                overflowY: 'auto', boxShadow: isMobile ? '0 -2px 10px rgba(0,0,0,.05)' : '2px 0 8px rgba(0,0,0,.05)',
                order: isMobile ? 2 : 1
            }}>
                <div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}>Seat Mapper</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>Seat assignment manager</div>
                </div>

                {/* Stats */}
                <div>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                        Live Statistics
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                        {[
                            { label: 'Tables', val: stats.num_tables, bg: '#f8fafc', col: '#334155' },
                            { label: 'Seats', val: stats.total_seats, bg: '#f8fafc', col: '#334155' },
                            { label: 'Free', val: stats.free_seats, bg: '#f0fdf4', col: '#15803d' },
                            { label: 'Occupied', val: stats.occupied_seats, bg: '#fef2f2', col: '#b91c1c' },
                        ].map(({ label, val, bg, col }) => (
                            <div key={label} style={{
                                background: bg, border: '1px solid #e2e8f0', borderRadius: '8px',
                                padding: isMobile ? '6px' : '10px', textAlign: 'center'
                            }}>
                                <div style={{ fontSize: isMobile ? '9px' : '11px', color: col, marginBottom: '2px' }}>{label}</div>
                                <div style={{ fontSize: isMobile ? '16px' : '24px', fontWeight: 700, color: col }}>{val}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Edit Layout Mode toggle */}
                <div>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                        Layout Editing
                    </div>
                    <button
                        onClick={() => {
                            if (isMobile) return; // Protected
                            const next = !editMode;
                            setEditMode(next);
                            if (!next) setActiveTool(null);
                        }}
                        disabled={isMobile}
                        style={{
                            width: '100%', padding: '10px 14px', borderRadius: '8px', border: '2px solid',
                            borderColor: editMode ? '#2563eb' : '#e2e8f0',
                            background: isMobile ? '#f1f5f9' : (editMode ? '#eff6ff' : '#f8fafc'),
                            color: isMobile ? '#94a3b8' : (editMode ? '#1d4ed8' : '#64748b'),
                            fontWeight: 700, fontSize: '13px', cursor: isMobile ? 'not-allowed' : 'pointer',
                            display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center',
                            transition: 'all 0.15s',
                        }}
                    >
                        <span>{isMobile ? '🔒' : (editMode ? '✏️' : '🔒')}</span>
                        {isMobile ? 'Edition limited on Mobile' : (editMode ? 'Edit Layout Mode  ON' : 'Edit Layout Mode  OFF')}
                    </button>

                    {/* Legend */}
                    <div style={{ marginTop: '8px', display: 'flex', gap: '12px', fontSize: '11px', color: '#64748b' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', border: `2px solid ${AUTO_COLOR}` }} />
                            Auto
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', border: `2px solid ${MANUAL_COLOR}`, borderStyle: 'dashed' }} />
                            Manual
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', border: `2px solid ${OVERRIDE_COLOR}` }} />
                            Renamed
                        </span>
                    </div>

                    {/* Tool buttons (visible only in edit mode) */}
                    {editMode && !isMobile && (
                        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {TOOLS.map(tool => (
                                <button
                                    key={tool.id}
                                    onClick={() => setActiveTool(prev => prev === tool.id ? null : tool.id)}
                                    title={tool.hint}
                                    style={{
                                        padding: '9px 12px', borderRadius: '7px', border: '1.5px solid',
                                        borderColor: activeTool === tool.id ? '#2563eb' : '#e2e8f0',
                                        background: activeTool === tool.id ? '#dbeafe' : '#f8fafc',
                                        color: activeTool === tool.id ? '#1d4ed8' : '#475569',
                                        fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                        transition: 'all 0.12s', textAlign: 'left',
                                    }}
                                >
                                    <span style={{ fontSize: '15px' }}>{tool.icon}</span>
                                    {tool.label}
                                </button>
                            ))}
                            {activeTool && (
                                <div style={{
                                    marginTop: '2px', fontSize: '11px', color: '#3b82f6',
                                    background: '#eff6ff', borderRadius: '6px', padding: '7px 10px',
                                    border: '1px solid #bfdbfe'
                                }}>
                                    💡 {TOOLS.find(t => t.id === activeTool)?.hint}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Control panel */}
                <div>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                        Table Control
                    </div>
                    <div style={{
                        background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px',
                        padding: '12px', display: 'flex', flexDirection: isMobile ? 'row' : 'column',
                        gap: '10px', alignItems: isMobile ? 'flex-end' : 'stretch'
                    }}>
                        <label style={{ flex: 1, fontSize: '12px', fontWeight: 500, color: '#475569' }}>
                            Table #
                            <input type="number" value={selTable} onChange={e => setSelTable(e.target.value)}
                                placeholder="1"
                                style={{ display: 'block', width: '100%', marginTop: '4px', padding: '7px 8px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                            />
                        </label>
                        <label style={{ flex: 1, fontSize: '12px', fontWeight: 500, color: '#475569' }}>
                            Qty
                            <input type="number" value={seatsAmount} onChange={e => setSeatsAmount(e.target.value)}
                                placeholder="8"
                                style={{ display: 'block', width: '100%', marginTop: '4px', padding: '7px 8px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
                            />
                        </label>
                        <div style={{ display: 'flex', gap: '6px', marginBottom: isMobile ? '2px' : '0' }}>
                            <button onClick={() => callTableEndpoint('add-seats')}
                                style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                                +
                            </button>
                            <button onClick={() => callTableEndpoint('remove-seats')}
                                style={{ background: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '6px', padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                                −
                            </button>
                        </div>
                    </div>
                </div>

                {message && (
                    <div style={{ fontSize: '12px', color: '#475569', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px 10px' }}>
                        {message}
                        {uploading && (
                            <div style={{ marginTop: '6px', width: '100%', height: '4px', background: '#e2e8f0', borderRadius: '2px', overflow: 'hidden' }}>
                                <div style={{ width: `${uploadProgress}%`, height: '100%', background: '#2563eb', transition: 'width 0.2s ease-out' }} />
                            </div>
                        )}
                    </div>
                )}

                {!isMobile && (
                    <div style={{ marginTop: 'auto', borderTop: '1px solid #e2e8f0', paddingTop: '16px' }}>
                        <label style={{
                            display: 'block', textAlign: 'center',
                            background: uploading ? '#94a3b8' : '#2563eb',
                            color: 'white', fontWeight: 600, fontSize: '14px', padding: '12px',
                            borderRadius: '8px', cursor: uploading ? 'default' : 'pointer', transition: 'background 0.2s'
                        }}>
                            {uploading ? 'Processing…' : '⬆  Upload New Map'}
                            <input type="file" accept="image/jpeg,image/jpg" onChange={handleFileUpload}
                                disabled={uploading} style={{ display: 'none' }} />
                        </label>
                    </div>
                )}
            </div>

            {/* ── Map viewport ─────────────────────────────────────────── */}
            <div
                style={{
                    flex: 1, position: 'relative', overflow: 'hidden', background: '#e2e8f0',
                    cursor: isPanning.current ? 'grabbing' : (editMode && activeTool ? canvasCursor() : 'grab'),
                    order: isMobile ? 1 : 2
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Zoom hint */}
                <div style={{
                    position: 'absolute', top: 12, left: 12, zIndex: 20,
                    background: 'rgba(255,255,255,.88)', padding: '5px 10px',
                    borderRadius: '6px', fontSize: '11px', fontWeight: 500,
                    color: '#475569', pointerEvents: 'none', boxShadow: '0 1px 4px rgba(0,0,0,.12)'
                }}>
                    {activeToolHint
                        ? <span style={{ color: '#2563eb' }}>🛠 {activeToolHint}</span>
                        : '🖱 Scroll to zoom · Drag to pan'}
                </div>

                {/* Edit mode banner */}
                {editMode && (
                    <div style={{
                        position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 25,
                        background: activeTool ? '#2563eb' : 'rgba(37,99,235,0.85)',
                        color: 'white', padding: '5px 16px', borderRadius: '20px',
                        fontSize: '12px', fontWeight: 700, pointerEvents: 'none',
                        boxShadow: '0 2px 8px rgba(37,99,235,.4)',
                    }}>
                        ✏️ EDIT MODE{activeTool ? ` — ${TOOLS.find(t => t.id === activeTool)?.label.toUpperCase()}` : ' — select a tool'}
                    </div>
                )}

                {/* Zoom controls */}
                <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 20, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {[{ label: '+', action: zoomIn }, { label: '⟳', action: () => { setScale(1); setOffset({ x: 0, y: 0 }); } }, { label: '−', action: zoomOut }].map(btn => (
                        <button key={btn.label}
                            onClick={btn.action}
                            style={{
                                width: '32px', height: '32px', background: 'white', border: '1px solid #e2e8f0',
                                borderRadius: '6px', fontSize: '16px', cursor: 'pointer',
                                boxShadow: '0 1px 4px rgba(0,0,0,.1)', lineHeight: '1'
                            }}>
                            {btn.label}
                        </button>
                    ))}
                </div>

                {mapData ? (
                    <div style={{
                        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        pointerEvents: 'none',
                    }}>
                        {/* Visual canvas */}
                        <div style={{
                            position: 'relative', display: 'inline-block',
                            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                            transformOrigin: '0 0',
                            transition: (isPanning.current || touchStartDist.current) ? 'none' : 'transform 0.1s ease-out',
                            pointerEvents: 'auto',
                            borderRadius: '8px', boxShadow: '0 4px 24px rgba(0,0,0,.18)',
                        }}>
                            <img
                                ref={imgRef}
                                src={`${API_BASE}${mapData.url}`}
                                alt="Map"
                                draggable={false}
                                onLoad={drawCanvas}
                                style={{
                                    display: 'block', maxWidth: '85vw', maxHeight: '85vh',
                                    userSelect: 'none', borderRadius: '8px', background: 'white',
                                }}
                            />
                            <canvas
                                ref={canvasRef}
                                onClick={handleCanvasClick}
                                style={{
                                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                    cursor: 'inherit', touchAction: 'none',
                                }}
                            />
                            <NumberEditOverlay />
                        </div>
                    </div>
                ) : (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#94a3b8',
                    }}>
                        <svg width="64" height="64" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
                                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <div style={{ fontSize: '16px', fontWeight: 500, color: '#64748b' }}>No map uploaded yet</div>
                        <div style={{ fontSize: '13px' }}>Use the Upload button in the sidebar</div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Mount ───────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
