// hooks/useWebSocket.ts
// Parses the nested frame format sent by the RehabGrip relay server.
// Drop the relevant message-handling block below into your existing
// WebSocket onmessage handler (wherever sensorRef / useHand are set up).

import { useHand } from '@/store/useHand' // adjust path to your actual store

// Shape of frames coming from the relay server
type DeviceStatusMsg = {
  type: 'device_status'
  status: 'online' | 'offline' | 'stale'
  deviceId?: string
  serverTime: number
  lastSeen?: number
  staleMs?: number
}

type SensorDataMsg = {
  type: 'sensor_data' | 'sensor_data_cached'
  deviceId: string
  timestamp: number
  serverTime: number
  flex: number[] // [index, middle, ring, pinky, thumb] in degrees 0-90
  emg: { value: number }
  imu: { ax: number; ay: number; az: number; gx: number; gy: number; gz: number }
  battery: number
}

type RelayMsg = DeviceStatusMsg | SensorDataMsg

export function handleRelayMessage(msg: RelayMsg, sensorRef: React.MutableRefObject<any>, updateIMU: (imu: SensorDataMsg['imu']) => void) {
  if (msg.type === 'sensor_data' || msg.type === 'sensor_data_cached') {
    // write to sensorRef (high-frequency, avoid triggering React re-render)
    sensorRef.current.f = msg.flex
    sensorRef.current.e = msg.emg.value
    sensorRef.current.t = msg.timestamp
    sensorRef.current.bat = msg.battery

    // IMU → complementary filter for pitch/roll → sensorRef (existing logic)
    updateIMU(msg.imu)

    // Update store battery only on live frames (triggers React re-render — intentional)
    if (msg.type === 'sensor_data') {
      useHand.getState().set({ battery: msg.battery })
    }
  }

  if (msg.type === 'device_status') {
    useHand.getState().set({ connected: msg.status === 'online' })
  }
}
