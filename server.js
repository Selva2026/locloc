// Real-time GPS Tracking Backend & Live Map Dashboard
// Integrated with MongoDB Atlas & Local Persistent Storage Fallback
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const dns = require('dns');

// Fix SRV DNS resolution for MongoDB Atlas on Windows environments
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('DNS custom servers set warning:', e.message);
}

const mongoose = require('mongoose');
const LocationModel = require('./models/Location');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DATA_FILE = path.join(__dirname, 'data', 'locations.json');

// In-memory cache & state
let locationHistory = [];
let latestLocation = null;
const sseClients = new Set();
let isMongoConnected = false;
let mongoError = null;

// Detect Local Wi-Fi / LAN IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();

// Connect to MongoDB Atlas
async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.log('\x1b[33m[Database] No MONGODB_URI found. Running with local JSON storage.\x1b[0m');
    return;
  }

  try {
    console.log('[Database] Connecting to MongoDB Atlas...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 6000,
    });
    isMongoConnected = true;
    mongoError = null;
    console.log('\x1b[32m[Database] Connected successfully to MongoDB Atlas!\x1b[0m');

    // Populate initial memory cache from MongoDB
    const recent = await LocationModel.find().sort({ receivedAt: -1 }).limit(100).lean();
    if (recent.length > 0) {
      locationHistory = recent.reverse();
      latestLocation = locationHistory[locationHistory.length - 1];
      console.log(`[Database] Loaded ${locationHistory.length} recent coordinates from MongoDB.`);
    }
  } catch (err) {
    isMongoConnected = false;
    mongoError = err.message;
    console.error('\x1b[31m[Database] MongoDB connection failed:\x1b[0m', err.message);
    console.log('\x1b[33m[Database] Falling back to local file storage (data/locations.json).\x1b[0m');
    loadStoredLocations();
  }
}

// Fallback: Load stored locations from local JSON file
function loadStoredLocations() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      locationHistory = JSON.parse(data) || [];
      if (locationHistory.length > 0) {
        latestLocation = locationHistory[locationHistory.length - 1];
      }
      console.log(`[Local File] Loaded ${locationHistory.length} locations from local backup.`);
    }
  } catch (err) {
    console.error('[Local File] Failed to read backup file:', err.message);
  }
}

// Persist location history to local file (debounced backup)
let saveTimeout = null;
function persistLocations() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(locationHistory, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Local File] Error writing backup:', err.message);
    }
  }, 1000);
}

// Broadcast new location to all open Web Dashboards via SSE
function broadcastLocation(entry) {
  const message = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Global CORS & JSON headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, Accept');
}

// Parse incoming JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const parsed = body.trim() ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

