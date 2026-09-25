const { WebSocketServer, WebSocket } = require('ws')
const http = require('http')

const PORT = process.env.PORT || 8080
const HEARTBEAT_INTERVAL = 20000   // 20s ping to keep Render free tier alive
const STALE_THRESHOLD = 5000       // 5s without data = device stale

// In-memory state
let lastGoodFrame = null            // last validated frame from ESP32
let deviceSocket = null             // the one ESP32 connection
let deviceLastSeen = 0              // timestamp of last message from device
let dashboardClients = new Set()    // all connected dashboard tabs

// Create HTTP server (Render needs HTTP to assign a port)
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      deviceConnected: deviceSocket !== null,
      dashboardClients: dashboardClients.size,
      lastFrameAge: deviceLastSeen ? Date.now() - deviceLastSeen : null,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }))
    return
  }
  res.writeHead(404)
  res.end('Not found')
})

// Single WebSocketServer — differentiate by path
const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const path = req.url
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const now = () => new Date().toISOString()

  // ── DEVICE CONNECTION (/device) ──────────────────────────────────────────
  if (path === '/device') {
    console.log(`[${now()}] ESP32 connected from ${ip}`)

    // Only one device allowed. If another tries to connect, close old one.
    if (deviceSocket && deviceSocket.readyState === WebSocket.OPEN) {
      console.log(`[${now()}] Replacing existing device connection`)
      deviceSocket.close(1000, 'Replaced by new device connection')
    }

    deviceSocket = ws
    deviceLastSeen = Date.now()

    // Tell all dashboard clients the device is online
    broadcast({
      type: 'device_status',
      status: 'online',
      deviceId: 'RG-001',
      serverTime: Date.now()
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())

        // VALIDATE required fields
        if (!msg.flex || !Array.isArray(msg.flex) || msg.flex.length !== 5) {
          console.warn(`[${now()}] Invalid frame: missing or malformed flex array`)
          return
        }

        // Validate angle ranges (0–90 degrees)
        const flexValid = msg.flex.every(v => typeof v === 'number' && v >= 0 && v <= 90)
        if (!flexValid) {
          console.warn(`[${now()}] Invalid frame: flex values out of range`)
          return
        }

        // Build normalized frame
        const frame = {
          type: 'sensor_data',
          deviceId: msg.deviceId || 'RG-001',
          timestamp: msg.timestamp || Date.now(),
          serverTime: Date.now(),

          // Finger angles — the primary data
          flex: msg.flex,   // [index, middle, ring, pinky, thumb] in degrees 0-90

          // EMG — normalized 0-100
          emg: {
            value: (msg.emg?.value ?? 0)
          },

          // IMU — wrist motion
          imu: {
            ax: msg.imu?.ax ?? 0,
            ay: msg.imu?.ay ?? 0,
            az: msg.imu?.az ?? 1,
            gx: msg.imu?.gx ?? 0,
            gy: msg.imu?.gy ?? 0,
            gz: msg.imu?.gz ?? 0
          },

          // Battery
          battery: msg.battery ?? 100
        }

        // Store last good frame
        lastGoodFrame = frame
        deviceLastSeen = Date.now()

        // Broadcast to all dashboard clients
        broadcastToDashboards(frame)

      } catch (err) {
        console.error(`[${now()}] Parse error:`, err.message)
      }
    })

    ws.on('close', (code, reason) => {
      console.log(`[${now()}] ESP32 disconnected (${code}: ${reason})`)
      if (deviceSocket === ws) {
        deviceSocket = null
      }
      broadcast({
        type: 'device_status',
        status: 'offline',
        deviceId: 'RG-001',
        lastSeen: deviceLastSeen,
        serverTime: Date.now()
      })
    })

    ws.on('error', (err) => {
      console.error(`[${now()}] Device socket error:`, err.message)
    })

    // Send ping to keep ESP32 connection alive
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    return
  }

  // ── DASHBOARD CONNECTION (/ws) ───────────────────────────────────────────
  if (path === '/ws') {
    console.log(`[${now()}] Dashboard client connected from ${ip} (total: ${dashboardClients.size + 1})`)
    dashboardClients.add(ws)

    // Send current device status immediately on connect
    ws.send(JSON.stringify({
      type: 'device_status',
      status: deviceSocket && deviceSocket.readyState === WebSocket.OPEN ? 'online' : 'offline',
      deviceId: 'RG-001',
      serverTime: Date.now()
    }))

    // Send last known frame if available (dashboard gets immediate data)
    if (lastGoodFrame) {
      ws.send(JSON.stringify({
        ...lastGoodFrame,
        type: 'sensor_data_cached',
        serverTime: Date.now()
      }))
    }

    ws.on('close', () => {
      dashboardClients.delete(ws)
      console.log(`[${now()}] Dashboard client disconnected (remaining: ${dashboardClients.size})`)
    })

    ws.on('error', (err) => {
      console.error(`[${now()}] Dashboard socket error:`, err.message)
      dashboardClients.delete(ws)
    })

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    return
  }

  // Unknown path — reject
  console.warn(`[${now()}] Unknown path rejected: ${path} from ${ip}`)
  ws.close(1008, 'Unknown path. Use /device or /ws')
})

// ── BROADCAST HELPERS ────────────────────────────────────────────────────────

function broadcastToDashboards(data) {
  const payload = JSON.stringify(data)
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload)
    }
  }
}

function broadcast(data) {
  // Broadcast to dashboards AND device (e.g. server status messages)
  broadcastToDashboards(data)
}

// ── HEARTBEAT (keeps Render free tier alive + detects dead connections) ──────

const heartbeat = setInterval(() => {
  const now = new Date().toISOString()

  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log(`[${now}] Terminating dead connection`)
      return ws.terminate()
    }
    ws.isAlive = false
    ws.ping()
  })

  // Check if device has gone stale (connected but not sending)
  if (deviceSocket && deviceSocket.readyState === WebSocket.OPEN) {
    const age = Date.now() - deviceLastSeen
    if (age > STALE_THRESHOLD) {
      broadcastToDashboards({
        type: 'device_status',
        status: 'stale',
        staleMs: age,
        serverTime: Date.now()
      })
    }
  }
}, HEARTBEAT_INTERVAL)

wss.on('close', () => clearInterval(heartbeat))

// ── START ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`RehabGrip Relay Server running on port ${PORT}`)
  console.log(`  Device endpoint:    ws://localhost:${PORT}/device`)
  console.log(`  Dashboard endpoint: ws://localhost:${PORT}/ws`)
  console.log(`  Health check:       http://localhost:${PORT}/health`)
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err)
})
