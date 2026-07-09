import React, { useState, useEffect } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import Rack from './Rack'
import { categoryColors } from '../data/infrastructure'

const base = import.meta.env.BASE_URL
const PROXY_URL = base !== '/'
  ? `${window.location.origin}${base.replace(/\/$/, '')}`
  : `${window.location.protocol}//${window.location.hostname}:9876`

const MAX_PER_RACK = 12
const MAX_RACKS_PER_ROW = 8
const RACK_UNIT_WIDTH = 2.8
const RACK_GAP = 1
const ROW_GAP = 10

// Distinct colors for namespace coding in node view
const NS_COLORS = [
  '#00bfa5', '#ff9900', '#9b59b6', '#e53935', '#43a047',
  '#3f51b5', '#e65100', '#00acc1', '#fdd835', '#8e24aa',
  '#ff7043', '#26a69a', '#5c6bc0', '#d4e157', '#ec407a',
]

function parseK8sResource(val) {
  if (!val) return 0
  if (val.endsWith('m')) return parseInt(val) // millicores
  if (val.endsWith('Ki')) return parseInt(val) * 1024
  if (val.endsWith('Mi')) return parseInt(val) * 1024 * 1024
  if (val.endsWith('Gi')) return parseInt(val) * 1024 * 1024 * 1024
  if (val.endsWith('n')) return parseInt(val) / 1000000 // nanocores to millicores
  return parseInt(val) * 1000 // bare number = cores, convert to millicores
}

function formatCpu(millicores) {
  if (millicores >= 1000) return `${(millicores / 1000).toFixed(1)} cores`
  return `${Math.round(millicores)}m`
}

