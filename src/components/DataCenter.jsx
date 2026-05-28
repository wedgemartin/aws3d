import React, { useState, useEffect, useCallback } from 'react'
import { azs as defaultAzs, ec2Servers as defaultEc2, rdsInstances as defaultRds, eksCluster as defaultEks, mskCluster as defaultMsk, categoryColors } from '../data/infrastructure'
import { fetchInfraStatus } from '../data/fetchStatus'
import Cage from './Cage'
import Rack from './Rack'
import Interconnect from './Interconnect'

// Layout constants
const CAGE_WIDTH = 40
const CAGE_DEPTH = 50
const CAGE_GAP = 8
const RACK_UNIT_WIDTH = 2.8
const MAX_PER_RACK = 12
const ROW_DEPTH = 10.5
const POLL_INTERVAL = 15000

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = typeof key === 'function' ? key(item) : item[key]
    ;(acc[k] = acc[k] || []).push(item)
    return acc
  }, {})
}

function guessRole(name) {
  if (!name) return 'other'
  const n = name.toLowerCase()
  // EKS managed nodes often have no Name tag — just instance ID
  if (n.startsWith('i-')) return 'eks-node'
  if (n.includes('eks') || n.includes('node')) return 'eks-node'
  if (n.includes('vpn') || n.includes('bastion')) return 'vpn'
  if (n.includes('mongo')) return 'mongodb'
  if (n.includes('redis') || n.includes('cache')) return 'cache'
  if (n.includes('kafka') || n.includes('msk')) return 'msk'
  if (n.includes('api')) return 'api'
  if (n.includes('worker') || n.includes('queue')) return 'worker'
  if (n.includes('monitor') || n.includes('log') || n.includes('prometheus') || n.includes('grafana')) return 'monitoring'
  if (n.includes('dns') || n.includes('pdns')) return 'dns'
  if (n.includes('mqtt') || n.includes('emqx')) return 'mqtt'
  if (n.includes('zk') || n.includes('zookeeper')) return 'zookeeper'
  return 'other'
}

