import React, { useEffect, useState, useCallback } from 'react'
import { checkProxy } from '../data/fetchStatus'

const PROXY_URL = 'http://127.0.0.1:9876'

function formatUptime(launchTime) {
  const launched = new Date(launchTime)
  const diff = Date.now() - launched.getTime()
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h ago`
  const mins = Math.floor((diff % 3600000) / 60000)
  return `${hours}h ${mins}m ago`
}

const styles = {
  overlay: {
    position: 'fixed', bottom: 20, left: 20, right: 20,
    pointerEvents: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    fontFamily: 'monospace', color: '#aaccff', fontSize: 12,
  },
  panel: {
    background: 'rgba(10,10,20,0.9)', border: '1px solid #334466',
    borderRadius: 6, padding: '12px 16px', pointerEvents: 'auto', maxWidth: '60vw',
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
  confirm: {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    background: 'rgba(10,10,20,0.95)', border: '1px solid #ff4444',
    borderRadius: 8, padding: '20px 28px', textAlign: 'center',
    fontFamily: 'monospace', color: '#ffcccc', fontSize: 14, pointerEvents: 'auto',
  },
  actions: { marginTop: 8, color: '#668899', fontSize: 11 },
}

export default function HUD({ selected, onClose, locked, pinned, viewMode }) {
  const [proxyInfo, setProxyInfo] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null) // { action: 'reboot'|'stop', instanceId, name }
  const [actionResult, setActionResult] = useState(null)

  useEffect(() => {
    checkProxy().then(info => setProxyInfo(info))
    const id = setInterval(() => checkProxy().then(info => setProxyInfo(info)), 10000)
    return () => clearInterval(id)
  }, [])

  // Keyboard shortcuts for EC2 actions
  useEffect(() => {
    const onKey = (e) => {
      if (confirmAction) {
        if (e.key === 'y' || e.key === 'Y') { executeAction(confirmAction); setConfirmAction(null) }
        if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') setConfirmAction(null)
        return
      }
      // Only trigger on pinned EC2 instances (have an instance ID starting with i-)
      if (!pinned || !pinned.id?.startsWith('i-')) return
      if (e.key === 'r') setConfirmAction({ action: 'reboot', instanceId: pinned.id, name: pinned.name })
      if (e.key === 's') setConfirmAction({ action: 'stop', instanceId: pinned.id, name: pinned.name })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned, confirmAction])

  const executeAction = useCallback(async ({ action, instanceId }) => {
    try {
      const res = await fetch(`${PROXY_URL}/api/ec2/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId }),
      })
      const data = await res.json()
      setActionResult(data.ok ? `✓ ${action} sent to ${instanceId}` : `✗ ${data.error}`)
      setTimeout(() => setActionResult(null), 5000)
      // Trigger fast polling so user sees state change
      if (data.ok && window.__aws3dFastPoll) window.__aws3dFastPoll()
    } catch (e) {
      setActionResult(`✗ ${e.message}`)
      setTimeout(() => setActionResult(null), 5000)
    }
  }, [])

  const connected = proxyInfo?.ok === true
  const expired = proxyInfo?.expired === true
  const loading = proxyInfo === null
  const isEc2 = pinned?.id?.startsWith('i-')

  return (
    <div style={styles.overlay}>
      {/* Connection status badge */}
      <div style={{
        ...styles.status,
        background: loading ? 'rgba(40,40,60,0.8)' : expired ? 'rgba(80,0,0,0.8)' : connected ? 'rgba(0,80,0,0.8)' : 'rgba(80,60,0,0.8)',
        border: `1px solid ${loading ? '#666688' : expired ? '#ff4444' : connected ? '#00cc44' : '#aa8800'}`,
        color: loading ? '#8888aa' : expired ? '#ff6666' : connected ? '#00ff66' : '#ffcc00',
      }}>
        {loading
          ? '◌ Connecting...'
          : expired
            ? '⚠ Credentials Expired — restart proxy with fresh creds'
            : connected
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
          WASD move · Mouse look · Q/E up/down · Shift sprint · N toggle view · ESC exit
          <div style={{ marginTop: 4, color: viewMode === 'subnet' ? '#43a047' : '#aaccff' }}>
            View: {viewMode === 'subnet' ? '🔌 Network (subnet)' : '📦 Role'}
          </div>
        </div>
      )}
      {locked && <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: '#66aaff', fontSize: 20, opacity: 0.5 }}>+</div>}

      {/* Confirmation dialog */}
      {confirmAction && (
        <div style={styles.confirm}>
          <div style={{ fontSize: 16, marginBottom: 8 }}>
            {confirmAction.action === 'reboot' ? '🔄 Reboot' : '⏹ Stop'} instance?
          </div>
          <div style={{ color: '#ffffff', marginBottom: 12 }}>{confirmAction.name}</div>
          <div style={{ color: '#888' }}>{confirmAction.instanceId}</div>
          <div style={{ marginTop: 16 }}>
            <span style={{ color: '#44ff44' }}>[Y]</span> Confirm &nbsp;&nbsp;
            <span style={{ color: '#ff4444' }}>[N]</span> Cancel
          </div>
        </div>
      )}

      {/* Action result toast */}
      {actionResult && (
        <div style={{ position: 'fixed', top: 50, left: '50%', transform: 'translateX(-50%)', ...styles.panel, border: '1px solid #448844' }}>
          {actionResult}
        </div>
      )}

      {/* Server info panel */}
      {selected && (
        <div style={styles.panel}>
          <div style={styles.title}>{selected.name}</div>
          {selected.type && <div style={styles.row}><span style={styles.label}>Type:</span><span>{selected.type}</span></div>}
          {selected.ip && <div style={styles.row}><span style={styles.label}>IP:</span><span>{selected.ip}</span></div>}
          {selected.endpoint && <div style={styles.row}><span style={styles.label}>Endpoint:</span><span>{selected.endpoint}</span></div>}
          {selected.dnsName && <div style={styles.row}><span style={styles.label}>DNS:</span><span>{selected.dnsName}</span></div>}
          <div style={styles.row}><span style={styles.label}>Status:</span><span>{selected.status}</span></div>
          {selected.checks && <div style={styles.row}><span style={styles.label}>Checks:</span><span>{selected.checks}</span></div>}
          {selected.subnet && <div style={styles.row}><span style={styles.label}>Subnet:</span><span>{selected.subnet}</span></div>}
          {selected.vpcId && <div style={styles.row}><span style={styles.label}>VPC:</span><span>{selected.vpcId}</span></div>}
          {selected.launchTime && <div style={styles.row}><span style={styles.label}>Launched:</span><span>{formatUptime(selected.launchTime)}</span></div>}
          {selected.volumes?.length > 0 && <div style={styles.row}><span style={styles.label}>Volumes:</span><span>{selected.volumes.map(v => `${v.device} ${v.size || '?'}GB ${v.type || ''}`).join(' · ')}</span></div>}
          {selected.id && <div style={styles.row}><span style={styles.label}>ID:</span><span>{selected.id}</span></div>}
          {isEc2 && connected && (
            <div style={styles.actions}>
              [R] Reboot · [S] Stop
            </div>
          )}
        </div>
      )}
    </div>
  )
}
