import React, { useState, useEffect } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import Rack from './Rack'
import { categoryColors } from '../data/infrastructure'

const PROXY_URL = 'http://127.0.0.1:9876'
const MAX_PER_RACK = 12
const MAX_RACKS_PER_ROW = 8
const RACK_UNIT_WIDTH = 2.8
const RACK_GAP = 1
const ROW_GAP = 10

export default function EksMezzanine({ clusterName, position, rackPos, onSelect, onClick, pinnedId, highlightIds, highlightColors }) {
  const [namespaces, setNamespaces] = useState([])
  const [podsByNs, setPodsByNs] = useState({})
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)

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
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [clusterName])

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
  if (namespaces.length === 0) return null

  // Layout namespaces using same algorithm as EC2 racks
  let col = 0
  let row = 0
  let maxX = 0
  const nsPositions = []
  for (const ns of namespaces) {
    const podCount = (podsByNs[ns.name] || []).length
    const rackCols = Math.min(Math.ceil(Math.max(podCount, 1) / MAX_PER_RACK), 10)
    if (col > 0 && col + rackCols > MAX_RACKS_PER_ROW) {
      col = 0
      row++
    }
    const x = col * (RACK_UNIT_WIDTH + RACK_GAP)
    const z = row * ROW_GAP
    nsPositions.push({ ns: ns.name, x, z, width: rackCols * RACK_UNIT_WIDTH })
    maxX = Math.max(maxX, x + rackCols * RACK_UNIT_WIDTH)
    col += rackCols
  }

  const mezzWidth = maxX + 6
  const mezzDepth = (row + 1) * ROW_GAP + 6

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
        EKS: {clusterName}
      </Text>

      {/* Namespace racks */}
      {nsPositions.map(({ ns, x, z }, i) => {
        const pods = podsByNs[ns] || []
        const items = pods.map(p => ({
          id: `${clusterName}/${ns}/${p.name}`,
          name: p.name.startsWith(clusterName + '-') ? p.name.slice(clusterName.length + 1) : p.name,
          status: p.status === 'Running' ? 'healthy' : p.status === 'Pending' ? 'degraded' : 'down',
          node: p.node,
          containers: p.containers,
          ready: p.ready,
          total: p.total,
          namespace: ns,
        }))

        return (
          <Rack
            key={ns}
            position={[x + 2, 0.2, z + 2]}
            label={ns.startsWith(clusterName + '-') ? ns.slice(clusterName.length + 1) : ns}
            color={categoryColors.eks.bright}
            darkColor={categoryColors.eks.dark}
            category="eks"
            items={items}
            onSelect={onSelect}
            onClick={onClick}
            pinnedId={pinnedId}
            highlightIds={highlightIds}
            highlightColors={highlightColors}
          />
        )
      })}
    </group>
  )
}
