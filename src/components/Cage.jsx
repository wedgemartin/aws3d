import React from 'react'
import { Text } from '@react-three/drei'

export default function Cage({ width, depth, label }) {
  const height = 20
  const wallOpacity = 0.08

  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#111122" />
      </mesh>

      {/* Wire-frame walls */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(width, height, depth)]} />
        <lineBasicMaterial color="#334466" />
      </lineSegments>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#1a2244" transparent opacity={wallOpacity} />
      </mesh>

      {/* Label */}
      <Text
        position={[0, height + 0.5, 0]}
        fontSize={1.2}
        color="#6688cc"
        anchorX="center"
        anchorY="bottom"
      >
        {label}
      </Text>
    </group>
  )
}

// Need THREE for EdgesGeometry
import * as THREE from 'three'