function formatMem(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}Gi`
  return `${Math.round(bytes / (1024 * 1024))}Mi`
}

export default function EksMezzanine({ clusterName, position, rackPos, onSelect, onClick, pinnedId, highlightIds, highlightColors, viewMode }) {
  const [namespaces, setNamespaces] = useState([])
  const [podsByNs, setPodsByNs] = useState({})
  const [nodes, setNodes] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [pollTick, setPollTick] = useState(0)

  useEffect(() => {
    const orig = window.__aws3dFastPoll
    const wrapped = () => { if (orig) orig(); setPollTick(t => t + 1) }
    window.__aws3dFastPoll = wrapped
    const id = setInterval(() => setPollTick(t => t + 1), 15000)
    return () => { window.__aws3dFastPoll = orig; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!clusterName) return
    setError(null)
    fetch(`${PROXY_URL}/api/eks/namespaces?cluster=${encodeURIComponent(clusterName)}`)
      .then(r => r.json())
      .then(async (data) => {
        if (data.error) {
          if (data.error.includes('Unauthorized') || data.error.includes('401')) {
            setError(`IAM role does not have Kubernetes RBAC access to cluster "${clusterName}". Add the role to the aws-auth ConfigMap or EKS access entries.`)
          } else {
            setError(data.error)
          }
          setLoaded(true)
          return
        }
        const nsList = data.namespaces || []
        setNamespaces(nsList)
        const pods = {}
        for (const ns of nsList) {
          try {
            const res = await fetch(`${PROXY_URL}/api/eks/pods?cluster=${encodeURIComponent(clusterName)}&namespace=${encodeURIComponent(ns.name)}`)
            const d = await res.json()
            pods[ns.name] = d.pods || []
          } catch { pods[ns.name] = [] }
        }
        setPodsByNs(pods)
        // Fetch nodes
        try {
          const nRes = await fetch(`${PROXY_URL}/api/eks/nodes?cluster=${encodeURIComponent(clusterName)}`)
          const nData = await nRes.json()
          setNodes(nData.nodes || [])
        } catch { setNodes([]) }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [clusterName, pollTick])

  if (!loaded) return null
  if (error) {
    return (
      <group position={position}>
        <Text position={[0, 1, 0]} fontSize={0.4} color="#ff6666" anchorX="left" maxWidth={30} outlineWidth={0.02} outlineColor="#000000">
          {error}
        </Text>
      </group>
    )
  }
  if (namespaces.length === 0) {
    return (
      <group position={position}>
        <Text position={[0, 0.7, 0]} fontSize={0.35} color="#ffaa44" anchorX="left" maxWidth={30} outlineWidth={0.02} outlineColor="#000000">
          {`No namespaces found in "${clusterName}" (system namespaces hidden)`}
        </Text>
      </group>
    )
  }

  // Build namespace color map
  const nsColorMap = {}
  const nsNames = namespaces.map(n => n.name)
  nsNames.forEach((ns, i) => { nsColorMap[ns] = NS_COLORS[i % NS_COLORS.length] })

  // All pods flat
  const allPods = Object.entries(podsByNs).flatMap(([ns, pods]) => pods.map(p => ({ ...p, namespace: ns })))

  // Helper to build pod item
  const makePodItem = (p) => ({
    id: `${clusterName}/${p.namespace}/${p.name}`,
    name: p.name.startsWith(clusterName + '-') ? p.name.slice(clusterName.length + 1) : p.name,
    status: p.status === 'Running' && p.ready === p.total && p.restarts < 5 ? 'healthy' : p.status === 'Pending' ? 'degraded' : p.status === 'Running' ? 'degraded' : 'down',
    node: p.node,
    containers: p.containers,
    ready: p.ready,
    total: p.total,
    namespace: p.namespace,
    restarts: p.restarts,
    launchTime: p.startTime,
  })

  // --- NODE VIEW ---
  let racks = []
  let mezzWidth, mezzDepth

  if (viewMode === 'node') {
    // Group pods by node
    const podsByNode = {}
    for (const p of allPods) {
      const node = p.node || 'unscheduled'
      ;(podsByNode[node] = podsByNode[node] || []).push(p)
    }
    const nodeNames = nodes.length > 0 ? nodes.map(n => n.name) : Object.keys(podsByNode)
    const nodeMap = {}
    for (const n of nodes) nodeMap[n.name] = n

    let col = 0, row = 0, maxX = 0
    for (const nodeName of nodeNames) {
      const pods = podsByNode[nodeName] || []
      const rackCols = Math.min(Math.ceil(Math.max(pods.length, 1) / MAX_PER_RACK), 10)
      if (col > 0 && col + rackCols > MAX_RACKS_PER_ROW) { col = 0; row++ }
      const x = col * (RACK_UNIT_WIDTH + RACK_GAP)
      const z = row * ROW_GAP
      const nodeInfo = nodeMap[nodeName]

      // Compute utilization
      let cpuPct = null, memPct = null, utilizationLabel = ''
      if (nodeInfo) {
        const cpuAlloc = parseK8sResource(nodeInfo.cpuAllocatable)
        const cpuUse = parseK8sResource(nodeInfo.cpuUsage)
        const memAlloc = parseK8sResource(nodeInfo.memAllocatable)
        const memUse = parseK8sResource(nodeInfo.memUsage)
        if (cpuAlloc > 0) cpuPct = Math.round((cpuUse / cpuAlloc) * 100)
        if (memAlloc > 0) memPct = Math.round((memUse / memAlloc) * 100)
        utilizationLabel = `CPU ${cpuPct != null ? cpuPct + '%' : '?'} | Mem ${memPct != null ? memPct + '%' : '?'}`
      }

      const items = pods.map(makePodItem)
      // Build highlight colors for namespace coding
      const nsHighlightColors = {}
      const nsHighlightIds = []
      for (const item of items) {
        nsHighlightColors[item.id] = nsColorMap[item.namespace] || '#aaaaaa'
        nsHighlightIds.push(item.id)
      }

      // Short node label
      const shortName = nodeInfo?.instanceId || nodeName.split('.')[0]

      racks.push({ key: nodeName, x, z, items, label: shortName, utilizationLabel, cpuPct, memPct, nsHighlightColors, nsHighlightIds })
      maxX = Math.max(maxX, x + rackCols * RACK_UNIT_WIDTH)
      col += rackCols
    }
    mezzWidth = maxX + 6
    mezzDepth = (row + 1) * ROW_GAP + 6
  } else {
    // --- NAMESPACE VIEW (current behavior) ---
    let col = 0, row = 0, maxX = 0
    for (const ns of namespaces) {
      const pods = podsByNs[ns.name] || []
      const rackCols = Math.min(Math.ceil(Math.max(pods.length, 1) / MAX_PER_RACK), 10)
      if (col > 0 && col + rackCols > MAX_RACKS_PER_ROW) { col = 0; row++ }
      const x = col * (RACK_UNIT_WIDTH + RACK_GAP)
      const z = row * ROW_GAP
      const items = pods.map(p => makePodItem({ ...p, namespace: ns.name }))
      racks.push({ key: ns.name, x, z, items, label: ns.name.startsWith(clusterName + '-') ? ns.name.slice(clusterName.length + 1) : ns.name })
      maxX = Math.max(maxX, x + rackCols * RACK_UNIT_WIDTH)
      col += rackCols
    }
    mezzWidth = maxX + 6
    mezzDepth = (row + 1) * ROW_GAP + 6
  }

  return (
    <group position={position}>
      {/* Vertical connector line from mezzanine down to EKS rack */}
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            array={new Float32Array([
              0, 0, 0,
              (rackPos?.[0] || 0) - position[0], -position[1], (rackPos?.[2] || 0) - position[2]
            ])}
            count={2}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color={categoryColors.eks.bright} transparent opacity={0.6} />
      </line>

      {/* Mezzanine floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[mezzWidth / 2, 0, mezzDepth / 2]}>
        <planeGeometry args={[mezzWidth, mezzDepth]} />
        <meshStandardMaterial color="#0d1a1a" />
      </mesh>

      {/* Teal border */}
      <lineSegments position={[mezzWidth / 2, 0.1, mezzDepth / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(mezzWidth, mezzDepth)]} />
        <lineBasicMaterial color={categoryColors.eks.bright} />
      </lineSegments>

      {/* Cluster label on floor */}
      <Text
        rotation={[-Math.PI / 2, 0, 0]}
        position={[mezzWidth / 2, 0.05, mezzDepth / 2]}
        fontSize={2.5}
        color={categoryColors.eks.bright}
        anchorX="center"
        anchorY="middle"
        transparent
        opacity={0.3}
      >
        {clusterName}
      </Text>
      {/* Cluster label at front edge */}
      <Text
        position={[mezzWidth / 2, 0.3, -0.5]}
        fontSize={0.7}
        color={categoryColors.eks.bright}
        anchorX="center"
      >
        EKS: {clusterName} {viewMode === 'node' ? '(node view)' : ''}
      </Text>

      {/* Toggle hint */}
      <Text
        position={[mezzWidth / 2, 0.3, mezzDepth + 0.5]}
        fontSize={0.3}
        color="#668899"
        anchorX="center"
      >
        [N] Toggle {viewMode === 'node' ? 'namespace' : 'node'} view
      </Text>

      {/* Namespace color legend in node view */}
      {viewMode === 'node' && (
        <group position={[mezzWidth + 1, 0.5, 1]}>
          {nsNames.slice(0, 12).map((ns, i) => (
            <group key={ns} position={[0, 0, i * 0.6]}>
              <mesh position={[0, 0, 0]}>
                <boxGeometry args={[0.3, 0.3, 0.3]} />
                <meshStandardMaterial color={nsColorMap[ns]} />
              </mesh>
              <Text position={[0.4, 0, 0]} fontSize={0.2} color="#aaccff" anchorX="left" anchorY="middle">
                {ns.startsWith(clusterName + '-') ? ns.slice(clusterName.length + 1) : ns}
              </Text>
            </group>
          ))}
        </group>
      )}

      {/* Racks */}
      {racks.map((rack) => (
        <group key={rack.key}>
          <Rack
            position={[rack.x + 2, 0.2, rack.z + 2]}
            label={rack.label}
            color={categoryColors.eks.bright}
            darkColor={categoryColors.eks.dark}
            category="eks"
            items={rack.items}
            onSelect={onSelect}
            onClick={onClick}
            pinnedId={pinnedId}
            highlightIds={viewMode === 'node' ? rack.nsHighlightIds : highlightIds}
            highlightColors={viewMode === 'node' ? rack.nsHighlightColors : highlightColors}
          />
          {/* Utilization label below node identifier in node view */}
          {viewMode === 'node' && rack.utilizationLabel && (() => {
            const perCol = Math.min(rack.items.length, MAX_PER_RACK)
            const rackH = Math.max(perCol * 0.6 + 1, 2)
            return (
              <Text
                position={[rack.x + 2, 0.2 + rackH + 0.15, rack.z + 2]}
                fontSize={0.2}
                color={rack.cpuPct > 80 || rack.memPct > 80 ? '#ff6666' : rack.cpuPct > 60 || rack.memPct > 60 ? '#ffaa44' : '#88ffaa'}
                anchorX="center"
                outlineWidth={0.01}
                outlineColor="#000000"
              >
                {rack.utilizationLabel}
              </Text>
            )
          })()}
        </group>
      ))}
    </group>
  )
}
