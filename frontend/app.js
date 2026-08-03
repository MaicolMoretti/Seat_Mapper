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

// ─── Visual Components ───────────────────────────────────────────────────────
const MoveBtn = ({ icon, onClick }) => (
    <button onClick={onClick} style={{
        width: '32px', height: '32px', background: '#fff', border: '1px solid #fcd34d',
        borderRadius: '6px', fontSize: '14px', cursor: 'pointer', display: 'flex',
        alignItems: 'center', justifyContent: 'center', color: '#b45309', fontWeight: 'bold',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
    }}>
        {icon}
    </button>
);

// ─── Tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
    { id: 'addSeat', label: '+ Aggiungi posto', icon: '🪑', hint: 'Click on the map to place a new seat' },
    { id: 'removeSeat', label: '✕ Rimuovi posto', icon: '❌', hint: 'Click an existing seat to delete it' },
    { id: 'addTable', label: '+ Aggiungi tavolo', icon: '⬜', hint: 'Drag to draw a new table region' },
    { id: 'removeTable', label: '✕ Rimuovi tavolo', icon: '🗑', hint: 'Click inside a table to delete it' },
    { id: 'editNumber', label: '✎ Modifica numero', icon: '🔢', hint: 'Click a table label to rename it' },
    { id: 'move', label: '✥ Sposta', icon: '↔', hint: 'Select a manual element (blue) to move it' },
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

    // Pending shape (before confirm)
    const [pendingShape, setPendingShape] = useState(null);
    // { type: 'table'|'seat', x, y, w, h, angle }
    const pendingShapeRef = useRef(null);
    useEffect(() => { pendingShapeRef.current = pendingShape; }, [pendingShape]);

    const canvasRef = useRef(null);
    const imgRef = useRef(null);
    const tablesRef = useRef([]);
    const activeToolRef = useRef(null);
    const editModeRef = useRef(false);

    useEffect(() => { tablesRef.current = tables; }, [tables]);
    useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
    useEffect(() => { editModeRef.current = editMode; }, [editMode]);

    // Stats modal state
    const [showStatsModal, setShowStatsModal] = useState(false);
    const [statsHistory, setStatsHistory] = useState(null);
    const chartInstanceRef = useRef(null);

    const fetchStatsHistory = useCallback(async () => {
        try {
            const r = await fetch(`${API_BASE}/stats/history`);
            const data = await r.json();
            setStatsHistory(data);
        } catch (e) {
            console.error('fetchStatsHistory', e);
        }
    }, []);

    const resetStatsHistory = async () => {
        if (!window.confirm("Sei sicuro di voler azzerare tutti i dati storici delle statistiche e il contatore?")) return;
        try {
            await fetch(`${API_BASE}/stats/reset`, { method: 'POST' });
            fetchStatsHistory();
            fetchStats();
        } catch (e) {
            console.error('resetStatsHistory', e);
        }
    };

    const downloadPDFReport = async () => {
        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const element = document.getElementById('stats-report-content');
            if (!element) return;

            const canvas = await window.html2canvas(element, { scale: 2 });
            const imgData = canvas.toDataURL('image/png');
            const imgWidth = 190;
            const pageHeight = 295;
            const imgHeight = (canvas.height * imgWidth) / canvas.width;

            pdf.setFontSize(18);
            pdf.text("Report Statistiche Occupazione", 15, 15);
            pdf.setFontSize(10);
            pdf.text(`Data e Ora: ${new Date().toLocaleString('it-IT')}`, 15, 22);

            pdf.addImage(imgData, 'PNG', 10, 28, imgWidth, imgHeight);
            pdf.save(`Report_Statistiche_Occupazione_${new Date().toISOString().slice(0, 10)}.pdf`);
        } catch (err) {
            console.error("PDF Generation error", err);
            alert("Errore durante la generazione del file PDF: " + err.message);
        }
    };

    const downloadJSONData = () => {
        if (!statsHistory) return;
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(statsHistory, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `statistiche_occupazione_${new Date().toISOString().slice(0, 10)}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    };

    // Render Chart.js when statsHistory updates or modal opens
    useEffect(() => {
        if (!showStatsModal || !statsHistory) return;

        const timer = setTimeout(() => {
            const canvas = document.getElementById('occupancyChart');
            if (!canvas) return;

            if (chartInstanceRef.current) {
                chartInstanceRef.current.destroy();
            }

            const ctx = canvas.getContext('2d');
            const labels = statsHistory.history.map(item => item.time_str);
            const dataValues = statsHistory.history.map(item => item.occupied_seats);

            // Create gradient
            const gradient = ctx.createLinearGradient(0, 0, 0, 300);
            gradient.addColorStop(0, 'rgba(59, 130, 246, 0.4)');
            gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

            // Plugin for Max/Min Peak Annotations
            const peakAnnotationPlugin = {
                id: 'peakAnnotations',
                afterDatasetsDraw(chart) {
                    const { ctx, scales: { x, y } } = chart;
                    if (!statsHistory.history || statsHistory.history.length === 0) return;

                    const history = statsHistory.history;
                    const maxVal = statsHistory.max_peak;
                    const minVal = statsHistory.min_peak;

                    const maxIdx = history.findIndex(h => h.occupied_seats === maxVal);
                    const minIdx = history.findIndex(h => h.occupied_seats === minVal);

                    // Draw Max Peak badge
                    if (maxIdx !== -1) {
                        const meta = chart.getDatasetMeta(0);
                        const point = meta.data[maxIdx];
                        if (point) {
                            ctx.save();
                            ctx.fillStyle = '#ef4444';
                            ctx.beginPath();
                            ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
                            ctx.fill();

                            ctx.fillStyle = '#b91c1c';
                            ctx.font = 'bold 11px Inter, sans-serif';
                            ctx.textAlign = 'center';
                            ctx.fillText(`Max (${maxVal})`, point.x, point.y - 10);
                            ctx.restore();
                        }
                    }

                    // Draw Min Peak badge
                    if (minIdx !== -1 && minIdx !== maxIdx) {
                        const meta = chart.getDatasetMeta(0);
                        const point = meta.data[minIdx];
                        if (point) {
                            ctx.save();
                            ctx.fillStyle = '#10b981';
                            ctx.beginPath();
                            ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
                            ctx.fill();

                            ctx.fillStyle = '#047857';
                            ctx.font = 'bold 11px Inter, sans-serif';
                            ctx.textAlign = 'center';
                            ctx.fillText(`Min (${minVal})`, point.x, point.y + 18);
                            ctx.restore();
                        }
                    }
                }
            };

            chartInstanceRef.current = new window.Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Posti Occupati',
                        data: dataValues,
                        borderColor: '#2563eb',
                        borderWidth: 3,
                        backgroundColor: gradient,
                        fill: true,
                        tension: 0.3,
                        pointRadius: 4,
                        pointBackgroundColor: '#1d4ed8',
                        pointHoverRadius: 6,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    return `Posti occupati: ${context.parsed.y}`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: { font: { size: 11 }, color: '#64748b' }
                        },
                        y: {
                            beginAtZero: true,
                            ticks: { precision: 0, font: { size: 11 }, color: '#64748b' },
                            grid: { color: '#f1f5f9' }
                        }
                    }
                },
                plugins: [peakAnnotationPlugin]
            });
        }, 100);

        return () => clearTimeout(timer);
    }, [showStatsModal, statsHistory]);

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
        // ── Capacity check: warn if table is already full ──
        const parentTable = tablesRef.current.find(t => t.seats.some(s => s.id === seatId));
        const seat = parentTable?.seats.find(s => s.id === seatId);
        if (parentTable && seat && !seat.occupied) {
            // The user is trying to mark this seat as occupied
            const totalSeats = parentTable.seats.length;
            const occupiedSeats = parentTable.seats.filter(s => s.occupied).length;
            if (occupiedSeats >= totalSeats) {
                setMessage(`⚠️ Il tavolo T${parentTable.table_number} ha raggiunto la capienza massima di ${totalSeats} posti. Non è possibile aggiungere altre persone.`);
                setTimeout(() => setMessage(''), 5000);
                return; // Block the action
            }
        }

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

        const counts = {};
        tablesRef.current.forEach(t => { counts[t.table_number] = (counts[t.table_number] || 0) + 1; });

        for (const table of tablesRef.current) {
            // Hide the table if it's currently being moved in pendingShape
            if (pendingShapeRef.current?.id === table.id && pendingShapeRef.current?.type === 'table') continue;

            const { x, y, w, h, angle } = table.contour;
            const isManual = table.detected_by === 'manual';
            const isOverride = table.number_overridden;
            const isDuplicate = counts[table.table_number] > 1;
            const tableColor = isDuplicate ? '#ef4444' : (isManual ? MANUAL_COLOR : AUTO_COLOR);

            ctx.save();
            ctx.translate(x * scaleX, y * scaleY);
            ctx.rotate((angle * Math.PI) / 180);

            // Table bounding box fill
            ctx.fillStyle = isDuplicate
                ? 'rgba(239,68,68,0.15)'
                : (isManual ? 'rgba(59,130,246,0.06)' : 'rgba(34,197,94,0.06)');
            ctx.fillRect(- (w * scaleX) / 2, - (h * scaleY) / 2, w * scaleX, h * scaleY);

            // Table bounding box stroke
            ctx.strokeStyle = tableColor;
            ctx.lineWidth = isManual ? 2.5 : 1.5;
            ctx.setLineDash(isManual ? [6, 3] : []);
            ctx.strokeRect(- (w * scaleX) / 2, - (h * scaleY) / 2, w * scaleX, h * scaleY);

            if (isDuplicate) {
                ctx.fillStyle = '#ef4444';
                ctx.font = `bold ${Math.max(14, 16 * scaleX)}px sans-serif`;
                ctx.fillText("⚠️", - (w * scaleX) / 2 - 12, - (h * scaleY) / 2 - 4);
            }

            ctx.restore();

            // Table label
            const fontSize = Math.max(11, 13 * scaleX);
            const labelText = `T${table.table_number}${isOverride ? ' ✎' : ''}`;
            ctx.save();
            ctx.translate(x * scaleX, y * scaleY);
            ctx.font = `bold ${fontSize}px Inter, sans-serif`;
            const tw2 = ctx.measureText(labelText).width;
            ctx.fillStyle = isManual ? MANUAL_COLOR : (isOverride ? OVERRIDE_COLOR : AUTO_COLOR);
            ctx.fillText(labelText, -tw2 / 2, -(h * scaleY) / 2 - 6);
            ctx.restore();

            // Seats
            for (const seat of table.seats) {
                let [sx, sy] = seat.position || [0, 0];
                if (typeof sx === 'string') sx = parseFloat(sx);
                if (typeof sy === 'string') sy = parseFloat(sy);
                if (isNaN(sx)) sx = 0;
                if (isNaN(sy)) sy = 0;
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

        // Draw add-table drag preview (before mouse-up)
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

        // Draw pending shape with applied angle
        const ps = pendingShapeRef.current;
        if (ps) {
            const { x, y, w, h, angle } = ps;
            const rad = (angle * Math.PI) / 180;
            ctx.save();
            ctx.translate(x * scaleX, y * scaleY);
            ctx.rotate(rad);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([8, 4]);
            ctx.fillStyle = 'rgba(245,158,11,0.12)';
            if (ps.type === 'table') {
                ctx.strokeRect(-(w * scaleX) / 2, -(h * scaleY) / 2, w * scaleX, h * scaleY);
                ctx.fillRect(-(w * scaleX) / 2, -(h * scaleY) / 2, w * scaleX, h * scaleY);
            } else {
                const half = Math.max(5, 7 * Math.min(scaleX, scaleY)) * (w / 20);
                ctx.strokeRect(-half, -half, half * 2, half * 2);
                ctx.fillRect(-half, -half, half * 2, half * 2);
            }
            ctx.restore();
        }
    }, []);

    useEffect(() => { drawCanvas(); }, [tables, mapData, drawCanvas, pendingShape]);
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
                // Set pending shape instead of immediately saving
                setPendingShape({ type: 'table', x: Math.round(x + w / 2), y: Math.round(y + h / 2), w: Math.round(w), h: Math.round(h), angle: 0 });
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
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);

            const ratio = dist / touchStartDist.current;
            const newScale = Math.min(Math.max(0.1, touchStartScale.current * ratio), 12);

            // Focal point zoom for pinch
            const midX = (touch1.clientX + touch2.clientX) / 2;
            const midY = (touch1.clientY + touch2.clientY) / 2;

            const viewport = e.currentTarget.getBoundingClientRect();
            const px = midX - viewport.left;
            const py = midY - viewport.top;

            setOffset(oldOffset => {
                const sOld = scale;
                const sNew = newScale;
                return {
                    x: px - (px - oldOffset.x) * (sNew / sOld),
                    y: py - (py - oldOffset.y) * (sNew / sOld)
                };
            });
            setScale(newScale);
        }
    };

    const handleTouchEnd = () => {
        isPanning.current = false;
        touchStartDist.current = null;
    };

    const performZoom = (factor, centerX, centerY) => {
        const sOld = scale;
        const sNew = Math.min(Math.max(0.1, sOld * factor), 12);

        let fx = centerX;
        let fy = centerY;

        if (fx === undefined || fy === undefined) {
            const viewport = canvasRef.current?.parentElement?.getBoundingClientRect();
            if (viewport) {
                fx = viewport.width / 2;
                fy = viewport.height / 2;
            } else {
                fx = 0; fy = 0;
            }
        }

        setOffset(old => ({
            x: fx - (fx - old.x) * (sNew / sOld),
            y: fy - (fy - old.y) * (sNew / sOld)
        }));
        setScale(sNew);
    };

    const zoomIn = () => performZoom(1.2);
    const zoomOut = () => performZoom(1 / 1.2);

    const centerImage = useCallback(() => {
        const img = imgRef.current;
        const container = document.querySelector('.viewport-container');
        if (!img || !container) return;
        const vw = container.clientWidth;
        const vh = container.clientHeight;
        const iw = img.offsetWidth;
        const ih = img.offsetHeight;
        setOffset({ x: (vw - iw) / 2, y: (vh - ih) / 2 });
        setScale(1);
    }, []);

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
            // Set pending shape instead of immediately saving
            setPendingShape({ type: 'seat', x: Math.round(imgX), y: Math.round(imgY), w: 20, h: 20, angle: 0 });

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

        } else if (tool === 'move') {
            // Try hit seat first (higher priority)
            const seat = hitSeat(imgX, imgY);
            if (seat && seat.detected_by === 'manual') {
                setPendingShape({
                    type: 'seat', id: seat.id,
                    x: seat.position[0], y: seat.position[1],
                    w: 20, h: 20, angle: seat.angle || 0
                });
                return;
            }
            // Then hit table
            const table = hitTable(imgX, imgY);
            if (table && table.detected_by === 'manual') {
                const { x, y, w, h, angle } = table.contour;
                setPendingShape({
                    type: 'table', id: table.id,
                    x, y, w, h, angle
                });
            } else {
                setMessage('Click a manual (blue) element to move it.');
            }
        }
    }, [toggleSeat, api, fetchAll]);

    // ─── Commit inline number edit ───────────────────────────────────────
    const commitNumberEdit = useCallback(async () => {
        if (editingTableId === null) return;
        const n = parseInt(editNumberValue, 10);
        if (!isNaN(n) && n > 0) {
            const alreadyExists = tablesRef.current.some(t => t.id !== editingTableId && t.table_number === n);
            if (alreadyExists) {
                if (!window.confirm("Il numero del tavolo già esiste, procedere comunque?")) {
                    setEditingTableId(null);
                    setEditNumberValue('');
                    return;
                }
            }
            try {
                await api('/manual/update-table-number', { table_id: editingTableId, manual_number: n });
                await fetchAll();
            } catch (err) { setMessage('Update number failed: ' + err.message); }
        }
        setEditingTableId(null);
        setEditNumberValue('');
    }, [editingTableId, editNumberValue, api, fetchAll]);

    // ─── Pending shape handlers ─────────────────────────────────────────
    const confirmPendingShape = useCallback(async () => {
        const ps = pendingShapeRef.current;
        if (!ps) return;
        try {
            if (ps.type === 'table') {
                const endpoint = ps.id ? '/manual/move-table' : '/manual/add-table';
                const body = ps.id
                    ? { table_id: ps.id, x: ps.x, y: ps.y, w: ps.w, h: ps.h, angle: ps.angle }
                    : { x: ps.x, y: ps.y, w: ps.w, h: ps.h, angle: ps.angle };
                await api(endpoint, body);
            } else {
                const endpoint = ps.id ? '/manual/move-seat' : '/manual/add-seat';
                const body = ps.id
                    ? { seat_id: ps.id, x: ps.x, y: ps.y, angle: ps.angle }
                    : { x: ps.x, y: ps.y, angle: ps.angle };
                await api(endpoint, body);
            }
            await fetchAll();
            setPendingShape(null);
        } catch (err) { setMessage('Save failed: ' + err.message); }
    }, [api, fetchAll]);

    const cancelPendingShape = useCallback(() => {
        setPendingShape(null);
    }, []);

    // ─── Zoom / pan ──────────────────────────────────────────────────────
    const handleWheel = (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 0.85;
        const viewport = e.currentTarget.getBoundingClientRect();
        performZoom(factor, e.clientX - viewport.left, e.clientY - viewport.top);
    };

    const clearAll = async () => {
        if (!window.confirm("eliminare tutti i posti a sedere? --> si o no")) return;
        try {
            await api('/seat/clear-all');
            await fetchAll();
            setMessage("Tutti i posti sono stati liberati.");
            setTimeout(() => setMessage(''), 3000);
        } catch (err) {
            setMessage("Errore nel reset: " + err.message);
        }
    };

    // ─── Control panel ───────────────────────────────────────────────────
    const callTableEndpoint = async (action) => {
        if (!selTable || !seatsAmount) return;

        // ── Capacity check when marking seats as occupied ──
        if (action === 'add-seats') {
            const table = tablesRef.current.find(t => t.table_number === Number(selTable));
            if (table) {
                const totalSeats = table.seats.length;
                const occupiedSeats = table.seats.filter(s => s.occupied).length;
                const toAdd = Number(seatsAmount);
                const newTotal = occupiedSeats + toAdd;
                if (newTotal > totalSeats) {
                    const available = totalSeats - occupiedSeats;
                    setMessage(
                        `⚠️ Il tavolo T${table.table_number} può contenere max ${totalSeats} persone. ` +
                        `Attualmente ci sono ${occupiedSeats} posti occupati, ` +
                        `quindi puoi aggiungerne al massimo ${available > 0 ? available : 0}.`
                    );
                    setTimeout(() => setMessage(''), 6000);
                    return; // Block the action
                }
            }
        }

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
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}>Seat Mapper Mexico&Nuvole</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>Gestione posti a sedere</div>
                </div>

                {/* Stats */}
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            Live Statistics
                        </div>
                        <button
                            onClick={() => {
                                fetchStatsHistory();
                                setShowStatsModal(true);
                            }}
                            style={{
                                background: '#2563eb', color: 'white', border: 'none',
                                borderRadius: '6px', padding: '4px 10px', fontSize: '11px', fontWeight: 700,
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                                boxShadow: '0 1px 3px rgba(37,99,235,0.3)', transition: 'background 0.15s'
                            }}
                            onMouseOver={e => e.currentTarget.style.background = '#1d4ed8'}
                            onMouseOut={e => e.currentTarget.style.background = '#2563eb'}
                        >
                            📊 Statistiche
                        </button>
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
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            Table Control
                        </div>
                        <button onClick={clearAll}
                            style={{
                                background: 'transparent', color: '#ef4444', border: '1px solid #fee2e2',
                                borderRadius: '4px', padding: '2px 8px', fontSize: '10px', fontWeight: 700,
                                cursor: 'pointer', textTransform: 'uppercase', transition: 'all 0.2s'
                            }}
                            onMouseOver={e => e.currentTarget.style.background = '#fef2f2'}
                            onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                            Clear All
                        </button>
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

                {/* ── Shape Properties Panel (appears after adding a table/seat) ── */}
                {pendingShape && (
                    <div style={{
                        background: '#fffbeb', border: '2px solid #f59e0b',
                        borderRadius: '10px', padding: '12px',
                    }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
                            🔧 {pendingShape.id ? (pendingShape.type === 'table' ? 'Sposta Tavolo' : 'Sposta Posto') : (pendingShape.type === 'table' ? 'Nuovo Tavolo' : 'Nuovo Posto')} — {pendingShape.id ? 'Modifica' : 'Proprietà'}
                        </div>

                        {/* Movement Controls (User requested Up/Down/Left/Right) */}
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#78350f', marginBottom: '6px' }}>
                            Posizione (Sposta)
                        </label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px', marginBottom: '15px', width: 'fit-content', margin: '0 auto 15px' }}>
                            <div />
                            <MoveBtn icon="▲" onClick={() => setPendingShape(ps => ({ ...ps, y: ps.y - 5 }))} />
                            <div />
                            <MoveBtn icon="◀" onClick={() => setPendingShape(ps => ({ ...ps, x: ps.x - 5 }))} />
                            <div />
                            <MoveBtn icon="▶" onClick={() => setPendingShape(ps => ({ ...ps, x: ps.x + 5 }))} />
                            <div />
                            <MoveBtn icon="▼" onClick={() => setPendingShape(ps => ({ ...ps, y: ps.y + 5 }))} />
                            <div />
                        </div>

                        {/* Width / Height for tables */}
                        {pendingShape.type === 'table' && <>
                            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#78350f', marginBottom: '8px' }}>
                                Larghezza (px)
                                <input type="number" min="5" max="2000" value={pendingShape.w}
                                    onChange={e => setPendingShape(ps => ({ ...ps, w: Math.max(5, parseInt(e.target.value) || 5) }))}
                                    style={{ display: 'block', width: '100%', marginTop: '3px', padding: '6px 8px', border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', background: 'white' }}
                                />
                            </label>
                            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#78350f', marginBottom: '8px' }}>
                                Altezza (px)
                                <input type="number" min="5" max="2000" value={pendingShape.h}
                                    onChange={e => setPendingShape(ps => ({ ...ps, h: Math.max(5, parseInt(e.target.value) || 5) }))}
                                    style={{ display: 'block', width: '100%', marginTop: '3px', padding: '6px 8px', border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', background: 'white' }}
                                />
                            </label>
                        </>}

                        {/* Size for seats */}
                        {pendingShape.type === 'seat' && (
                            <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#78350f', marginBottom: '8px' }}>
                                Dimensione (px)
                                <input type="number" min="5" max="200" value={pendingShape.w}
                                    onChange={e => { const v = Math.max(5, parseInt(e.target.value) || 5); setPendingShape(ps => ({ ...ps, w: v, h: v })); }}
                                    style={{ display: 'block', width: '100%', marginTop: '3px', padding: '6px 8px', border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', background: 'white' }}
                                />
                            </label>
                        )}

                        {/* Angle slider + number */}
                        <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: '#78350f', marginBottom: '4px' }}>
                            Angolo: <strong>{pendingShape.angle}°</strong>
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                            <input type="range" min="-180" max="180" step="1" value={pendingShape.angle}
                                onChange={e => setPendingShape(ps => ({ ...ps, angle: parseInt(e.target.value) }))}
                                style={{ flex: 1, accentColor: '#f59e0b' }}
                            />
                            <input type="number" min="-180" max="180" value={pendingShape.angle}
                                onChange={e => setPendingShape(ps => ({ ...ps, angle: parseInt(e.target.value) || 0 }))}
                                style={{ width: '58px', padding: '5px 6px', border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '12px', outline: 'none', background: 'white' }}
                            />
                        </div>

                        {/* Confirm / Cancel */}
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={confirmPendingShape}
                                style={{ flex: 1, background: '#d97706', color: 'white', border: 'none', borderRadius: '7px', padding: '9px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
                                ✔ Conferma
                            </button>
                            <button onClick={cancelPendingShape}
                                style={{ flex: 1, background: '#e2e8f0', color: '#475569', border: 'none', borderRadius: '7px', padding: '9px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                                ✕ Annulla
                            </button>
                        </div>
                    </div>
                )}

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
                className="viewport-container"
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

                {/* Duplicate tables banner */}
                {(() => {
                    const counts = {};
                    tables.forEach(t => { counts[t.table_number] = (counts[t.table_number] || 0) + 1; });
                    const dups = Object.keys(counts).filter(k => counts[k] > 1);
                    if (dups.length === 0) return null;
                    return (
                        <div style={{
                            position: 'absolute', top: editMode ? 46 : 12, left: '50%', transform: 'translateX(-50%)', zIndex: 25,
                            background: '#ef4444', color: 'white', padding: '6px 16px', borderRadius: '8px',
                            fontSize: '13px', fontWeight: 700, pointerEvents: 'none',
                            boxShadow: '0 4px 12px rgba(239,68,68,.4)', display: 'flex', alignItems: 'center', gap: '8px'
                        }}>
                            <span>⚠️</span> Attenzione: i tavoli {dups.join(', ')} sono duplicati!
                        </div>
                    );
                })()}

                {/* Zoom controls */}
                <div style={{
                    position: 'absolute',
                    top: isMobile ? '80px' : '12px',  // Shift down on mobile/tablet to avoid collision
                    right: '12px',
                    zIndex: 20,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                }}>
                    {[{ label: '+', action: zoomIn }, { label: '⟳', action: centerImage }, { label: '−', action: zoomOut }].map(btn => (
                        <button key={btn.label}
                            onClick={btn.action}
                            style={{
                                width: '40px', height: '40px', // Slightly larger for better touch surface
                                background: 'white', border: '1px solid #e2e8f0',
                                borderRadius: '8px', fontSize: '18px', cursor: 'pointer',
                                boxShadow: '0 2px 6px rgba(0,0,0,.15)', lineHeight: '1',
                                display: 'flex', alignItems: 'center', justifyContent: 'center'
                            }}>
                            {btn.label}
                        </button>
                    ))}
                </div>

                {mapData ? (
                    <div style={{
                        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
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
                                onLoad={(e) => { drawCanvas(); centerImage(); }}
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

            {/* ── Modal Statistiche ────────────────────────────────────── */}
            {showStatsModal && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 100,
                    background: 'rgba(15, 23, 42, 0.65)', backdropFilter: 'blur(4px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: isMobile ? '10px' : '20px'
                }}>
                    <div style={{
                        background: 'white', width: '100%', maxWidth: '800px',
                        maxHeight: '90vh', borderRadius: '16px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
                        display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    }}>
                        {/* Header Modal */}
                        <div style={{
                            padding: '16px 24px', borderBottom: '1px solid #e2e8f0',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            background: '#f8fafc'
                        }}>
                            <div>
                                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                                    📊 Statistiche
                                </h2>
                                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                                    Analisi della curva temporale di affluenza e conteggio totale
                                </div>
                            </div>
                            <button onClick={() => setShowStatsModal(false)}
                                style={{
                                    background: 'transparent', border: 'none', fontSize: '20px',
                                    color: '#64748b', cursor: 'pointer', padding: '4px 8px', borderRadius: '6px'
                                }}>
                                ✕
                            </button>
                        </div>

                        {/* Modal Body / Report Content */}
                        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }} id="stats-report-content">
                            {/* Summary Cards */}
                            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' }}>
                                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#1e40af', textTransform: 'uppercase' }}>Posti Occupati Totali</div>
                                    <div style={{ fontSize: '24px', fontWeight: 800, color: '#1d4ed8', marginTop: '4px' }}>
                                        {statsHistory ? statsHistory.total_occupied_events : 0}
                                    </div>
                                    <div style={{ fontSize: '10px', color: '#3b82f6', marginTop: '2px' }}>Eventi cumulativi</div>
                                </div>
                                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#991b1b', textTransform: 'uppercase' }}>Picco Massimo</div>
                                    <div style={{ fontSize: '24px', fontWeight: 800, color: '#dc2626', marginTop: '4px' }}>
                                        {statsHistory ? statsHistory.max_peak : 0}
                                    </div>
                                    <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '2px' }}>Max affluenza contemporanea</div>
                                </div>
                                <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#065f46', textTransform: 'uppercase' }}>Picco Minimo</div>
                                    <div style={{ fontSize: '24px', fontWeight: 800, color: '#059669', marginTop: '4px' }}>
                                        {statsHistory ? statsHistory.min_peak : 0}
                                    </div>
                                    <div style={{ fontSize: '10px', color: '#10b981', marginTop: '2px' }}>Min affluenza registrata</div>
                                </div>
                                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569', textTransform: 'uppercase' }}>Posti Attuali</div>
                                    <div style={{ fontSize: '24px', fontWeight: 800, color: '#0f172a', marginTop: '4px' }}>
                                        {stats.occupied_seats} / {stats.total_seats}
                                    </div>
                                    <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>{stats.free_seats} liberi al momento</div>
                                </div>
                            </div>

                            {/* Chart Container */}
                            <div style={{ background: '#fafafa', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '16px', marginBottom: '20px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                                    <div style={{ fontSize: '13px', fontWeight: 700, color: '#334155' }}>
                                        Curva d'Occupazione nel Tempo (Asse X: Tempo | Asse Y: Posti Occupati)
                                    </div>
                                    <div style={{ display: 'flex', gap: '12px', fontSize: '11px', fontWeight: 600 }}>
                                        <span style={{ color: '#dc2626' }}>🔴 Max Picco</span>
                                        <span style={{ color: '#059669' }}>🟢 Min Picco</span>
                                    </div>
                                </div>
                                <div style={{ height: '280px', width: '100%', position: 'relative' }}>
                                    <canvas id="occupancyChart" />
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer / Actions */}
                        <div style={{
                            padding: '16px 24px', borderTop: '1px solid #e2e8f0', background: '#f8fafc',
                            display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', justifyContent: 'space-between'
                        }}>
                            <button onClick={resetStatsHistory}
                                style={{
                                    background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca',
                                    borderRadius: '8px', padding: '9px 14px', fontSize: '13px', fontWeight: 600,
                                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                                }}>
                                🗑 Azzera statistiche
                            </button>

                            <div style={{ display: 'flex', gap: '10px' }}>
                                <button onClick={downloadJSONData}
                                    style={{
                                        background: 'white', color: '#334155', border: '1px solid #cbd5e1',
                                        borderRadius: '8px', padding: '9px 14px', fontSize: '13px', fontWeight: 600,
                                        cursor: 'pointer'
                                    }}>
                                    📄 Salva JSON
                                </button>
                                <button onClick={downloadPDFReport}
                                    style={{
                                        background: '#2563eb', color: 'white', border: 'none',
                                        borderRadius: '8px', padding: '9px 16px', fontSize: '13px', fontWeight: 700,
                                        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                                        boxShadow: '0 2px 4px rgba(37,99,235,0.25)'
                                    }}>
                                    📥 Salva Report PDF
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Mount ───────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