// HTTP Request Handler
const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  // Handle preflight CORS OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // --- Route 1: Receive Location Updates ---
  if ((req.method === 'POST' || req.method === 'PUT') && pathname === '/api/location') {
    try {
      const payload = await parseJsonBody(req);

      // Validate required coordinates
      const coords = payload.coordinates;
      if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing coordinates with valid latitude and longitude' }));
        return;
      }

      const deviceId = payload.deviceId || 'DEV_UNKNOWN';
      const timestamp = payload.timestamp || new Date().toISOString();
      const speedKmH = coords.speed !== null && coords.speed !== undefined ? Math.round(coords.speed * 3.6 * 10) / 10 : 0;

      const record = {
        id: `loc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        deviceId,
        userId: payload.userId || null,
        timestamp,
        epoch: payload.epoch || Date.now(),
        coordinates: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy || 0,
          altitude: coords.altitude ?? null,
          altitudeAccuracy: coords.altitudeAccuracy ?? null,
          heading: coords.heading ?? null,
          speed: coords.speed ?? null,
          speedKmH,
        },
        geo: {
          type: 'Point',
          coordinates: [coords.longitude, coords.latitude],
        },
        metadata: payload.metadata || {},
        receivedAt: new Date().toISOString(),
      };

      // 1. Save to MongoDB if connected
      if (isMongoConnected) {
        LocationModel.create(record).catch((err) => {
          console.error('[MongoDB Save Error]:', err.message);
        });
      }

      // 2. Add to in-memory history & local file backup
      locationHistory.push(record);
      if (locationHistory.length > 1000) {
        locationHistory = locationHistory.slice(-1000);
      }
      latestLocation = record;
      persistLocations();

      // 3. Broadcast to live web dashboard
      broadcastLocation({ type: 'location', payload: record });

      // Print clean colorized terminal log
      const timeStr = new Date().toLocaleTimeString();
      const dbTag = isMongoConnected ? '\x1b[32m[MongoDB]\x1b[0m' : '\x1b[33m[File]\x1b[0m';
      console.log(`\x1b[32m[GPS PING ${timeStr}]\x1b[0m ${dbTag} \x1b[36m${deviceId}\x1b[0m -> Lat: \x1b[33m${coords.latitude.toFixed(6)}\x1b[0m, Lng: \x1b[33m${coords.longitude.toFixed(6)}\x1b[0m (Acc: ±${Math.round(coords.accuracy)}m, Speed: ${speedKmH} km/h)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          message: 'Location recorded successfully',
          id: record.id,
          deviceId: record.deviceId,
          storage: isMongoConnected ? 'mongodb' : 'local_file',
          receivedAt: record.receivedAt,
          totalPings: locationHistory.length,
        })
      );
    } catch (err) {
      console.error('[Error] Failed processing location:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Route 2: SSE Live Stream for Web Dashboard ---
  if (req.method === 'GET' && pathname === '/api/location/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', totalPoints: locationHistory.length, db: isMongoConnected ? 'MongoDB' : 'Local File' })}\n\n`);

    // Send latest location immediately on connect
    if (latestLocation) {
      res.write(`data: ${JSON.stringify({ type: 'location', payload: latestLocation })}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // --- Route 3: Get Latest Location ---
  if (req.method === 'GET' && pathname === '/api/location/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestLocation || { message: 'No location received yet' }));
    return;
  }

  // --- Route 4: Get Location History ---
  if (req.method === 'GET' && pathname === '/api/location/history') {
    const limit = parseInt(parsedUrl.query.limit) || 100;
    const deviceId = parsedUrl.query.deviceId;

    if (isMongoConnected) {
      try {
        const query = deviceId ? { deviceId } : {};
        const docs = await LocationModel.find(query).sort({ receivedAt: -1 }).limit(limit).lean();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: docs.length, storage: 'mongodb', locations: docs.reverse() }));
        return;
      } catch (err) {
        console.warn('MongoDB query fallback to memory:', err.message);
      }
    }

    // In-memory fallback
    let results = locationHistory;
    if (deviceId) {
      results = results.filter((r) => r.deviceId === deviceId);
    }
    results = results.slice(-limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        total: results.length,
        storage: 'local_file',
        locations: results,
      })
    );
    return;
  }

  // --- Route 5: Clear History ---
  if (req.method === 'DELETE' && pathname === '/api/location/history') {
    locationHistory = [];
    latestLocation = null;
    persistLocations();

    if (isMongoConnected) {
      await LocationModel.deleteMany({}).catch((e) => console.error(e));
    }

    broadcastLocation({ type: 'cleared' });

    console.log('\x1b[33m[Database] Location history was cleared.\x1b[0m');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'History cleared' }));
    return;
  }

  // --- Route 6: List Active Devices ---
  if (req.method === 'GET' && pathname === '/api/devices') {
    const devicesMap = {};
    for (const loc of locationHistory) {
      devicesMap[loc.deviceId] = {
        deviceId: loc.deviceId,
        userId: loc.userId,
        lastSeen: loc.receivedAt,
        latestCoords: loc.coordinates,
      };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.values(devicesMap)));
    return;
  }

  // --- Route 7: Server Status & Health Check ---
  if (req.method === 'GET' && pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'online',
        uptimeSeconds: Math.floor(process.uptime()),
        totalPings: locationHistory.length,
        connectedDashboards: sseClients.size,
        database: {
          type: isMongoConnected ? 'MongoDB Atlas' : 'Local File Storage',
          connected: isMongoConnected,
          error: mongoError,
        },
        localIp,
        endpoint: `http://${localIp}:${PORT}/api/location`,
      })
    );
    return;
  }

  // --- Route 8: Live Web Tracking Dashboard ---
  if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHtml(localIp, PORT));
    return;
  }

  // 404 Fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found', available: ['/', '/api/location', '/api/location/stream', '/api/status'] }));
});

