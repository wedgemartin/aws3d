import React, { useMemo } from 'react'
import * as THREE from 'three'

// Draws 90-degree routed lines between nodes (like cable trays in a real DC)
export default function Interconnect({ nodeIds, positions, color }) {
  const lines = useMemo(() => {
    const validPositions = nodeIds.map(id => positions[id]).filter(Boolean)
    if (validPositions.length < 2) return []

    // Route between each pair with 90-degree bends:
    // go up from source, across horizontally, then down to target
    const result = []
    for (let i = 0; i < validPositions.length - 1; i++) {
      const from = validPositions[i]
      const to = validPositions[i + 1]
      const riseY = Math.max(from[1], to[1]) + 4 // rise above racks

      const points = [
        new THREE.Vector3(from[0], from[1], from[2]),
        new THREE.Vector3(from[0], riseY, from[2]),       // go up
        new THREE.Vector3(from[0], riseY, 0),             // route to center Z
        new THREE.Vector3(to[0], riseY, 0),               // cross to other AZ
        new THREE.Vector3(to[0], riseY, to[2]),           // route to target Z
        new THREE.Vector3(to[0], to[1], to[2]),           // come down
      ]
      result.push(new THREE.BufferGeometry().setFromPoints(points))
    }
    return result
  }, [nodeIds, positions])

  return (
    <group>
      {lines.map((geo, i) => (
        <line key={i} geometry={geo}>
          <lineBasicMaterial color={color} linewidth={2} transparent opacity={0.8} />
        </line>
      ))}
    </group>
  )
}
