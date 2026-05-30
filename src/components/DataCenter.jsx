import React, { useState, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import { azs as defaultAzs, ec2Servers as defaultEc2, rdsInstances as defaultRds, eksCluster as defaultEks, mskCluster as defaultMsk, categoryColors } from '../data/infrastructure'
import { fetchInfraStatus } from '../data/fetchStatus'
import Cage from './Cage'
import Rack from './Rack'
import Interconnect from './Interconnect'

// Layout constants
const MIN_CAGE_WIDTH = 30
const MIN_CAGE_DEPTH = 30
const CAGE_GAP = 8
const RACK_UNIT_WIDTH = 2.8
const MAX_PER_RACK = 12
const RACK_GAP = 1
const ROW_GAP = 12  // generous space between rows
const MAX_RACKS_PER_ROW = 10
const POLL_INTERVAL = 15000

// Compute layout: place racks sequentially, wrap after MAX_RACKS_PER_ROW columns
function layoutRacks(groups, getItems) {
  const positions = []
  let col = 0
  let row = 0
  let maxX = 0

  for (const key of groups) {
    const items = getItems(key)
    if (!items?.length) continue
    const rackCols = Math.min(Math.ceil(items.length / MAX_PER_RACK), 10)
    const rackWidth = rackCols * RACK_UNIT_WIDTH

    if (col > 0 && col + rackCols > MAX_RACKS_PER_ROW) {
      col = 0
      row++
    }

    const x = col * (RACK_UNIT_WIDTH + RACK_GAP)
    const z = row * (ROW_GAP + 3)
    positions.push({ key, x, z, width: rackWidth })
    maxX = Math.max(maxX, x + rackWidth)
    col += rackCols
  }

  const totalWidth = maxX + 4
  const totalDepth = (row + 1) * (ROW_GAP + 3) + 4
  return { positions, totalWidth, totalDepth }
}

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

export default function DataCenter({ onSelect, onPin, viewMode, onLoaded, onFetching }) {
  const [ec2, setEc2] = useState(defaultEc2)
  const [rds, setRds] = useState(defaultRds)
  const [eks, setEks] = useState(defaultEks)
  const [msk, setMsk] = useState(defaultMsk)
  const [elbs, setElbs] = useState([])
  const [efsList, setEfsList] = useState([])
  const [subnets, setSubnets] = useState({})
  const [pinned, setPinned] = useState(null)
  const [elbTargets, setElbTargets] = useState([])
  const [elbPortGroups, setElbPortGroups] = useState([])
  const [loaded, setLoaded] = useState(false)

  const poll = useCallback(async () => {
    try {
      onFetching(true)
      const data = await fetchInfraStatus()
      if (data.simulated) { setLoaded(true); onLoaded(); onFetching(false); return }

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
      onLoaded()
      onFetching(false)
    } catch (e) {
      console.warn('Poll failed:', e.message)
      onFetching(false)
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
      setElbPortGroups([])
      onSelect(null)
      onPin(null)
    } else {
      setPinned(data)
      onSelect(data)
      onPin(data)
      setElbTargets([])
      setElbPortGroups([])
      // If it's an ELB, fetch targets on-demand
      if (data.arn) {
        onFetching(true)
        fetch(`http://127.0.0.1:9876/api/elb/targets?arn=${encodeURIComponent(data.arn)}`)
          .then(r => r.json())
          .then(d => { setElbTargets(d.targets || []); setElbPortGroups(d.portGroups || []); onFetching(false) })
          .catch(e => { console.warn('ELB target fetch failed:', e); onFetching(false) })
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

  const serversByAz = groupBy(ec2, 'az')

  // Build RDS list including standby ghosts for Multi-AZ instances
  const rdsWithStandbys = []
  rds.forEach(r => {
    rdsWithStandbys.push(r)
    if (r.multiAz && r.secondaryAz) {
      const secondaryAzId = `az-${r.secondaryAz.slice(-1)}`
      rdsWithStandbys.push({ ...r, id: `${r.id}-standby`, name: `${r.name} (standby)`, az: secondaryAzId, isStandby: true, primaryId: r.id })
    }
  })
  const rdsByAz = groupBy(rdsWithStandbys, 'az')

  // Compute dynamic cage size per AZ based on rack layout
  const cageSizes = {}
  for (const az of defaultAzs) {
    const azServers = serversByAz[az.id] || []
    const nonEks = azServers.filter(s => s.role !== 'eks-node')
    const groups = viewMode === 'subnet'
      ? Object.keys(groupBy(nonEks, 'subnetId'))
      : Object.keys(groupBy(nonEks, 'role'))
    const getItems = (key) => viewMode === 'subnet'
      ? groupBy(nonEks, 'subnetId')[key]
      : groupBy(nonEks, 'role')[key]

    // Count all racks: managed services + EC2
    let totalRackCount = groups.length
    if (eks.azs.includes(az.id)) totalRackCount++
    if (msk.azs.includes(az.id)) totalRackCount++
    if ((rdsByAz[az.id] || []).length > 0) totalRackCount++
    if (az.id === 'az-a' && elbs.length > 0) totalRackCount++
    if (az.id === 'az-a' && efsList.length > 0) totalRackCount++

    // Build a combined key list for layout calculation
    const allKeys = []
    if (eks.azs.includes(az.id)) allKeys.push('__eks')
    if (msk.azs.includes(az.id)) allKeys.push('__msk')
    if ((rdsByAz[az.id] || []).length > 0) allKeys.push('__rds')
    if (az.id === 'az-a' && efsList.length > 0) allKeys.push('__efs')
    if (az.id === 'az-a' && elbs.length > 0) allKeys.push('__elb')
    allKeys.push(...groups)

    const getAllItems = (key) => {
      if (key === '__eks') return [{ id: 'x' }]
      if (key === '__msk') return [{ id: 'x' }]
      if (key === '__rds') return rdsByAz[az.id]
      if (key === '__efs') return efsList
      if (key === '__elb') return elbs
      return getItems(key)
    }

    const layout = layoutRacks(allKeys, getAllItems)
    cageSizes[az.id] = { width: Math.max(MIN_CAGE_WIDTH, layout.totalWidth + 10), depth: Math.max(MIN_CAGE_DEPTH, layout.totalDepth + 10) }
  }

  // Position AZs side by side based on their individual widths
  const azAWidth = cageSizes['az-a']?.width || MIN_CAGE_WIDTH
  const azBWidth = cageSizes['az-b']?.width || MIN_CAGE_WIDTH
  const azPositions = {
    'az-a': -(azAWidth / 2 + CAGE_GAP / 2),
    'az-b': azBWidth / 2 + CAGE_GAP / 2,
  }



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
    // ELB → target instances (from port groups, not flat list)
    if (pinned.arn && elbPortGroups.length > 0) {
      const targetIds = elbPortGroups.flatMap(pg => pg.targets.map(t => t.instanceId)).filter(Boolean)
      return [...new Set(targetIds)]
    }
    if (pinned.arn && elbTargets.length > 0) {
      return [...new Set(elbTargets.map(t => t.instanceId).filter(Boolean))]
    }
    return []
  })()

  // Build per-instance highlight colors from ELB port groups
  const portColors = ['#00ff88', '#ff6644', '#44aaff', '#ffcc00', '#cc44ff', '#44ffcc', '#ff44aa', '#88ff44']
  const highlightColors = {}
  if (pinned?.arn && elbPortGroups.length > 0) {
    elbPortGroups.filter(pg => pg.targets.length > 0).forEach((pg, i) => {
      const color = portColors[i % portColors.length]
      pg.targets.forEach(t => { highlightColors[t.instanceId] = color })
    })
  }

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
        <planeGeometry args={[azAWidth + azBWidth + CAGE_GAP + 20, Math.max(cageSizes['az-a']?.depth || MIN_CAGE_DEPTH, cageSizes['az-b']?.depth || MIN_CAGE_DEPTH) + 20]} />
        <meshStandardMaterial color="#0d0d1a" />
      </mesh>

      {/* AZ Cages */}
      {defaultAzs.map((az) => {
        const x = azPositions[az.id]
        const CAGE_WIDTH = cageSizes[az.id]?.width || MIN_CAGE_WIDTH
        const CAGE_DEPTH = cageSizes[az.id]?.depth || MIN_CAGE_DEPTH
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

            {/* VPC floor zones */}
            {(() => {
              const vpcIds = [...new Set(azServers.map(s => s.vpcId).filter(Boolean))]
              const vpcCount = vpcIds.length
              if (vpcCount === 0) return null
              const zoneWidth = (CAGE_WIDTH - 2) / vpcCount
              return vpcIds.map((vpcId, vi) => {
                const hue = (vi * 220) % 360
                const isNetMode = viewMode === 'subnet'
                return (
                  <group key={vpcId}>
                    {/* Floor zone */}
                    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[
                      -CAGE_WIDTH / 2 + 1 + zoneWidth * vi + zoneWidth / 2,
                      0.03,
                      0
                    ]}>
                      <planeGeometry args={[zoneWidth - 0.5, CAGE_DEPTH - 2]} />
                      <meshStandardMaterial
                        color={`hsl(${hue}, 40%, 12%)`}
                        transparent
                        opacity={isNetMode ? 0.6 : 0.2}
                      />
                    </mesh>
                    {/* VPC border */}
                    <lineSegments position={[
                      -CAGE_WIDTH / 2 + 1 + zoneWidth * vi + zoneWidth / 2,
                      0.04,
                      0
                    ]} rotation={[-Math.PI / 2, 0, 0]}>
                      <edgesGeometry args={[new THREE.PlaneGeometry(zoneWidth - 0.5, CAGE_DEPTH - 2)]} />
                      <lineBasicMaterial color={`hsl(${hue}, 50%, ${isNetMode ? 45 : 25}%)`} />
                    </lineSegments>
                    {/* VPC label on floor — front */}
                    <Text
                      rotation={[-Math.PI / 2, 0, 0]}
                      position={[
                        -CAGE_WIDTH / 2 + 1 + zoneWidth * vi + zoneWidth / 2,
                        0.05,
                        -CAGE_DEPTH / 2 + 2
                      ]}
                      fontSize={isNetMode ? 0.8 : 0.5}
                      color={`hsl(${hue}, 50%, ${isNetMode ? 55 : 30}%)`}
                      anchorX="center"
                    >
                      {vpcId.slice(0, 12)}
                    </Text>
                    {/* VPC label on floor — back */}
                    <Text
                      rotation={[-Math.PI / 2, 0, 0]}
                      position={[
                        -CAGE_WIDTH / 2 + 1 + zoneWidth * vi + zoneWidth / 2,
                        0.05,
                        CAGE_DEPTH / 2 - 2
                      ]}
                      fontSize={isNetMode ? 0.8 : 0.5}
                      color={`hsl(${hue}, 50%, ${isNetMode ? 55 : 30}%)`}
                      anchorX="center"
                    >
                      {vpcId.slice(0, 12)}
                    </Text>
                  </group>
                )
              })
            })()}

            {/* EKS rack */}
            {/* MSK rack */}
            {/* RDS rack */}
            {/* EC2 racks */}
            {/* EFS rack */}
            {/* ELB rack */}
            {/* === ALL RACKS UNIFIED LAYOUT === */}
            {(() => {
              // Build a single list of all rack definitions for this AZ
              const allRacks = []

              if (eksItems.length > 0) {
                allRacks.push({ key: 'eks', label: 'EKS', color: categoryColors.eks.bright, darkColor: categoryColors.eks.dark, category: 'eks', items: eksItems })
              }
              if (mskItems.length > 0) {
                allRacks.push({ key: 'msk', label: 'MSK', color: categoryColors.msk.bright, darkColor: categoryColors.msk.dark, category: 'msk', items: mskItems })
              }
              if (azRds.length > 0) {
                allRacks.push({ key: 'rds', label: 'RDS', color: categoryColors.rds.bright, darkColor: categoryColors.rds.dark, category: 'rds', items: azRds.map(r => ({ id: r.id, name: `${r.name}${r.engine ? ` (${r.engine})` : ''}`, status: r.isStandby ? 'unknown' : r.status, isStandby: r.isStandby, multiAz: r.multiAz, endpoint: r.endpoint })) })
              }
              if (az.id === 'az-a' && efsList.length > 0) {
                allRacks.push({ key: 'efs', label: 'EFS', color: categoryColors.efs.bright, darkColor: categoryColors.efs.dark, category: 'efs', items: efsList.map(fs => ({ id: fs.id, name: fs.name, status: fs.status })) })
              }
              if (az.id === 'az-a' && elbs.length > 0) {
                allRacks.push({ key: 'elb', label: 'ELB', color: categoryColors.network.bright, darkColor: categoryColors.network.dark, category: 'elb', items: elbs.map(lb => { const t = lb.type === 'application' ? 'ALB' : lb.type === 'network' ? 'NLB' : 'CLB'; return { id: lb.id, name: `${lb.name} (${t})`, status: lb.status, arn: lb.id, dnsName: lb.dnsName } }) })
              }

              // EC2 racks by role or subnet
              const groups = viewMode === 'subnet' ? subnetKeys : roles
              const getItems = (key) => viewMode === 'subnet' ? serversBySubnet[key] : serversByRole[key]
              const getLabel = (key) => {
                if (viewMode === 'subnet') {
                  const sub = subnets[key]
                  return sub ? (sub.name !== key ? sub.name : sub.cidr) : key?.slice(0, 12) || 'unknown'
                }
                return key
              }
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

              for (const key of groups) {
                const items = getItems(key)
                if (!items?.length) continue
                allRacks.push({ key, label: getLabel(key), color: subnetColor(key, allRacks.length), darkColor: subnetDark(key, allRacks.length), category: 'ec2', items: items.map(s => ({ id: s.id, name: s.name, status: s.status, ip: s.ip, type: s.type, launchTime: s.launchTime, checks: s.checks, volumes: s.volumes, subnet: subnets[s.subnetId]?.cidr || s.subnetId, vpcId: s.vpcId })) })
              }

              // Layout all racks through the same engine
              const layout = layoutRacks(allRacks.map(r => r.key), (key) => allRacks.find(r => r.key === key)?.items)
              const offsetX = -CAGE_WIDTH / 2 + 4
              const offsetZ = -CAGE_DEPTH / 2 + 4

              return layout.positions.map((lp, i) => {
                const rack = allRacks.find(r => r.key === lp.key)
                if (!rack) return null
                const pos = [offsetX + lp.x, 0, offsetZ + lp.z]
                return (
                  <Rack
                    key={rack.key}
                    position={pos}
                    label={rack.label}
                    color={rack.color}
                    darkColor={rack.darkColor}
                    category={rack.category}
                    items={rack.items}
                    onSelect={handleSelect}
                    onClick={handleClick}
                    pinnedId={pinned?.id}
                    highlightIds={interconnectNodes}
                    highlightColors={highlightColors}
                  />
                )
              })
            })()}
          </group>
        )
      })}

      {/* On-demand interconnect lines when a multi-AZ node is pinned */}
      {pinned && interconnectNodes.length > 1 && (() => {
        // Build position map for interconnect endpoints
        const cwA = cageSizes['az-a']?.width || MIN_CAGE_WIDTH
        const cwB = cageSizes['az-b']?.width || MIN_CAGE_WIDTH
        const cdA = cageSizes['az-a']?.depth || MIN_CAGE_DEPTH
        const cdB = cageSizes['az-b']?.depth || MIN_CAGE_DEPTH
        const positions = {
          'eks-az-a': [azPositions['az-a'] - cwA / 2 + 4, 4, -cdA / 2 + 4],
          'eks-az-b': [azPositions['az-b'] - cwB / 2 + 4, 4, -cdB / 2 + 4],
          'msk-az-a': [azPositions['az-a'] - cwA / 2 + 4, 4, -cdA / 2 + 8],
          'msk-az-b': [azPositions['az-b'] - cwB / 2 + 4, 4, -cdB / 2 + 8],
        }
        rdsWithStandbys.forEach(r => {
          const azX = azPositions[r.az]
          const cw = cageSizes[r.az]?.width || MIN_CAGE_WIDTH
          const cd = cageSizes[r.az]?.depth || MIN_CAGE_DEPTH
          positions[r.id] = [azX - cw / 2 + 4, 4, -cd / 2 + 12]
        })
        ec2.filter(s => (s.role || guessRole(s.name)) === 'eks-node').forEach(s => {
          const azX = azPositions[s.az]
          const cw = cageSizes[s.az]?.width || MIN_CAGE_WIDTH
          const cd = cageSizes[s.az]?.depth || MIN_CAGE_DEPTH
          positions[s.id] = [azX - cw / 2 + 4, 4, -cd / 2 + 4]
        })
        elbs.forEach(lb => {
          positions[lb.id] = [azPositions['az-a'], 4, 0]
        })
        ec2.forEach(s => {
          if (!positions[s.id]) {
            const azX = azPositions[s.az] || azPositions['az-a']
            positions[s.id] = [azX, 4, 0]
          }
        })

        // For ELBs with port groups, show floating labels above the actual ELB rack
        if (pinned.arn && elbPortGroups.length > 0) {
          const portColors = ['#00ff88', '#ff6644', '#44aaff', '#ffcc00', '#cc44ff', '#44ffcc', '#ff44aa', '#88ff44']
          // Compute ELB rack position from the AZ-A layout
          const azAServers = serversByAz['az-a'] || []
          const nonEksA = azAServers.filter(s => s.role !== 'eks-node')
          const groupsA = viewMode === 'subnet' ? Object.keys(groupBy(nonEksA, 'subnetId')) : Object.keys(groupBy(nonEksA, 'role'))
          const getItemsA = (key) => {
            if (key === '__eks' || key === '__msk') return [{ id: 'x' }]
            if (key === '__rds') return rdsByAz['az-a'] || []
            if (key === '__efs') return efsList
            if (key === '__elb') return elbs
            return viewMode === 'subnet' ? groupBy(nonEksA, 'subnetId')[key] : groupBy(nonEksA, 'role')[key]
          }
          const allKeysA = []
          if (eks.azs.includes('az-a')) allKeysA.push('__eks')
          if (msk.azs.includes('az-a')) allKeysA.push('__msk')
          if ((rdsByAz['az-a'] || []).length > 0) allKeysA.push('__rds')
          if (efsList.length > 0) allKeysA.push('__efs')
          if (elbs.length > 0) allKeysA.push('__elb')
          allKeysA.push(...groupsA)
          const layoutA = layoutRacks(allKeysA, getItemsA)
          const elbLayout = layoutA.positions.find(p => p.key === '__elb')
          const cwA = cageSizes['az-a']?.width || MIN_CAGE_WIDTH
          const cdA = cageSizes['az-a']?.depth || MIN_CAGE_DEPTH
          const elbX = azPositions['az-a'] + (-cwA / 2 + 4) + (elbLayout?.x || 0)
          const elbZ = (-cdA / 2 + 4) + (elbLayout?.z || 0)
          const labelStartY = 9 // just above tallest rack

          return (
            <group>
              {/* Floating port labels above ELB rack */}
              {elbPortGroups.filter(pg => pg.targets.length > 0).map((pg, i) => (
                <Text
                  key={i}
                  position={[elbX, labelStartY + i * 1.0, elbZ]}
                  fontSize={0.35}
                  color={portColors[i % portColors.length]}
                  anchorX="center"
                  outlineWidth={0.02}
                  outlineColor="#000000"
                >
                  :{pg.listenerPort} {pg.path} → {pg.targetGroup}{pg.targetPort ? ` (:${pg.targetPort})` : ''}
                </Text>
              ))}
            </group>
          )
        }

        // Non-ELB interconnects (EKS, MSK, RDS)
        let color = categoryColors.eks.bright
        if (pinned.id.startsWith('msk')) color = categoryColors.msk.bright
        else if (rds.find(r => r.id === pinned.id)) color = categoryColors.rds.bright

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