export default function DataCenter({ onSelect, onPin, viewMode }) {
  const [ec2, setEc2] = useState(defaultEc2)
  const [rds, setRds] = useState(defaultRds)
  const [eks, setEks] = useState(defaultEks)
  const [msk, setMsk] = useState(defaultMsk)
  const [elbs, setElbs] = useState([])
  const [efsList, setEfsList] = useState([])
  const [subnets, setSubnets] = useState({})
  const [pinned, setPinned] = useState(null)
  const [elbTargets, setElbTargets] = useState([])
  const [loaded, setLoaded] = useState(false)

  const poll = useCallback(async () => {
    try {
      const data = await fetchInfraStatus()
      if (data.simulated) { setLoaded(true); return }

      const azSuffix = (az) => {
        if (!az) return 'az-a'
        return `az-${az.slice(-1)}`
      }

      if (data.ec2?.length) {
        setEc2(data.ec2.map(i => ({ ...i, az: azSuffix(i.az), role: i.role || guessRole(i.name) })))
      }
      if (data.rds?.length) {
        setRds(data.rds.map(r => ({ ...r, az: azSuffix(r.az) })))
      }
      if (data.eks?.length) setEks(prev => ({ ...prev, status: data.eks[0]?.status || prev.status, name: data.eks[0]?.name || prev.name }))
      if (data.msk?.length) setMsk(prev => ({ ...prev, status: data.msk[0]?.status || prev.status, name: data.msk[0]?.name || prev.name }))
      if (data.elb?.length) setElbs(data.elb.map(lb => ({ ...lb, az: azSuffix(lb.az) })))
      if (data.efs?.length) setEfsList(data.efs)
      if (data.subnets) setSubnets(data.subnets)
      setLoaded(true)
    } catch (e) {
      console.warn('Poll failed:', e.message)
    }
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_INTERVAL)

    // Expose fast-poll trigger for EC2 actions
    window.__aws3dFastPoll = () => {
      let count = 0
      const fast = setInterval(() => {
        poll()
        count++
        if (count >= 10) clearInterval(fast) // 10 polls × 3s = 30s of fast polling
      }, 3000)
    }

    return () => { clearInterval(id); delete window.__aws3dFastPoll }
  }, [poll])

  // Click handler: pin a node or clear pin
  const handleSelect = (data) => {
    if (data === null) {
      // hover out — only update HUD if nothing is pinned
      if (!pinned) onSelect(null)
      return
    }
    onSelect(data)
  }

  const handleClick = (data) => {
    if (pinned?.id === data.id) {
      setPinned(null)
      setElbTargets([])
      onSelect(null)
      onPin(null)
    } else {
      setPinned(data)
      onSelect(data)
      onPin(data)
      setElbTargets([])
      // If it's an ELB, fetch targets on-demand
      if (data.arn) {
        fetch(`http://127.0.0.1:9876/api/elb/targets?arn=${encodeURIComponent(data.arn)}`)
          .then(r => r.json())
          .then(d => { console.log('ELB targets:', d.targets?.length); setElbTargets(d.targets || []) })
          .catch(e => console.warn('ELB target fetch failed:', e))
      }
    }
  }

  // Click on empty space to clear pin
  const handleBgClick = (e) => {
    if (e.object?.userData?.isBackground) {
      setPinned(null)
      setElbTargets([])
      onSelect(null)
      onPin(null)
    }
  }

  const azPositions = { 'az-a': -CAGE_WIDTH / 2 - CAGE_GAP / 2, 'az-b': CAGE_WIDTH / 2 + CAGE_GAP / 2 }
  const serversByAz = groupBy(ec2, 'az')

  // Build RDS list including standby ghosts for Multi-AZ instances
  const rdsWithStandbys = []
  rds.forEach(r => {
    rdsWithStandbys.push(r)
    if (r.multiAz && r.secondaryAz) {
      const secondaryAzId = `az-${r.secondaryAz.slice(-1)}`
      rdsWithStandbys.push({
        ...r,
        id: `${r.id}-standby`,
        name: `${r.name} (standby)`,
        az: secondaryAzId,
        isStandby: true,
        primaryId: r.id,
      })
    }
  })
  const rdsByAz = groupBy(rdsWithStandbys, 'az')

  // Determine which cluster group the pinned node belongs to for interconnect
  const interconnectNodes = (() => {
    if (!pinned) return []
    const id = pinned.id
    // EKS nodes — all EKS items across AZs are siblings
    if (id.startsWith('eks-') || pinned.cluster === eks.name) {
      const eksNodeIds = ec2.filter(s => (s.role || guessRole(s.name)) === 'eks-node').map(s => s.id)
      if (eksNodeIds.length > 0) return eksNodeIds
      return eks.azs.map(az => `eks-${az}`)
    }
    // MSK brokers
    if (id.startsWith('msk-')) return msk.azs.map(az => `msk-${az}`)
    // RDS Multi-AZ — link primary to its standby
    const rdsItem = rds.find(r => r.id === id)
    if (rdsItem?.multiAz && rdsItem.secondaryAz) {
      const standbyId = `${id}-standby`
      return [id, standbyId]
    }
    // ELB → target instances
    if (pinned.arn && elbTargets.length > 0) {
      return [pinned.id, ...elbTargets.map(t => t.instanceId)]
    }
    return []
  })()

  // Rack positions registry for drawing interconnect lines
  const rackPositions = {}
  const registerRackPos = (id, worldPos) => { rackPositions[id] = worldPos }

  if (!loaded) return null

  return (
    <group>
      {/* Floor — clickable to clear pin */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.01, 0]}
        receiveShadow
        onClick={handleBgClick}
        userData={{ isBackground: true }}
      >
        <planeGeometry args={[120, 70]} />
        <meshStandardMaterial color="#0d0d1a" />
      </mesh>

      {/* AZ Cages */}
      {defaultAzs.map((az) => {
        const x = azPositions[az.id]
        const azServers = serversByAz[az.id] || []
        const azRds = rdsByAz[az.id] || []
        const serversByRole = groupBy(azServers.filter(s => s.role !== 'eks-node'), 'role')
        const roles = Object.keys(serversByRole)

        // Subnet grouping for network mode
        const nonEksServers = azServers.filter(s => s.role !== 'eks-node')
        const serversBySubnet = groupBy(nonEksServers, 'subnetId')
        const subnetKeys = Object.keys(serversBySubnet)

        // EKS items — use actual EC2 nodes if available, otherwise show cluster name
        const eksNodes = azServers.filter(s => s.role === 'eks-node')
        const eksItems = eks.azs.includes(az.id)
          ? eksNodes.length > 0
            ? eksNodes.map(n => ({ id: n.id, name: `${eks.name} (${n.ip})`, status: n.status, ip: n.ip, cluster: eks.name }))
            : [{ id: `eks-${az.id}`, name: eks.name, status: eks.status, cluster: eks.name }]
          : []

        // MSK items for this AZ
        const mskItems = msk.azs.includes(az.id) ? [{
          id: `msk-${az.id}`,
          name: msk.name,
          status: msk.status,
          cluster: msk.name,
        }] : []

        return (
          <group key={az.id} position={[x, 0, 0]}>
            <Cage width={CAGE_WIDTH} depth={CAGE_DEPTH} label={az.label} />

            {/* EKS rack */}
            {eksItems.length > 0 && (
              <Rack
                position={[-CAGE_WIDTH / 2 + 2, 0, -CAGE_DEPTH / 2 + 3]}
                label="EKS"
                color={categoryColors.eks.bright}
                darkColor={categoryColors.eks.dark}
                category="eks"
                items={eksItems}
                onSelect={handleSelect}
                onClick={handleClick}
                pinnedId={pinned?.id}
                highlightIds={interconnectNodes}
              />
            )}

            {/* MSK rack */}
            {mskItems.length > 0 && (
              <Rack
                position={[-CAGE_WIDTH / 2 + 2, 0, -CAGE_DEPTH / 2 + 7]}
                label="MSK"
                color={categoryColors.msk.bright}
                darkColor={categoryColors.msk.dark}
                category="msk"
                items={mskItems}
                onSelect={handleSelect}
                onClick={handleClick}
                pinnedId={pinned?.id}
                highlightIds={interconnectNodes}
              />
            )}

            {/* RDS rack */}
            {azRds.length > 0 && (
              <Rack
                position={[-CAGE_WIDTH / 2 + 2, 0, -CAGE_DEPTH / 2 + 11]}
                label="RDS"
                color={categoryColors.rds.bright}
                darkColor={categoryColors.rds.dark}
                category="rds"
                items={azRds.map((r) => ({
                  id: r.id,
                  name: `${r.name}${r.engine ? ` (${r.engine})` : ''}`,
                  status: r.isStandby ? 'unknown' : r.status,
                  isStandby: r.isStandby,
                  multiAz: r.multiAz,
                  endpoint: r.endpoint,
                }))}
                onSelect={handleSelect}
                onClick={handleClick}
                pinnedId={pinned?.id}
                highlightIds={interconnectNodes}
              />
            )}

            {/* EC2 racks — grouped by role or subnet depending on viewMode */}
            {(() => {
              const MAX_ROW_WIDTH = CAGE_WIDTH - 8
              let curX = -CAGE_WIDTH / 2 + 6
              let curZ = -CAGE_DEPTH / 2 + 3

              const groups = viewMode === 'subnet' ? subnetKeys : roles
              const getItems = (key) => viewMode === 'subnet' ? serversBySubnet[key] : serversByRole[key]
              const getLabel = (key) => {
                if (viewMode === 'subnet') {
                  const sub = subnets[key]
                  return sub ? (sub.name !== key ? sub.name : sub.cidr) : key?.slice(0, 12) || 'unknown'
                }
                return key
              }
              // Stable color per subnet for floor zones
              const subnetColor = (key, idx) => {
                if (viewMode !== 'subnet') return categoryColors.ec2.bright
                const hue = (idx * 137.5) % 360
                return `hsl(${hue}, 50%, 55%)`
              }
              const subnetDark = (key, idx) => {
                if (viewMode !== 'subnet') return categoryColors.ec2.dark
                const hue = (idx * 137.5) % 360
                return `hsl(${hue}, 30%, 15%)`
              }

              return groups.map((key, gi) => {
                const items = getItems(key)
                if (!items?.length) return null
                const count = items.length
                const rackCols = Math.min(Math.ceil(count / MAX_PER_RACK), 10)
                const rackWidth = rackCols * RACK_UNIT_WIDTH

                if (curX + rackWidth > -CAGE_WIDTH / 2 + 6 + MAX_ROW_WIDTH) {
                  curX = -CAGE_WIDTH / 2 + 6
                  curZ += ROW_DEPTH
                }

                const pos = [curX, 0, curZ]
                curX += rackWidth + 1

                return (
                  <group key={key}>
                    {/* Floor zone highlight in subnet mode */}
                    {viewMode === 'subnet' && (
                      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[pos[0] + rackWidth / 2 - RACK_UNIT_WIDTH / 2, 0.02, pos[2]]}>
                        <planeGeometry args={[rackWidth + 0.5, 4]} />
                        <meshStandardMaterial color={subnetDark(key, gi)} transparent opacity={0.4} />
                      </mesh>
                    )}
                    <Rack
                      position={pos}
                      label={getLabel(key)}
                      color={subnetColor(key, gi)}
                      darkColor={subnetDark(key, gi)}
                      category="ec2"
                      items={items.map((s) => ({
                        id: s.id, name: s.name, status: s.status, ip: s.ip,
                        type: s.type, launchTime: s.launchTime, checks: s.checks,
                        volumes: s.volumes, subnet: subnets[s.subnetId]?.cidr || s.subnetId, vpcId: s.vpcId,
                      }))}
                      onSelect={handleSelect}
                      onClick={handleClick}
                      pinnedId={pinned?.id}
                      highlightIds={interconnectNodes}
                    />
                  </group>
                )
              })
            })()}

            {/* EFS rack (AZ-A only since EFS is regional) */}
            {az.id === 'az-a' && efsList.length > 0 && (
              <Rack
                position={[CAGE_WIDTH / 2 - 3, 0, -CAGE_DEPTH / 2 + 3]}
                label="EFS"
                color={categoryColors.efs.bright}
                darkColor={categoryColors.efs.dark}
                category="efs"
                items={efsList.map((fs) => ({ id: fs.id, name: fs.name, status: fs.status }))}
                onSelect={handleSelect}
                onClick={handleClick}
                pinnedId={pinned?.id}
                highlightIds={interconnectNodes}
              />
            )}

            {/* ELB rack */}
            {az.id === 'az-a' && elbs.length > 0 && (
              <Rack
                position={[CAGE_WIDTH / 2 - 3, 0, -CAGE_DEPTH / 2 + 11]}
                label="ELB"
                color={categoryColors.network.bright}
                darkColor={categoryColors.network.dark}
                category="elb"
                items={elbs.map((lb) => ({ id: lb.id, name: `${lb.name} (${lb.type})`, status: lb.status, arn: lb.id, dnsName: lb.dnsName }))}
                onSelect={handleSelect}
                onClick={handleClick}
                pinnedId={pinned?.id}
                highlightIds={interconnectNodes}
              />
            )}
          </group>
        )
      })}

      {/* On-demand interconnect lines when a multi-AZ node is pinned */}
      {pinned && interconnectNodes.length > 1 && (() => {
        // Build position map for interconnect endpoints
        const positions = {
          'eks-az-a': [azPositions['az-a'] - CAGE_WIDTH / 2 + 2, 4, -CAGE_DEPTH / 2 + 3],
          'eks-az-b': [azPositions['az-b'] - CAGE_WIDTH / 2 + 2, 4, -CAGE_DEPTH / 2 + 3],
          'msk-az-a': [azPositions['az-a'] - CAGE_WIDTH / 2 + 2, 4, -CAGE_DEPTH / 2 + 7],
          'msk-az-b': [azPositions['az-b'] - CAGE_WIDTH / 2 + 2, 4, -CAGE_DEPTH / 2 + 7],
        }
        // RDS positions — primary and standby are in the RDS rack position per AZ
        rdsWithStandbys.forEach(r => {
          const azX = azPositions[r.az]
          positions[r.id] = [azX - CAGE_WIDTH / 2 + 2, 4, -CAGE_DEPTH / 2 + 11]
        })
        // EKS node positions
        ec2.filter(s => (s.role || guessRole(s.name)) === 'eks-node').forEach(s => {
          const azX = azPositions[s.az]
          positions[s.id] = [azX - CAGE_WIDTH / 2 + 2, 4, -CAGE_DEPTH / 2 + 3]
        })
        // ELB position (in AZ-A)
        elbs.forEach(lb => {
          positions[lb.id] = [azPositions['az-a'] + CAGE_WIDTH / 2 - 3, 4, -CAGE_DEPTH / 2 + 11]
        })
        // EC2 instance positions (approximate — center of their AZ)
        ec2.forEach(s => {
          if (!positions[s.id]) {
            const azX = azPositions[s.az] || azPositions['az-a']
            positions[s.id] = [azX, 4, 0]
          }
        })

        let color = categoryColors.eks.bright
        if (pinned.id.startsWith('msk')) color = categoryColors.msk.bright
        else if (rds.find(r => r.id === pinned.id)) color = categoryColors.rds.bright
        else if (pinned.arn) color = categoryColors.network.bright

        return (
          <Interconnect
            nodeIds={interconnectNodes}
            positions={positions}
            color={color}
          />
        )
      })()}
    </group>
  )
}
