import React, { useEffect, useState } from 'react'
import { checkProxy } from '../data/fetchStatus'

const styles = {
  overlay: {
    position: 'fixed', bottom: 20, left: 20, right: 20,
    pointerEvents: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    fontFamily: 'monospace', color: '#aaccff', fontSize: 12,
  },
  panel: {
    background: 'rgba(10,10,20,0.9)', border: '1px solid #334466',
    borderRadius: 6, padding: '12px 16px', pointerEvents: 'auto', maxWidth: 350,
  },
  title: { fontSize: 14, fontWeight: 'bold', color: '#66aaff', marginBottom: 6 },
  row: { display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 2 },
  label: { color: '#668899' },
  hint: { opacity: 0.5 },
  status: {
    position: 'fixed', top: 12, right: 12,
    fontFamily: 'monospace', fontSize: 11, padding: '6px 10px',
    borderRadius: 4, pointerEvents: 'none',
  },
}

export default function HUD({ selected, onClose, locked }) {
  const [proxyInfo, setProxyInfo] = useState(null)

  useEffect(() => {
    checkProxy().then(info => setProxyInfo(info))
    const id = setInterval(() => checkProxy().then(info => setProxyInfo(info)), 10000)
    return () => clearInterval(id)
  }, [])

  const connected = proxyInfo?.ok === true
  return (
    <div style={styles.overlay}>
      {/* Connection status badge */}
      <div style={{
        ...styles.status,
        background: connected ? 'rgba(0,80,0,0.8)' : 'rgba(80,60,0,0.8)',
        border: `1px solid ${connected ? '#00cc44' : '#aa8800'}`,
        color: connected ? '#00ff66' : '#ffcc00',
      }}>
        {connected
          ? `● Live — ${proxyInfo.profile} (${proxyInfo.region})`
          : '○ Sample Data'}
      </div>
      {!locked && (
        <div style={{ ...styles.panel, position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', fontSize: 14 }}>
          <div style={{ color: '#66aaff', fontSize: 18, marginBottom: 8 }}>Click to enter</div>
          <div>WASD — move · Mouse — look</div>
          <div>Q/E — down/up · Shift — sprint</div>
          <div>ESC — release cursor</div>
        </div>
      )}
      {locked && (
        <div style={{ position: 'fixed', top: 20, left: 20, ...styles.hint }}>
          WASD move · Mouse look · Q/E up/down · Shift sprint · ESC exit
        </div>
      )}
      {locked && <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: '#66aaff', fontSize: 20, opacity: 0.5 }}>+</div>}
      {selected && (
        <div style={styles.panel}>
          <div style={styles.title}>{selected.name}</div>
          {selected.ip && <div style={styles.row}><span style={styles.label}>IP:</span><span>{selected.ip}</span></div>}
          <div style={styles.row}><span style={styles.label}>Status:</span><span>{selected.status}</span></div>
          {selected.id && <div style={styles.row}><span style={styles.label}>ID:</span><span>{selected.id}</span></div>}
        </div>
      )}
    </div>
  )
}
