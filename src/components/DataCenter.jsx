import React, { useState, useEffect, useCallback, useRef } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import { azs as defaultAzs, ec2Servers as defaultEc2, rdsInstances as defaultRds, eksCluster as defaultEks, mskCluster as defaultMsk, categoryColors } from '../data/infrastructure'
import { fetchInfraStatus, fetchVpcPeering } from '../data/fetchStatus'
import Cage from './Cage'
import Rack from './Rack'
import Interconnect from './Interconnect'
import EksMezzanine from './EksMezzanine'

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
const REGION_GAP = 20

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

const azSuffix = (az) => {
  if (!az) return 'az-a'
  return `az-${az.slice(-1)}`
}

// Process a single region's raw data into the format needed for rendering
function processRegionData(data) {
  const ec2 = (data.ec2 || []).map(i => ({ ...i, az: azSuffix(i.az), role: i.role || guessRole(i.name) }))
  const rds = (data.rds || []).map(r => ({ ...r, az: azSuffix(r.az) }))

  let eks = { id: null, name: '', azs: [], status: 'down' }
  if (data.eks?.length) {
    const eksNodeAzs = ec2.filter(i => guessRole(i.name) === 'eks-node').map(i => i.az)
    const azList = eksNodeAzs.length > 0 ? [...new Set(eksNodeAzs)] : ['az-a']
    eks = { status: data.eks[0]?.status || 'healthy', name: data.eks[0]?.name || '', azs: azList }
  }

  let msk = { id: null, name: '', azs: [], status: 'down' }
  if (data.msk?.length) {
    msk = { status: data.msk[0]?.status || 'healthy', name: data.msk[0]?.name || '', azs: data.msk[0]?.azs || [] }
  }

  const elbs = (data.elb || []).map(lb => ({ ...lb, az: azSuffix(lb.az) }))
  const efs = data.efs || []
  const opensearch = (data.opensearch || []).map(d => ({ id: d.id, name: d.name, status: d.status, version: d.version, instanceType: d.instanceType }))
  const aurora = (data.aurora || []).map(c => ({ ...c, az: azSuffix(c.az) }))
  const subnets = data.subnets || {}

  return { ec2, rds, eks, msk, elbs, efs, opensearch, aurora, subnets }
}

// Split an AZ's non-EKS servers into racks. Racks never mix VPCs, so each rack
// belongs to exactly one VPC floor zone. Within a VPC, group by role or subnet.
function buildEc2Groups(servers, vpcIds, viewMode) {
  const field = viewMode === 'subnet' ? 'subnetId' : 'role'
  const groups = []
  const vpcOrder = [...vpcIds, null]
  for (const vpcId of vpcOrder) {
    const inVpc = servers.filter(s => (s.vpcId || null) === vpcId)
    const byGroup = groupBy(inVpc, field)
    for (const gk of Object.keys(byGroup)) {
      groups.push({ key: `${vpcId || ''}|${gk}`, groupKey: gk, vpcId, items: byGroup[gk] })
    }
  }
  return groups
}

const ROW_PITCH = ROW_GAP + 3

// Managed services (RDS, ELB, EFS, Aurora) are split into one rack per VPC so each
// lands in its VPC's floor zone. Items with no known VPC stay in the shared band.
function splitByVpc(items) {
  const m = new Map()
  for (const it of items) {
    const v = it.vpcId || null
    if (!m.has(v)) m.set(v, [])
    m.get(v).push(it)
  }
  return [...m]
}
const vpcRackKey = (base, vpcId) => (vpcId ? `${base}:${vpcId}` : base)

