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

export default function HUD({ selected, onClose, locked, pinned, viewMode, dataLoaded, fetching }) {
  const [proxyInfo, setProxyInfo] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null) // { action: 'reboot'|'stop', instanceId, name }
  const [actionResult, setActionResult] = useState(null)
  const [events, setEvents] = useState([])
  const [sgData, setSgData] = useState(null)
  const [naclData, setNaclData] = useState(null)
  useEffect(() => {
    checkProxy().then(info => setProxyInfo(info))
    const id = setInterval(() => checkProxy().then(info => setProxyInfo(info)), 10000)
    return () => clearInterval(id)
  }, [])

  // Fetch CloudTrail events when an EC2 instance is pinned
  useEffect(() => {
    setSgData(null)
    setNaclData(null)
    if (pinned?.id?.startsWith('i-')) {
      fetch(`${PROXY_URL}/api/ec2/events?id=${encodeURIComponent(pinned.id)}`)
        .then(r => r.json())
        .then(d => setEvents(d.events || []))
        .catch(() => setEvents([]))
    } else {
      setEvents([])
    }
  }, [pinned?.id])

  // Keyboard shortcuts for EC2 actions
  useEffect(() => {
    const onKey = (e) => {
      if (confirmAction) {
        if (e.key === 'y' || e.key === 'Y') { executeAction(confirmAction); setConfirmAction(null) }
        if (e.key === 'x' || e.key === 'X') setConfirmAction(null)
        return
      }
      // Only trigger on pinned EC2 instances (have an instance ID starting with i-)
      // Require Ctrl modifier to avoid conflict with WASD movement
      if (!pinned || !pinned.id?.startsWith('i-')) return
      if (!e.ctrlKey) return
      if (e.key === 'r') setConfirmAction({ action: 'reboot', instanceId: pinned.id, name: pinned.name })
      if (e.key === 's') {
        const action = pinned.status === 'down' ? 'start' : 'stop'
        setConfirmAction({ action, instanceId: pinned.id, name: pinned.name })
      }
      if (e.key === 'g') {
        e.preventDefault()
        if (sgData) { setSgData(null); return } // toggle off
        if (pinned.securityGroups?.length) {
          fetch(`${PROXY_URL}/api/ec2/sg?ids=${pinned.securityGroups.join(',')}`)
            .then(r => r.json())
            .then(d => { setSgData(d.groups || null); setNaclData(null) })
            .catch(() => {})
        }
      }
      if (e.key === 'n') {
        e.preventDefault()
        if (naclData) { setNaclData(null); return } // toggle off
        if (pinned.subnetId) {
          fetch(`${PROXY_URL}/api/ec2/nacl?subnet=${pinned.subnetId}`)
            .then(r => r.json())
            .then(d => { setNaclData(d.nacls || null); setSgData(null) })
            .catch(() => {})
        }
      }
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
  const loading = proxyInfo === null || (connected && !dataLoaded)
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
          ? '◌ Loading...'
          : expired
            ? '⚠ Credentials Expired — restart proxy with fresh creds'
            : connected
              ? `● Live — ${proxyInfo.profile} (${proxyInfo.region})`
              : '○ Sample Data'}
      </div>

      {/* Working spinner */}
      {fetching && (
        <div style={{ position: 'fixed', bottom: 16, right: 16, fontFamily: 'monospace', fontSize: 13, color: '#66aaff', pointerEvents: 'none', background: 'rgba(10,10,30,0.85)', padding: '6px 12px', borderRadius: 4, border: '1px solid #334466' }}>
          <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Fetching...
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

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
          WASD move · Mouse look · Q/E up/down · Shift sprint · V toggle view · ESC exit
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
            {confirmAction.action === 'reboot' ? '🔄 Reboot' : confirmAction.action === 'start' ? '▶ Start' : '⏹ Stop'} instance?
          </div>
          <div style={{ color: '#ffffff', marginBottom: 12 }}>{confirmAction.name}</div>
          <div style={{ color: '#888' }}>{confirmAction.instanceId}</div>
          <div style={{ marginTop: 16 }}>
            <span style={{ color: '#44ff44' }}>[Y]</span> Confirm &nbsp;&nbsp;
            <span style={{ color: '#ff4444' }}>[X]</span> Cancel
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
          <div style={styles.row}><span style={styles.label}>Status:</span><span>{selected.status === 'down' ? 'stopped' : selected.status}</span></div>
          {selected.checks && <div style={styles.row}><span style={styles.label}>Checks:</span><span>{selected.checks}</span></div>}
          {selected.subnet && <div style={styles.row}><span style={styles.label}>Subnet:</span><span>{selected.subnet}</span></div>}
          {selected.vpcId && <div style={styles.row}><span style={styles.label}>VPC:</span><span>{selected.vpcId}</span></div>}
          {selected.launchTime && <div style={styles.row}><span style={styles.label}>Launched:</span><span>{formatUptime(selected.launchTime)}</span></div>}
          {selected.volumes?.length > 0 && <div style={styles.row}><span style={styles.label}>Volumes:</span><span>{selected.volumes.map(v => `${v.device} ${v.size || '?'}GB ${v.type || ''}`).join(' · ')}</span></div>}
          {selected.id && <div style={styles.row}><span style={styles.label}>ID:</span><span>{selected.id}</span></div>}
          {isEc2 && connected && (
            <div style={styles.actions}>
              Ctrl+R Reboot · {selected.status === 'down' ? 'Ctrl+S Start' : 'Ctrl+S Stop'} · Ctrl+G SG · Ctrl+N NACL
            </div>
          )}
          {sgData && (
            <div style={{ marginTop: 6, borderTop: '1px solid #334466', paddingTop: 6 }}>
              {sgData.map(sg => (
                <div key={sg.id}>
                  <div style={{ color: '#66aaff', marginBottom: 4 }}>SG: {sg.id}</div>
                  {sg.inbound.map((r, i) => (
                    <div key={i} style={{ fontSize: 10, color: '#88ccaa', marginBottom: 2 }}>
                      {r.protocol === 'all' ? 'ALL' : `${r.protocol} :${r.fromPort}${r.toPort !== r.fromPort ? `-${r.toPort}` : ''}`} ← {r.sources.join(', ')}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {naclData && (
            <div style={{ marginTop: 6, borderTop: '1px solid #334466', paddingTop: 6 }}>
              {naclData.map(nacl => (
                <div key={nacl.id}>
                  <div style={{ color: '#66aaff', marginBottom: 4 }}>NACL: {nacl.id}</div>
                  {nacl.inbound.map((r, i) => (
                    <div key={i} style={{ fontSize: 10, color: r.action === 'allow' ? '#88ccaa' : '#ff8888', marginBottom: 2 }}>
                      #{r.rule} {r.action} {r.protocol === 'all' ? 'ALL' : `${r.protocol} :${r.fromPort || '*'}${r.toPort && r.toPort !== r.fromPort ? `-${r.toPort}` : ''}`} ← {r.cidr}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {events.length > 0 && (
            <div style={{ marginTop: 6, borderTop: '1px solid #334466', paddingTop: 6 }}>
              <div style={{ color: '#668899', marginBottom: 4 }}>Recent events:</div>
              {events.map((ev, i) => (
                <div key={i} style={{ fontSize: 10, color: '#8899aa', marginBottom: 2 }}>
                  {formatUptime(ev.time)} — {ev.name} ({ev.user})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
