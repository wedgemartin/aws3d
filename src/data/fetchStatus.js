/**
 * AWS Status Fetcher
 *
 * Tries to connect to the local aws3d proxy (127.0.0.1:9876).
 * If available, fetches real AWS data. Otherwise falls back to simulated data.
 */

import { ec2Servers, rdsInstances, eksCluster, mskCluster, managedServices, Status } from './infrastructure'

const PROXY_URL = 'http://127.0.0.1:9876'

let proxyAvailable = null // null = unknown, true/false after first check

export async function checkProxy() {
  try {
    const res = await fetch(`${PROXY_URL}/api/health`, { signal: AbortSignal.timeout(1000) })
    const data = await res.json()
    proxyAvailable = data.ok === true
    return data
  } catch {
    proxyAvailable = false
    return null
  }
}

export function isProxyAvailable() {
  return proxyAvailable
}

export async function fetchInfraStatus() {
  if (proxyAvailable === null) await checkProxy()

  if (proxyAvailable) {
    const res = await fetch(`${PROXY_URL}/api/status`)
    return res.json()
  }

  // Fallback: simulated status
  await new Promise(r => setTimeout(r, 300))
  return {
    ec2: simulateStatus(ec2Servers),
    rds: simulateStatus(rdsInstances),
    eks: [{ ...eksCluster, status: Math.random() > 0.95 ? 'degraded' : 'healthy' }],
    msk: [{ ...mskCluster, status: Math.random() > 0.95 ? 'degraded' : 'healthy' }],
    managed: simulateStatus(managedServices),
    ts: Date.now(),
    simulated: true,
  }
}

function simulateStatus(items) {
  return items.map(item => {
    const roll = Math.random()
    if (roll > 0.95) return { ...item, status: 'down' }
    if (roll > 0.88) return { ...item, status: 'degraded' }
    return { ...item, status: 'healthy' }
  })
}