// Compute per-region layout data (AZs, cages, positions)
function computeRegionLayout(regionProcessed, viewMode) {
  const { ec2, rds, eks, msk, elbs, efs, opensearch, aurora, subnets } = regionProcessed
  const serversByAz = groupBy(ec2, 'az')
  // VPCs with EC2 first (keeps their colors stable), then VPCs that only host managed services
  const vpcIds = [...new Set([...ec2, ...rds, ...elbs, ...efs, ...aurora].map(s => s.vpcId).filter(Boolean))]

  // Derive AZ list dynamically from all data sources
  const activeAzs = (() => {
    const azIds = new Set()
    ec2.forEach(s => { if (s.az) azIds.add(s.az) })
    rds.forEach(r => { if (r.az) azIds.add(r.az) })
    if (eks.azs) eks.azs.forEach(a => azIds.add(a))
    if (msk.azs) msk.azs.forEach(a => azIds.add(a))
    if (azIds.size === 0) return defaultAzs
    return [...azIds].sort().map(id => ({ id, name: id, label: id.toUpperCase() }))
  })()

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

  // Describe every rack in every AZ: { key, vpcId (null = shared band), count }
  const racksByAz = {}
  for (const az of activeAzs) {
    const azServers = serversByAz[az.id] || []
    const nonEks = azServers.filter(s => s.role !== 'eks-node')
    const eksNodes = azServers.filter(s => s.role === 'eks-node')
    const first = az.id === activeAzs[0]?.id
    const racks = []
    if (eks.azs.includes(az.id)) racks.push({ key: 'eks', vpcId: eksNodes[0]?.vpcId || null, count: eksNodes.length || 1 })
    if (msk.azs.includes(az.id)) racks.push({ key: 'msk', vpcId: null, count: 1 })
    for (const [v, items] of splitByVpc(rdsByAz[az.id] || [])) racks.push({ key: vpcRackKey('rds', v), vpcId: v, count: items.length })
    if (first) for (const [v, items] of splitByVpc(aurora)) racks.push({ key: vpcRackKey('aurora', v), vpcId: v, count: items.length })
    if (first) for (const [v, items] of splitByVpc(efs)) racks.push({ key: vpcRackKey('efs', v), vpcId: v, count: items.length })
    if (first && opensearch.length > 0) racks.push({ key: 'opensearch', vpcId: null, count: opensearch.length })
    if (first) for (const [v, items] of splitByVpc(elbs)) racks.push({ key: vpcRackKey('elb', v), vpcId: v, count: items.length })
    for (const g of buildEc2Groups(nonEks, vpcIds, viewMode)) racks.push({ key: g.key, vpcId: g.vpcId, count: g.items.length })
    racksByAz[az.id] = racks
  }

  // Bands run along Z: a shared band (non-VPC services) first, then one band per VPC.
  // A band's height is the tallest it needs in any AZ so VPC floor zones line up across AZs.
  const bandOrder = [null, ...vpcIds]
  const layoutBand = (azId, bandId) => {
    const racks = racksByAz[azId].filter(r => r.vpcId === bandId)
    return layoutRacks(racks.map(r => r.key), (key) => ({ length: racks.find(r => r.key === key).count }))
  }
  const bandRows = {}
  const azWidths = {}
  for (const az of activeAzs) {
    azWidths[az.id] = 0
    for (const bandId of bandOrder) {
      const bl = layoutBand(az.id, bandId)
      const rows = bl.positions.length === 0 ? 0 : Math.max(...bl.positions.map(p => p.z / ROW_PITCH)) + 1
      bandRows[bandId] = Math.max(bandRows[bandId] || 0, rows)
      if (bl.positions.length > 0) azWidths[az.id] = Math.max(azWidths[az.id], bl.totalWidth)
    }
  }
  const bandStartZ = {}
  let zCursor = 0
  for (const bandId of bandOrder) {
    bandStartZ[bandId] = zCursor
    zCursor += bandRows[bandId] * ROW_PITCH
  }
  const totalDepth = zCursor + 4
  const cageDepth = Math.max(MIN_CAGE_DEPTH, totalDepth + 10)

  const rackPositions = {}
  const cageSizes = {}
  for (const az of activeAzs) {
    rackPositions[az.id] = {}
    for (const bandId of bandOrder) {
      for (const p of layoutBand(az.id, bandId).positions) {
        rackPositions[az.id][p.key] = { x: p.x, z: p.z + bandStartZ[bandId] }
      }
    }
    cageSizes[az.id] = { width: Math.max(MIN_CAGE_WIDTH, azWidths[az.id] + 10), depth: cageDepth }
  }

  // VPC floor zones in cage-local Z (cage centered at 0). Racks start at -cageDepth/2 + 4.
  const vpcZones = vpcIds
    .filter(v => bandRows[v] > 0)
    .map(vpcId => ({
      vpcId,
      index: vpcIds.indexOf(vpcId),
      depth: bandRows[vpcId] * ROW_PITCH,
      centerZ: -cageDepth / 2 + bandStartZ[vpcId] + (bandRows[vpcId] * ROW_PITCH) / 2,
    }))

  // Position AZs side by side dynamically
  const azPositions = {}
  let cursor = 0
  for (let i = 0; i < activeAzs.length; i++) {
    const azId = activeAzs[i].id
    const w = cageSizes[azId]?.width || MIN_CAGE_WIDTH
    azPositions[azId] = cursor + w / 2
    cursor += w + CAGE_GAP
  }
  const totalSpan = cursor - CAGE_GAP
  const offset = totalSpan / 2
  for (const azId of Object.keys(azPositions)) {
    azPositions[azId] -= offset
  }

  return { activeAzs, serversByAz, rdsByAz, rdsWithStandbys, cageSizes, azPositions, totalSpan, rackPositions, vpcZones, vpcIds }
}

