# 🛰️ GPS Tracking Backend & Live Web Dashboard

Node.js backend server designed to receive real-time location pings from the **Notes** stealth mobile app and display live movements on an interactive OpenStreetMap dashboard.

---

## ⚡ Quick Start

### 1. Start the Server
```bash
cd D:\Muthu\AppForLoc2\backend
node server.js
# or
npm start
```

### 2. Access the Command Center
- **Live Web Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Mobile App Endpoint**: `http://192.168.1.25:3000/api/location`
- **SSE Live Stream**: `http://192.168.1.25:3000/api/location/stream`

*(Note: Replace `192.168.1.25` with your computer's Wi-Fi IP address if it changes).*

---

## 📱 Mobile App Setup

In your mobile app (`Notes`):
1. **Triple-tap** the **"Notes"** title on the header (or click the subtle Cloud Sync icon).
2. Set **API Target Endpoint** to:
   ```
   http://192.168.1.25:3000/api/location
   ```
3. Set **HTTP Method** to `POST`.
4. Click **Apply Settings** and **Test Endpoint**.
5. Once saved, every 15 seconds the phone will silently send its GPS coordinates and you will see the marker move live on your computer screen at [http://localhost:3000](http://localhost:3000)!

---

## 🔌 REST API Endpoints

### 1. `POST /api/location`
Receives device coordinates and broadcasts them to all open dashboards.
- **Headers**: `Content-Type: application/json`
- **Sample Request**:
```json
{
  "deviceId": "DEV_X9F2A1",
  "userId": "driver-01",
  "timestamp": "2026-11-19T10:15:30.123Z",
  "coordinates": {
    "latitude": 13.082680,
    "longitude": 80.270718,
    "accuracy": 8.5,
    "altitude": 14.2,
    "speed": 6.8
  }
}
```
- **Response** (HTTP 200):
```json
{
  "success": true,
  "message": "Location recorded successfully",
  "id": "loc_1795083301165_i2kku",
  "totalPings": 1
}
```

### 2. `GET /api/location/latest`
Returns the most recent location received by the server.

### 3. `GET /api/location/history?limit=100`
Returns recent location history array.

### 4. `DELETE /api/location/history`
Clears stored location points.

### 5. `GET /api/location/stream`
Server-Sent Events (SSE) stream for real-time frontend push.

### 6. `GET /api/status`
Server health, uptime, and connected clients.

---

## 💾 Data Persistence
All received coordinates are automatically saved to `backend/data/locations.json`, so your route history is retained even if the server is restarted.
