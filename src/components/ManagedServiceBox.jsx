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

export default function ManagedServiceBox({ position, data, color, darkColor, onSelect, onClick, isPinned, isHighlighted }) {
  const glowRef = useRef()
  const [hovered, setHovered] = useState(false)
  const active = hovered || isPinned || isHighlighted

  useFrame(({ clock }) => {
    if (!glowRef.current) return
    const t = clock.getElapsedTime()
    const pulse = data.status === Status.HEALTHY
      ? 0.6 + Math.sin(t * 1.5) * 0.3
      : data.status === Status.DOWN
        ? Math.sin(t * 6) > 0 ? 1 : 0.1
        : 0.4
    glowRef.current.material.emissiveIntensity = pulse
  })

  return (
    <group
      position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); onSelect(data); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setHovered(false); onSelect(null); document.body.style.cursor = 'default' }}
      onClick={(e) => { e.stopPropagation(); onClick && onClick(data) }}
    >
      {/* Smooth rounded slab */}
      <mesh castShadow>
        <boxGeometry args={[2, 0.45, 0.3]} />
        <meshStandardMaterial
          color={active ? color : darkColor}
          metalness={0.3}
          roughness={0.6}
          emissive={active ? color : darkColor}
          emissiveIntensity={active ? 0.4 : 0.1}
        />
      </mesh>

      {/* Health glow strip along the bottom edge */}
      <mesh ref={glowRef} position={[0, -0.18, 0.14]}>
        <boxGeometry args={[1.8, 0.06, 0.04]} />
        <meshStandardMaterial
          color={statusColors[data.status]}
          emissive={statusColors[data.status]}
          emissiveIntensity={0.6}
        />
      </mesh>

      {/* Name label — always visible */}
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
    </group>
  )
}
