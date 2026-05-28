import React, { useMemo } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'

export default function Cable({ from, to, color, label }) {
  const curve = useMemo(() => {
    const mid = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + 2, (from[2] + to[2]) / 2]
    return new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(...from),
      new THREE.Vector3(...mid),
      new THREE.Vector3(...to)
    )
  }, [from, to])

  const geometry = useMemo(() => {
    const points = curve.getPoints(30)
    return new THREE.BufferGeometry().setFromPoints(points)
  }, [curve])

  return (
    <group>
      <line geometry={geometry}>
        <lineBasicMaterial color={color} linewidth={2} />
      </line>
      <Text
        position={[(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + 3, (from[2] + to[2]) / 2]}
        fontSize={0.4}
        color={color}
        anchorX="center"
      >
        {label}
      </Text>
    </group>
  )
}
