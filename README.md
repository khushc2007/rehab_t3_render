# RehabGrip Relay Server

WebSocket relay between ESP32-S3 glove and dashboard.

## Endpoints

| Path | Purpose |
|------|---------|
| `ws://.../device` | ESP32 connects here |
| `ws://.../ws` | Dashboard connects here |
| `http://.../health` | Health check (GET) |

## Deploy to Render

1. Push this folder to GitHub
2. New Web Service on Render → connect repo
3. Root directory: `server`
4. Build command: `npm install`
5. Start command: `npm start`
6. Copy the Render URL
7. Set in dashboard: `NEXT_PUBLIC_WS_URL=wss://your-app.onrender.com/ws`

## Message types dashboard receives

| type | Meaning |
|------|---------|
| `sensor_data` | Live frame from ESP32 |
| `sensor_data_cached` | Last frame sent on connect |
| `device_status` | online / offline / stale |

## Local test

```bash
npm start
# In another terminal, test with wscat:
npx wscat -c ws://localhost:8080/ws
```