export default function DataCenter({ onSelect, onPin, viewMode, onLoaded, onFetching }) {
  // Legacy flat state for backward compat (populated from first/only region)
  const [ec2, setEc2] = useState(defaultEc2)
  const [rds, setRds] = useState(defaultRds)
  const [eks, setEks] = useState(defaultEks)
  const [msk, setMsk] = useState(defaultMsk)
  const [elbs, setElbs] = useState([])
  const [efsList, setEfsList] = useState([])
  const [opensearchList, setOpensearchList] = useState([])
  const [subnets, setSubnets] = useState({})

  // Multi-region state
  const [regionData, setRegionData] = useState({})
  const [vpcPeerings, setVpcPeerings] = useState([])
  const hasLiveDataRef = useRef(false)

  const [pinned, setPinned] = useState(null)
  const [elbTargets, setElbTargets] = useState([])
  const [elbPortGroups, setElbPortGroups] = useState([])
  const [expandedEks, setExpandedEks] = useState(null)
  const [eksClickPos, setEksClickPos] = useState([0, 9, 0])
  const [eksViewMode, setEksViewMode] = useState('namespace')
  const [loaded, setLoaded] = useState(false)

  const regionPositionsRef = useRef({})

  const poll = useCallback(async () => {
    try {
      onFetching(true)
      const data = await fetchInfraStatus()

      if (data.simulated) {
        // Only use sample data if we haven't received live data yet
        if (!hasLiveDataRef.current) {
          setRegionData({ sample: { ec2: defaultEc2, rds: defaultRds, eks: defaultEks, msk: defaultMsk, elbs: [], efs: [], opensearch: [], subnets: {} } })
        }
        setLoaded(true)
        onLoaded()
        onFetching(false)
        return
      }

      if (data.regions) {
        // Multi-region response
        hasLiveDataRef.current = true
        const processed = {}
        for (const [regionName, regionRaw] of Object.entries(data.regions)) {
          processed[regionName] = processRegionData(regionRaw)
        }
        setRegionData(processed)

        // Populate legacy flat state from first region for backward compat
        const firstRegionKey = Object.keys(processed)[0]
        if (firstRegionKey) {
          const first = processed[firstRegionKey]
          setEc2(first.ec2)
          setRds(first.rds)
          setEks(first.eks)
          setMsk(first.msk)
          setElbs(first.elbs)
          setEfsList(first.efs)
          setOpensearchList(first.opensearch)
          setSubnets(first.subnets)
        }
      } else {
        // Legacy flat response (single region)
        hasLiveDataRef.current = true
        const processed = processRegionData(data)
        setRegionData({ default: processed })
        setEc2(processed.ec2)
        setRds(processed.rds)
        setEks(processed.eks)
        setMsk(processed.msk)
        setElbs(processed.elbs)
        setEfsList(processed.efs)
        setOpensearchList(processed.opensearch)
        setSubnets(processed.subnets)
      }

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
    window.__aws3dFastPoll = () => {
      let count = 0
      const fast = setInterval(() => {
        poll()
        count++
        if (count >= 10) clearInterval(fast)
      }, 3000)
    }
    return () => { clearInterval(id); delete window.__aws3dFastPoll }
  }, [poll])

  // Fetch VPC peering separately (once initially, then every 5 minutes)
  useEffect(() => {
    const fetchPeering = () => {
      fetchVpcPeering().then(d => setVpcPeerings(d.peerings || []))
    }
    // Delay first fetch to let creds initialize
    const timeout = setTimeout(fetchPeering, 5000)
    const id = setInterval(fetchPeering, 300000)
    return () => { clearTimeout(timeout); clearInterval(id) }
  }, [])

  // N key toggles EKS node view (only when mezzanine is open)
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey) return
      if ((e.key === 'n' || e.key === 'N') && expandedEks) {
        setEksViewMode(m => m === 'namespace' ? 'node' : 'namespace')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expandedEks])

  // Click handler: pin a node or clear pin
  const handleSelect = (data) => {
    if (data === null) {
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

      // EKS cluster click — toggle mezzanine
      if (data.cluster && data.cluster === eks.name) {
        setExpandedEks(prev => prev === data.cluster ? null : data.cluster)
        if (data._clickPoint) setEksClickPos(data._clickPoint)
      }

      // If it's an ELB, fetch targets on-demand
      if (data.arn) {
        onFetching(true)
        const _base = import.meta.env.BASE_URL
        const _proxyUrl = _base !== '/' ? `${window.location.origin}${_base.replace(/\/$/, '')}` : `${window.location.protocol}//${window.location.hostname}:9876`
        fetch(`${_proxyUrl}/api/elb/targets?arn=${encodeURIComponent(data.arn)}`)
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

  // Determine which cluster group the pinned node belongs to for interconnect
  const interconnectNodes = (() => {
    if (!pinned) return []
    const id = pinned.id
    if ((id.startsWith('eks-') || pinned.cluster === eks.name) && !expandedEks) {
      const eksNodeIds = ec2.filter(s => (s.role || guessRole(s.name)) === 'eks-node').map(s => s.id)
      if (eksNodeIds.length > 0) return eksNodeIds
      return eks.azs.map(az => `eks-${az}`)
    }
    if (id.startsWith('msk-')) return msk.azs.map(az => `msk-${az}`)
    const rdsItem = rds.find(r => r.id === id)
    if (rdsItem?.multiAz && rdsItem.secondaryAz) {
      const standbyId = `${id}-standby`
      return [id, standbyId]
    }
    if (pinned.arn && elbPortGroups.length > 0) {
      const targetIds = elbPortGroups.flatMap(pg => pg.targets.map(t => t.instanceId)).filter(Boolean)
      return [...new Set(targetIds)]
    }
    if (pinned.arn && elbTargets.length > 0) {
      return [...new Set(elbTargets.map(t => t.instanceId).filter(Boolean))]
    }
    // Aurora Global — connect all clusters with the same globalClusterId across regions
    if (pinned.globalClusterId) {
      const siblings = []
      for (const rd of Object.values(regionData)) {
        for (const c of (rd.aurora || [])) {
          if (c.globalClusterId === pinned.globalClusterId) {
            siblings.push(c.id)
          }
        }
      }
      if (siblings.length > 1) return siblings
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

  // Compute layout for each region
  const regionKeys = Object.keys(regionData)
  const isMultiRegion = regionKeys.length > 1

  const regionLayouts = {}
  for (const regionKey of regionKeys) {
    const rd = regionData[regionKey]
    if (rd.ec2 || rd.rds || rd.eks || rd.msk) {
      regionLayouts[regionKey] = computeRegionLayout(rd, viewMode)
    }
  }

  // Compute region Z positions (facing each other along Z axis)
  const regionPositions = {} // { regionKey: { x, z } }
  if (isMultiRegion) {
    const regionDepths = {}
    for (const regionKey of regionKeys) {
      const layout = regionLayouts[regionKey]
      if (!layout) continue
      regionDepths[regionKey] = Math.max(...layout.activeAzs.map(az => layout.cageSizes[az.id]?.depth || MIN_CAGE_DEPTH)) + 10
    }
    // Stack regions along Z with gap between them
    let zCursor = 0
    for (const regionKey of regionKeys) {
      const layout = regionLayouts[regionKey]
      if (!layout) continue
      const depth = regionDepths[regionKey]
      regionPositions[regionKey] = { x: 0, z: zCursor + depth / 2 }
      zCursor += depth + REGION_GAP
    }
    // Center around origin
    const totalZ = zCursor - REGION_GAP
    const zOffset = totalZ / 2
    for (const key of Object.keys(regionPositions)) {
      regionPositions[key].z -= zOffset
    }
  } else {
    regionPositions[regionKeys[0]] = { x: 0, z: 0 }
  }
  // Legacy X positions for backward compat
  const regionXPositions = {}
  for (const key of Object.keys(regionPositions)) {
    regionXPositions[key] = regionPositions[key].x
  }
  // Center all regions around origin
  const totalRegionSpan = (() => {
    if (!isMultiRegion) {
      const layout = regionLayouts[regionKeys[0]]
      return layout ? layout.totalSpan : 0
    }
    return Math.max(...Object.values(regionLayouts).map(l => l.totalSpan + 10))
  })()
  const regionOffset = 0
  regionPositionsRef.current = regionPositions

  // For single region, compute a global floor size
  const singleRegionLayout = !isMultiRegion ? regionLayouts[regionKeys[0]] : null
  const globalTotalSpan = singleRegionLayout ? singleRegionLayout.totalSpan : totalRegionSpan
  const globalMaxDepth = (() => {
    if (!isMultiRegion) {
      return Math.max(...Object.values(regionLayouts).map(l =>
        Math.max(...l.activeAzs.map(az => l.cageSizes[az.id]?.depth || MIN_CAGE_DEPTH))
      ), MIN_CAGE_DEPTH)
    }
    // Multi-region: total Z span including gap
    const zPositions = Object.values(regionPositions).map(p => p.z)
    const minZ = Math.min(...zPositions)
    const maxZ = Math.max(...zPositions)
    return (maxZ - minZ) + Math.max(...Object.values(regionLayouts).map(l =>
      Math.max(...l.activeAzs.map(az => l.cageSizes[az.id]?.depth || MIN_CAGE_DEPTH))
    ), MIN_CAGE_DEPTH) + REGION_GAP
  })()

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
        <planeGeometry args={[globalTotalSpan + 40, globalMaxDepth + 20]} />
        <meshStandardMaterial color="#0d0d1a" />
      </mesh>

      {regionKeys.map((regionKey) => {
        const rd = regionData[regionKey]
        const layout = regionLayouts[regionKey]
        if (!layout || !rd) return null

        const regionX = regionPositions[regionKey]?.x || 0
        const regionZ = regionPositions[regionKey]?.z || 0
        const { activeAzs: regAzs, serversByAz: regServersByAz, rdsByAz: regRdsByAz, rdsWithStandbys: regRdsWithStandbys, cageSizes: regCageSizes, azPositions: regAzPositions, totalSpan: regTotalSpan } = layout
        const regEc2 = rd.ec2
        const regRds = rd.rds
        const regEks = rd.eks
        const regMsk = rd.msk
        const regElbs = rd.elbs
        const regEfs = rd.efs
        const regOpensearch = rd.opensearch
        const regAurora = rd.aurora || []
        const regSubnets = rd.subnets

        const regionHeight = 22
        const regionWidth = regTotalSpan + 10
        const regionDepth = Math.max(...regAzs.map(az => regCageSizes[az.id]?.depth || MIN_CAGE_DEPTH)) + 10

        return (
          <group key={regionKey} position={[regionX, 0, regionZ]}>
            {/* Region enclosure — only shown for multi-region */}
            {isMultiRegion && (
              <group>
                <lineSegments position={[0, regionHeight / 2, 0]}>
                  <edgesGeometry args={[new THREE.BoxGeometry(regionWidth, regionHeight, regionDepth)]} />
                  <lineBasicMaterial color="#22ccaa" />
                </lineSegments>
                <Text
                  position={[0, regionHeight + 1, 0]}
                  fontSize={1.8}
                  color="#22ccaa"
                  anchorX="center"
                  anchorY="bottom"
                >
                  {regionKey}
                </Text>
              </group>
            )}

            {/* AZ Cages */}
            {regAzs.map((az) => {
              const x = regAzPositions[az.id]
              const CAGE_WIDTH = regCageSizes[az.id]?.width || MIN_CAGE_WIDTH
              const CAGE_DEPTH = regCageSizes[az.id]?.depth || MIN_CAGE_DEPTH
              const azServers = regServersByAz[az.id] || []
              const azRds = regRdsByAz[az.id] || []
              const nonEksServers = azServers.filter(s => s.role !== 'eks-node')
              const ec2Groups = buildEc2Groups(nonEksServers, layout.vpcIds, viewMode)

              const eksNodes = azServers.filter(s => s.role === 'eks-node')
              const eksItems = regEks.azs.includes(az.id)
                ? eksNodes.length > 0
                  ? eksNodes.map(n => ({ id: n.id, name: `${regEks.name} (${n.ip})`, status: n.status, ip: n.ip, cluster: regEks.name }))
                  : [{ id: `eks-${az.id}`, name: regEks.name, status: regEks.status, cluster: regEks.name }]
                : []

              const mskItems = regMsk.azs.includes(az.id) ? [{
                id: `msk-${az.id}`,
                name: regMsk.name,
                status: regMsk.status,
                cluster: regMsk.name,
              }] : []

              return (
                <group key={az.id} position={[x, 0, 0]}>
                  <Cage width={CAGE_WIDTH} depth={CAGE_DEPTH} label={az.label} />

                  {/* === ALL RACKS UNIFIED LAYOUT === */}
                  {(() => {
                    const allRacks = []

                    if (eksItems.length > 0) {
                      allRacks.push({ key: 'eks', label: 'EKS', color: categoryColors.eks.bright, darkColor: categoryColors.eks.dark, category: 'eks', items: eksItems })
                    }
                    if (mskItems.length > 0) {
                      allRacks.push({ key: 'msk', label: 'MSK', color: categoryColors.msk.bright, darkColor: categoryColors.msk.dark, category: 'msk', items: mskItems })
                    }
                    for (const [vpcId, vpcItems] of splitByVpc(azRds)) {
                      allRacks.push({ key: vpcRackKey('rds', vpcId), vpcId, label: 'RDS', color: categoryColors.rds.bright, darkColor: categoryColors.rds.dark, category: 'rds', items: vpcItems.map(r => ({ id: r.id, name: `${r.name}${r.engine ? ` (${r.engine})` : ''}`, status: r.isStandby ? 'unknown' : r.status, isStandby: r.isStandby, multiAz: r.multiAz, endpoint: r.endpoint })) })
                    }
                    // Aurora rack (shown in first AZ of region)
                    if (az.id === regAzs[0]?.id) for (const [vpcId, vpcItems] of splitByVpc(regAurora)) {
                      allRacks.push({ key: vpcRackKey('aurora', vpcId), vpcId, label: 'Aurora', color: categoryColors.aurora.bright, darkColor: categoryColors.aurora.dark, category: 'aurora', items: vpcItems.map(c => ({ id: c.id, name: `${c.name} (${c.role})`, status: c.status, globalClusterId: c.globalClusterId, role: c.role, endpoint: c.endpoint, readerEndpoint: c.readerEndpoint })) })
                    }
                    if (az.id === regAzs[0]?.id) for (const [vpcId, vpcItems] of splitByVpc(regEfs)) {
                      allRacks.push({ key: vpcRackKey('efs', vpcId), vpcId, label: 'EFS', color: categoryColors.efs.bright, darkColor: categoryColors.efs.dark, category: 'efs', items: vpcItems.map(fs => ({ id: fs.id, name: fs.name, status: fs.status, sizeBytes: fs.sizeBytes, throughputMode: fs.throughputMode, provisionedThroughput: fs.provisionedThroughput, performanceMode: fs.performanceMode, encrypted: fs.encrypted, mountTargets: fs.mountTargets, accessPoints: fs.accessPoints, serviceType: 'efs' })) })
                    }
                    if (az.id === regAzs[0]?.id && regOpensearch.length > 0) {
                      allRacks.push({ key: 'opensearch', label: 'OpenSearch', color: categoryColors.opensearch.bright, darkColor: categoryColors.opensearch.dark, category: 'opensearch', items: regOpensearch.map(d => ({ id: d.id, name: `${d.name} (${d.version || ''})`, status: d.status })) })
                    }
                    if (az.id === regAzs[0]?.id) for (const [vpcId, vpcItems] of splitByVpc(regElbs)) {
                      allRacks.push({ key: vpcRackKey('elb', vpcId), vpcId, label: 'ELB', color: categoryColors.network.bright, darkColor: categoryColors.network.dark, category: 'elb', items: vpcItems.map(lb => { const t = lb.type === 'application' ? 'ALB' : lb.type === 'network' ? 'NLB' : 'CLB'; return { id: lb.id, name: `${lb.name} (${t})`, status: lb.status, arn: lb.id, dnsName: lb.dnsName } }) })
                    }

                    // EC2 racks by role or subnet
                    const getLabel = (key) => {
                      if (viewMode === 'subnet') {
                        const sub = regSubnets[key]
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

                    for (const { key, groupKey, items } of ec2Groups) {
                      allRacks.push({ key, label: getLabel(groupKey), color: subnetColor(key, allRacks.length), darkColor: subnetDark(key, allRacks.length), category: 'ec2', items: items.map(s => ({ id: s.id, name: s.name, status: s.status, state: s.state, ip: s.ip, type: s.type, amiId: s.amiId, amiName: s.amiName, launchTime: s.launchTime, checks: s.checks, volumes: s.volumes, subnet: regSubnets[s.subnetId]?.cidr || s.subnetId, subnetId: s.subnetId, vpcId: s.vpcId, securityGroups: s.securityGroups })) })
                    }

                    // Rack positions come from the region layout so each rack sits over its VPC's floor zone
                    const azRackPositions = layout.rackPositions[az.id] || {}
                    const offsetX = -CAGE_WIDTH / 2 + 4
                    const offsetZ = -CAGE_DEPTH / 2 + 4

                    return allRacks.map((rack) => {
                      const lp = azRackPositions[rack.key]
                      if (!lp) return null
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

            {/* VPC floor zones — span across all AZs in the region */}
            {(() => {
              if (layout.vpcZones.length === 0) return null
              // Compute the span: from leftmost AZ edge to rightmost AZ edge
              const azXs = regAzs.map(az => regAzPositions[az.id])
              const leftAz = regAzs.reduce((a, b) => regAzPositions[a.id] < regAzPositions[b.id] ? a : b)
              const rightAz = regAzs.reduce((a, b) => regAzPositions[a.id] > regAzPositions[b.id] ? a : b)
              const leftEdge = regAzPositions[leftAz.id] - (regCageSizes[leftAz.id]?.width || MIN_CAGE_WIDTH) / 2
              const rightEdge = regAzPositions[rightAz.id] + (regCageSizes[rightAz.id]?.width || MIN_CAGE_WIDTH) / 2
              const spanWidth = rightEdge - leftEdge
              const spanCenterX = (leftEdge + rightEdge) / 2

              return layout.vpcZones.map(({ vpcId, index: vi, depth: zoneDepth, centerZ: zOffset }) => {
                const hue = (vi * 220) % 360
                return (
                  <group key={`vpc-${vpcId}`}>
                    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[spanCenterX, 0.02, zOffset]}>
                      <planeGeometry args={[spanWidth - 1, zoneDepth - 0.5]} />
                      <meshStandardMaterial
                        color={`hsl(${hue}, 40%, 12%)`}
                        transparent
                        opacity={0.25}
                      />
                    </mesh>
                    <lineSegments position={[spanCenterX, 0.03, zOffset]} rotation={[-Math.PI / 2, 0, 0]}>
                      <edgesGeometry args={[new THREE.PlaneGeometry(spanWidth - 1, zoneDepth - 0.5)]} />
                      <lineBasicMaterial color={`hsl(${hue}, 50%, 35%)`} />
                    </lineSegments>
                    <Text
                      rotation={[-Math.PI / 2, 0, 0]}
                      position={[leftEdge + 2, 0.04, zOffset]}
                      fontSize={0.6}
                      color={`hsl(${hue}, 50%, 40%)`}
                      anchorX="left"
                    >
                      {vpcId}
                    </Text>
                  </group>
                )
              })
            })()}
          </group>
        )
      })}

      {/* EKS Mezzanine — floating above AZ-A when expanded */}
      {expandedEks && (
        <EksMezzanine
          clusterName={expandedEks}
          position={[eksClickPos[0], 15, eksClickPos[2]]}
          rackPos={eksClickPos}
          onSelect={handleSelect}
          onClick={handleClick}
          pinnedId={pinned?.id}
          highlightIds={interconnectNodes}
          highlightColors={highlightColors}
          viewMode={eksViewMode}
        />
      )}

      {/* On-demand interconnect lines when a multi-AZ node is pinned */}
      {pinned && interconnectNodes.length > 1 && (() => {
        // Use the first region's layout for interconnects (backward compat)
        const firstRegionKey = regionKeys[0]
        const layout = regionLayouts[firstRegionKey]
        if (!layout) return null
        const { activeAzs: icAzs, cageSizes: icCageSizes, azPositions: icAzPositions, rdsByAz: icRdsByAz, rdsWithStandbys: icRdsWithStandbys } = layout
        const regionX = regionPositions[firstRegionKey]?.x || 0
        const regionZ = regionPositions[firstRegionKey]?.z || 0

        // Build position map for interconnect endpoints
        const positions = {}
        // World position of a rack from the layout (falls back to the AZ's first rack slot)
        const rackWorldPos = (azId, key, fallbackDz = 0) => {
          const cw = icCageSizes[azId]?.width || MIN_CAGE_WIDTH
          const cd = icCageSizes[azId]?.depth || MIN_CAGE_DEPTH
          const lp = layout.rackPositions?.[azId]?.[key]
          return [regionX + icAzPositions[azId] - cw / 2 + 4 + (lp?.x || 0), 4, regionZ + -cd / 2 + 4 + (lp ? lp.z : fallbackDz)]
        }
        icAzs.forEach(az => {
          positions[`eks-${az.id}`] = rackWorldPos(az.id, 'eks')
          positions[`msk-${az.id}`] = rackWorldPos(az.id, 'msk', 4)
        })
        icRdsWithStandbys.forEach(r => {
          const azX = icAzPositions[r.az]
          if (azX === undefined) return
          positions[r.id] = rackWorldPos(r.az, vpcRackKey('rds', r.vpcId), 8)
        })
        ec2.filter(s => (s.role || guessRole(s.name)) === 'eks-node').forEach(s => {
          const azX = icAzPositions[s.az]
          if (azX === undefined) return
          positions[s.id] = rackWorldPos(s.az, 'eks')
        })
        elbs.forEach(lb => {
          positions[lb.id] = icAzs[0] ? rackWorldPos(icAzs[0].id, vpcRackKey('elb', lb.vpcId)) : [regionX, 4, regionZ]
        })
        ec2.forEach(s => {
          if (!positions[s.id]) {
            const azX = icAzPositions[s.az] || icAzPositions[icAzs[0]?.id] || 0
            positions[s.id] = [regionX + azX, 4, 0]
          }
        })

        // Aurora Global — add positions for clusters across all regions
        for (const rKey of regionKeys) {
          const rPos = regionPositions[rKey] || { x: 0, z: 0 }
          const rLayout = regionLayouts[rKey]
          const rAurora = regionData[rKey]?.aurora || []
          if (!rLayout || rAurora.length === 0) continue
          const firstAz = rLayout.activeAzs[0]
          if (!firstAz) continue
          const azX = rLayout.azPositions[firstAz.id] || 0
          const cw = rLayout.cageSizes[firstAz.id]?.width || MIN_CAGE_WIDTH
          rAurora.forEach(c => {
            if (!positions[c.id]) {
              const lp = rLayout.rackPositions?.[firstAz.id]?.[vpcRackKey('aurora', c.vpcId)]
              const cd = rLayout.cageSizes[firstAz.id]?.depth || MIN_CAGE_DEPTH
              positions[c.id] = lp
                ? [rPos.x + azX - cw / 2 + 4 + lp.x, 4, rPos.z - cd / 2 + 4 + lp.z]
                : [rPos.x + azX - cw / 2 + 4, 4, rPos.z]
            }
          })
        }

        // For ELBs with port groups, show floating labels above the actual ELB rack
        if (pinned.arn && elbPortGroups.length > 0) {
          const firstAzId = icAzs[0]?.id
          const elbLayout = layout.rackPositions?.[firstAzId]?.[vpcRackKey('elb', elbs.find(lb => lb.id === pinned.arn)?.vpcId)]
          const cwA = icCageSizes[firstAzId]?.width || MIN_CAGE_WIDTH
          const cdA = icCageSizes[firstAzId]?.depth || MIN_CAGE_DEPTH
          const elbX = regionX + icAzPositions[firstAzId] + (-cwA / 2 + 4) + (elbLayout?.x || 0)
          const elbZ = (-cdA / 2 + 4) + (elbLayout?.z || 0)
          const labelStartY = 9

          return (
            <group>
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
                  :{pg.listenerPort}{pg.protocol === 'TLS' || pg.protocol === 'HTTPS' ? ' 🔒' : ''} {pg.path} → {pg.targetGroup}{pg.targetPort ? ` (:${pg.targetPort})` : ''}
                </Text>
              ))}
            </group>
          )
        }

        // Non-ELB interconnects (EKS, MSK, RDS, Aurora)
        let color = categoryColors.eks.bright
        if (pinned.id.startsWith('msk')) color = categoryColors.msk.bright
        else if (rds.find(r => r.id === pinned.id)) color = categoryColors.rds.bright
        else if (pinned.globalClusterId) color = categoryColors.aurora.bright

        return (
          <Interconnect
            nodeIds={interconnectNodes}
            positions={positions}
            color={color}
          />
        )
      })()}

      {/* VPC Peering connections */}
      {vpcPeerings.length > 0 && isMultiRegion && (() => {
        // Build a VPC position map with exact world coordinates of VPC floor zones
        const vpcPositions = {}
        const vpcColors = {}
        for (const regionKey of regionKeys) {
          const rd = regionData[regionKey]
          const layout = regionLayouts[regionKey]
          if (!rd || !layout) continue
          const rPos = regionPositions[regionKey] || { x: 0, z: 0 }
          // VPCs span the whole region — compute center of the spanning zone
          const allVpcIds = layout.vpcIds
          if (allVpcIds.length === 0) continue
          const azXs = layout.activeAzs.map(az => layout.azPositions[az.id])
          const leftAz = layout.activeAzs.reduce((a, b) => layout.azPositions[a.id] < layout.azPositions[b.id] ? a : b)
          const rightAz = layout.activeAzs.reduce((a, b) => layout.azPositions[a.id] > layout.azPositions[b.id] ? a : b)
          const leftEdge = layout.azPositions[leftAz.id] - (layout.cageSizes[leftAz.id]?.width || MIN_CAGE_WIDTH) / 2
          const rightEdge = layout.azPositions[rightAz.id] + (layout.cageSizes[rightAz.id]?.width || MIN_CAGE_WIDTH) / 2
          const spanCenterX = (leftEdge + rightEdge) / 2

          allVpcIds.forEach((vpcId, vi) => {
            if (!vpcPositions[vpcId]) {
              const hue = (vi * 220) % 360
              vpcPositions[vpcId] = {
                x: rPos.x + spanCenterX,
                y: 0.5,
                z: rPos.z,
                region: regionKey
              }
              vpcColors[vpcId] = `hsl(${hue}, 70%, 50%)`
            }
          })
        }
        return vpcPeerings.filter(p => p.status === 'active').map(peering => {
          const from = vpcPositions[peering.requesterVpcId]
          const to = vpcPositions[peering.accepterVpcId]
          if (!from || !to) return null
          const lineColor = vpcColors[peering.requesterVpcId] || '#ff4444'
          return (
            <group key={peering.id}>
              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    array={new Float32Array([
                      from.x, from.y, from.z,
                      to.x, to.y, to.z
                    ])}
                    count={2}
                    itemSize={3}
                  />
                </bufferGeometry>
                <lineBasicMaterial color={lineColor} />
              </line>
              <Text
                position={[(from.x + to.x) / 2, 1.5, (from.z + to.z) / 2]}
                fontSize={0.4}
                color={lineColor}
                anchorX="center"
                outlineWidth={0.02}
                outlineColor="#000000"
              >
                {peering.id}
              </Text>
            </group>
          )
        }).filter(Boolean)
      })()}
    </group>
  )
}
