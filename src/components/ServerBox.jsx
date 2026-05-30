import React, { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { Status } from '../data/infrastructure'

const statusColors = {
  [Status.HEALTHY]: '#00ff44',
  [Status.DEGRADED]: '#ffaa00',
  [Status.DOWN]: '#ff2222',
  [Status.UNKNOWN]: '#666666',
}

export default function ServerBox({ position, data, color, darkColor, onSelect, onClick, isPinned, isHighlighted, highlightColor }) {
  const ledRef = useRef()
  const [hovered, setHovered] = useState(false)
  const active = hovered || isPinned || isHighlighted
  const activeColor = highlightColor || color

  useFrame(({ clock }) => {
    if (!ledRef.current) return
    const t = clock.getElapsedTime()
    const blink = data.status === Status.HEALTHY
      ? 0.8 + Math.sin(t * 2 + Math.random() * 0.1) * 0.2
      : data.status === Status.DOWN
        ? Math.sin(t * 6) > 0 ? 1 : 0.1
        : 0.6
    ledRef.current.material.emissiveIntensity = blink
  })

  return (
    <group
      position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); onSelect(data); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setHovered(false); onSelect(null); document.body.style.cursor = 'default' }}
      onClick={(e) => { e.stopPropagation(); onClick && onClick(data) }}
    >
      {/* Server chassis */}
      <mesh castShadow>
        <boxGeometry args={[2, 0.45, 0.3]} />
        <meshStandardMaterial
          color={active ? activeColor : (darkColor || '#1a1a2e')}
          metalness={0.7}
          roughness={0.3}
          emissive={active ? activeColor : '#000000'}
          emissiveIntensity={active ? 0.3 : 0}
        />
      </mesh>

      {/* Thin outline */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(2, 0.45, 0.3)]} />
        <lineBasicMaterial color={active ? activeColor : '#333344'} />
      </lineSegments>

      {/* Name label */}
      <Text
        position={[0, 0, 0.16]}
        fontSize={0.15}
        color={active ? '#ffffff' : '#666677'}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {data.name}
      </Text>

      {/* Status LED */}
      <mesh ref={ledRef} position={[0.85, 0, 0.16]}>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshStandardMaterial
          color={statusColors[data.status]}
          emissive={statusColors[data.status]}
          emissiveIntensity={0.8}
        />
      </mesh>

      {/* Activity LED */}
      <mesh position={[0.7, 0, 0.16]}>
        <sphereGeometry args={[0.04, 8, 8]} />
        <meshStandardMaterial color="#2244aa" emissive="#2244aa" emissiveIntensity={0.4} />
      </mesh>
    </group>
  )
}

import * as THREE from 'three'