// Embedded High-Precision Live Map Dashboard HTML
function getDashboardHtml(ip, port) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live GPS Tracker • Real-time Monitoring</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #f8fafc; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    
    header {
      background: #111827;
      padding: 12px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #1f2937;
      z-index: 1000;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .badge-icon { background: linear-gradient(135deg, #3b82f6, #06b6d4); color: white; padding: 6px 12px; border-radius: 8px; font-weight: 800; font-size: 13px; letter-spacing: 0.5px; }
    .header-titles h1 { font-size: 17px; font-weight: 700; }
    .header-titles p { font-size: 12px; color: #94a3b8; }

    .header-actions { display: flex; align-items: center; gap: 12px; }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #64748b; }
    .status-dot.active { background: #10b981; box-shadow: 0 0 10px #10b981; animation: pulse 1.5s infinite; }
    
    .db-badge {
      padding: 5px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      background: #065f46;
      color: #6ee7b7;
    }
    .db-badge.file {
      background: #78350f;
      color: #fde68a;
    }

    .copy-url-btn {
      background: #2563eb;
      color: white;
      border: none;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.2s;
    }
    .copy-url-btn:hover { background: #1d4ed8; }

    .main-wrap { display: flex; flex: 1; position: relative; height: calc(100vh - 65px); }
    #map { flex: 1; height: 100%; width: 100%; z-index: 1; background: #0f172a; }

    /* Overlay HUD Panel */
    .hud-panel {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 360px;
      max-width: 92vw;
      max-height: calc(100vh - 100px);
      overflow-y: auto;
      background: rgba(17, 24, 39, 0.94);
      backdrop-filter: blur(12px);
      border: 1px solid #374151;
      border-radius: 16px;
      padding: 16px;
      z-index: 1000;
      box-shadow: 0 16px 36px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .hud-title-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 700; color: #9ca3af; text-transform: uppercase; }
    .hud-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .hud-card { background: #1f2937; padding: 10px 12px; border-radius: 10px; border: 1px solid #374151; }
    .hud-card-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; }
    .hud-card-val { font-size: 15px; font-weight: 700; color: #38bdf8; font-family: monospace; margin-top: 2px; }

    .telemetry-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .tele-box { background: #1f2937; padding: 8px 4px; border-radius: 8px; text-align: center; border: 1px solid #374151; }
    .tele-val { font-size: 14px; font-weight: 700; color: #a7f3d0; }
    .tele-lbl { font-size: 10px; color: #9ca3af; text-transform: uppercase; }

    .url-banner {
      background: #0f172a;
      border: 1px dashed #3b82f6;
      border-radius: 10px;
      padding: 10px;
      font-size: 12px;
      word-break: break-all;
    }
    .url-banner strong { color: #60a5fa; display: block; margin-bottom: 4px; }
    .url-banner code { color: #38bdf8; font-family: monospace; font-size: 12px; }

    .btn-row { display: flex; gap: 8px; }
    .panel-btn {
      flex: 1;
      padding: 8px;
      background: #374151;
      border: 1px solid #4b5563;
      color: #f3f4f6;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .panel-btn:hover { background: #4b5563; }
    .panel-btn.danger { background: #7f1d1d; border-color: #991b1b; }
    .panel-btn.danger:hover { background: #991b1b; }

    /* Recent Points Table */
    .table-box { max-height: 160px; overflow-y: auto; background: #111827; border-radius: 8px; border: 1px solid #374151; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th { background: #1f2937; padding: 6px; text-align: left; color: #9ca3af; font-weight: 600; position: sticky; top: 0; }
    td { padding: 6px; border-bottom: 1px solid #1f2937; font-family: monospace; }

    /* Pulse marker styling */
    .pulsing-marker {
      width: 22px;
      height: 22px;
      background: #3b82f6;
      border: 3px solid #ffffff;
      border-radius: 50%;
      box-shadow: 0 0 14px rgba(59, 130, 246, 0.9);
      animation: pulse-ring 1.8s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 14px rgba(59, 130, 246, 0); }
      100% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
    }
    @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="badge-icon">LIVE GPS</div>
      <div class="header-titles">
        <h1>GPS Tracking Command Center</h1>
        <p>Receives background telemetry from Notes Stealth Mobile App</p>
      </div>
    </div>
    <div class="header-actions">
      <div class="status-badge">
        <span class="status-dot" id="liveDot"></span>
        <span id="connStatus">Waiting for connection...</span>
      </div>
      <span class="db-badge" id="dbBadge">Checking DB...</span>
      <button class="copy-url-btn" onclick="copyApiUrl()">📋 Copy App Endpoint</button>
    </div>
  </header>

  <div class="main-wrap">
    <div id="map"></div>

    <div class="hud-panel">
      <div class="hud-title-row">
        <span>Device Telemetry</span>
        <span id="pingCountBadge" style="color: #60a5fa;">0 Pings</span>
      </div>

      <div class="url-banner">
        <strong>Mobile App Target URL:</strong>
        <code id="endpointCode">http://${ip}:${port}/api/location</code>
      </div>

      <div class="hud-grid">
        <div class="hud-card">
          <div class="hud-card-label">Latitude</div>
          <div class="hud-card-val" id="latVal">--.------</div>
        </div>
        <div class="hud-card">
          <div class="hud-card-label">Longitude</div>
          <div class="hud-card-val" id="lngVal">--.------</div>
        </div>
      </div>

      <div class="telemetry-row">
        <div class="tele-box">
          <div class="tele-val" id="speedVal">0.0</div>
          <div class="tele-lbl">Speed (km/h)</div>
        </div>
        <div class="tele-box">
          <div class="tele-val" id="accVal">±0m</div>
          <div class="tele-lbl">Accuracy</div>
        </div>
        <div class="tele-box">
          <div class="tele-val" id="altVal">--</div>
          <div class="tele-lbl">Altitude</div>
        </div>
      </div>

      <div class="hud-card" style="padding: 8px 12px;">
        <div class="hud-card-label">Active Device</div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
          <span id="deviceVal" style="font-weight: 700; color: #facc15;">Waiting...</span>
          <span id="lastSeenVal" style="font-size: 11px; color: #9ca3af;">--:--:--</span>
        </div>
      </div>

      <div class="btn-row">
        <button class="panel-btn" onclick="recenterMap()">🎯 Center Map</button>
        <button class="panel-btn" onclick="toggleAutoPan()">📍 Follow: <span id="followState">ON</span></button>
        <button class="panel-btn danger" onclick="clearHistory()">🗑️ Clear</button>
      </div>

      <div class="hud-title-row" style="margin-top: 6px;">
        <span>Recent Coordinates</span>
      </div>
      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Latitude</th>
              <th>Longitude</th>
              <th>Acc</th>
            </tr>
          </thead>
          <tbody id="logsTable">
            <tr><td colspan="4" style="text-align: center; color: #6b7280; padding: 12px;">Waiting for first GPS ping...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const serverUrl = window.location.origin;
    let map = null;
    let marker = null;
    let accCircle = null;
    let polyline = null;
    let pathCoords = [];
    let autoPan = true;
    let totalPings = 0;

    function initMap() {
      const defaultCenter = [13.0827, 80.2707];
      map = L.map('map', { zoomControl: false }).setView(defaultCenter, 14);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);

      L.control.zoom({ position: 'bottomleft' }).addTo(map);

      const pulseIcon = L.divIcon({
        className: 'pulsing-marker',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });

      marker = L.marker(defaultCenter, { icon: pulseIcon }).addTo(map);
      accCircle = L.circle(defaultCenter, { radius: 10, color: '#3b82f6', fillOpacity: 0.15, weight: 1 }).addTo(map);

      polyline = L.polyline([], { color: '#38bdf8', weight: 4, opacity: 0.85, smoothFactor: 1 }).addTo(map);

      // Load initial past history from server
      fetch(serverUrl + '/api/location/history?limit=100')
        .then(r => r.json())
        .then(data => {
          if (data.storage === 'mongodb') {
            document.getElementById('dbBadge').innerText = 'MongoDB Atlas';
            document.getElementById('dbBadge').className = 'db-badge';
          } else {
            document.getElementById('dbBadge').innerText = 'Local Storage';
            document.getElementById('dbBadge').className = 'db-badge file';
          }

          if (data.locations && data.locations.length > 0) {
            data.locations.forEach(pt => addPointToMap(pt, false));
            const last = data.locations[data.locations.length - 1];
            updateHUD(last);
            map.setView([last.coordinates.latitude, last.coordinates.longitude], 16);
          }
        })
        .catch(err => console.log('History init:', err));
    }

    function addPointToMap(record, shouldPan = true) {
      const lat = record.coordinates.latitude;
      const lng = record.coordinates.longitude;
      const acc = record.coordinates.accuracy || 10;

      pathCoords.push([lat, lng]);
      polyline.setLatLngs(pathCoords);

      marker.setLatLng([lat, lng]);
      accCircle.setLatLng([lat, lng]);
      accCircle.setRadius(acc);

      if (autoPan && shouldPan) {
        map.panTo([lat, lng]);
      }

      totalPings++;
      document.getElementById('pingCountBadge').innerText = totalPings + ' Pings';
      appendTableRow(record);
    }

    function updateHUD(record) {
      const c = record.coordinates;
      document.getElementById('latVal').innerText = c.latitude.toFixed(6);
      document.getElementById('lngVal').innerText = c.longitude.toFixed(6);
      document.getElementById('speedVal').innerText = (c.speedKmH || 0).toFixed(1);
      document.getElementById('accVal').innerText = '±' + Math.round(c.accuracy) + 'm';
      document.getElementById('altVal').innerText = c.altitude !== null ? Math.round(c.altitude) + 'm' : '--';
      document.getElementById('deviceVal').innerText = record.deviceId || 'Phone';
      document.getElementById('lastSeenVal').innerText = new Date(record.receivedAt || Date.now()).toLocaleTimeString();
    }

    function appendTableRow(record) {
      const tbody = document.getElementById('logsTable');
      if (totalPings === 1) {
        tbody.innerHTML = '';
      }
      const time = new Date(record.receivedAt || Date.now()).toLocaleTimeString();
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td>\${time}</td>
        <td>\${record.coordinates.latitude.toFixed(5)}</td>
        <td>\${record.coordinates.longitude.toFixed(5)}</td>
        <td>±\${Math.round(record.coordinates.accuracy)}m</td>
      \`;
      tbody.insertBefore(tr, tbody.firstChild);
      while (tbody.children.length > 25) {
        tbody.removeChild(tbody.lastChild);
      }
    }

    function setupStream() {
      const liveDot = document.getElementById('liveDot');
      const connStatus = document.getElementById('connStatus');

      const sse = new EventSource(serverUrl + '/api/location/stream');

      sse.onopen = () => {
        liveDot.classList.add('active');
        connStatus.innerText = 'Connected & Listening';
      };

      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'location' && data.payload) {
            addPointToMap(data.payload, true);
            updateHUD(data.payload);
          } else if (data.type === 'cleared') {
            pathCoords = [];
            polyline.setLatLngs([]);
            totalPings = 0;
            document.getElementById('logsTable').innerHTML = '<tr><td colspan="4" style="text-align: center; color: #6b7280; padding: 12px;">Waiting for first GPS ping...</td></tr>';
            document.getElementById('pingCountBadge').innerText = '0 Pings';
          }
        } catch (e) {
          console.error('SSE Error:', e);
        }
      };

      sse.onerror = () => {
        liveDot.classList.remove('active');
        connStatus.innerText = 'Reconnecting...';
      };
    }

    function recenterMap() {
      if (marker) {
        map.setView(marker.getLatLng(), 17);
      }
    }

    function toggleAutoPan() {
      autoPan = !autoPan;
      document.getElementById('followState').innerText = autoPan ? 'ON' : 'OFF';
    }

    function copyApiUrl() {
      const urlText = document.getElementById('endpointCode').innerText;
      navigator.clipboard.writeText(urlText).then(() => {
        alert('Endpoint URL copied to clipboard:\\n' + urlText);
      });
    }

    function clearHistory() {
      if (confirm('Clear all location history from server?')) {
        fetch(serverUrl + '/api/location/history', { method: 'DELETE' });
      }
    }

    window.onload = () => {
      initMap();
      setupStream();
    };
  </script>
</body>
</html>`;
}

// Start Server & Connect Database
(async () => {
  await connectMongoDB();

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n======================================================');
    console.log('🚀 \x1b[1m\x1b[32mGPS TRACKING BACKEND SERVER RUNNING\x1b[0m');
    console.log('======================================================');
    console.log(`🌐 \x1b[36mWeb Dashboard:\x1b[0m       http://localhost:${PORT}`);
    console.log(`📱 \x1b[33mMobile App Endpoint:\x1b[0m http://${localIp}:${PORT}/api/location`);
    console.log(`📡 \x1b[35mSSE Live Stream:\x1b[0m     http://${localIp}:${PORT}/api/location/stream`);
    console.log(`🗄️  \x1b[35mDatabase:\x1b[0m            ${isMongoConnected ? 'MongoDB Atlas (Connected)' : 'Local File Storage (data/locations.json)'}`);
    console.log('======================================================\n');
  });
})();
