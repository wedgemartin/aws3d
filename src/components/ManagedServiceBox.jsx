import React, { useRef, useState, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { Status } from '../data/infrastructure'

const statusColors = {
  [Status.HEALTHY]: '#00ff44',
  [Status.DEGRADED]: '#ffaa00',
  [Status.DOWN]: '#ff2222',
  [Status.UNKNOWN]: '#666666',
}

// Log-scale fullness: maps bytes to 0..1 range
// 0 bytes = 0, 1KB = ~0.15, 1MB = ~0.3, 1GB = ~0.5, 100GB = ~0.7, 1TB = ~0.85, 10TB = 1.0
function computeFullness(sizeBytes) {
  if (!sizeBytes || sizeBytes <= 0) return 0.05 // minimum sliver so it doesn't look dead
  const maxLog = Math.log10(10 * 1024 * 1024 * 1024 * 1024) // 10 TB
  const minLog = Math.log10(1024) // 1 KB
  const clamped = Math.max(1024, Math.min(sizeBytes, 10 * 1024 * 1024 * 1024 * 1024))
  return (Math.log10(clamped) - minLog) / (maxLog - minLog)
}

// Color gradient based on size
function fullnessColor(sizeBytes) {
  if (!sizeBytes || sizeBytes < 1024 * 1024) return '#44ddff'           // < 1MB: cyan
  if (sizeBytes < 1024 * 1024 * 1024) return '#4488ff'                  // < 1GB: blue
  if (sizeBytes < 100 * 1024 * 1024 * 1024) return '#6644ff'            // < 100GB: indigo
  if (sizeBytes < 1024 * 1024 * 1024 * 1024) return '#ff8844'           // < 1TB: amber
  return '#ff4444'                                                        // 1TB+: red-orange
}

export default function ManagedServiceBox({ position, data, color, darkColor, onSelect, onClick, isPinned, isHighlighted, highlightColor }) {
  const glowRef = useRef()
  const fillRef = useRef()
  const [hovered, setHovered] = useState(false)
  const active = hovered || isPinned || isHighlighted
  const activeColor = highlightColor || color

  const isEfs = data.serviceType === 'efs'
  const fullness = useMemo(() => isEfs ? computeFullness(data.sizeBytes) : 0, [isEfs, data.sizeBytes])
  const fillColor = useMemo(() => isEfs ? fullnessColor(data.sizeBytes) : null, [isEfs, data.sizeBytes])
  const fillWidth = 1.8 * fullness

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const pulse = data.status === Status.HEALTHY
      ? 0.6 + Math.sin(t * 1.5) * 0.3
      : data.status === Status.DOWN
        ? Math.sin(t * 6) > 0 ? 1 : 0.1
        : 0.4

    if (glowRef.current) {
      glowRef.current.material.emissiveIntensity = isEfs ? 0.15 : pulse
    }
    if (fillRef.current) {
      fillRef.current.material.emissiveIntensity = pulse
    }
  })

  return (
    <group
      position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); onSelect(data); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setHovered(false); onSelect(null); document.body.style.cursor = 'default' }}
      onClick={(e) => { e.stopPropagation(); onClick && onClick({ ...data, _clickPoint: e.point ? [e.point.x, e.point.y, e.point.z] : null }) }}
    >
      {/* Smooth rounded slab */}
      <mesh castShadow>
        <boxGeometry args={[2, 0.45, 0.3]} />
        <meshStandardMaterial
          color={active ? activeColor : darkColor}
          metalness={0.3}
          roughness={0.6}
          emissive={active ? activeColor : darkColor}
          emissiveIntensity={active ? 0.4 : 0.1}
        />
      </mesh>

      {isEfs ? (
        <>
          {/* EFS: dim background track (shows total capacity range) */}
          <mesh ref={glowRef} position={[0, -0.18, 0.14]}>
            <boxGeometry args={[1.8, 0.06, 0.04]} />
            <meshStandardMaterial
              color="#223344"
              emissive="#223344"
              emissiveIntensity={0.15}
            />
          </mesh>
          {/* EFS: bright fill bar (width = fullness percentage) */}
          <mesh ref={fillRef} position={[-0.9 + fillWidth / 2, -0.18, 0.15]}>
            <boxGeometry args={[fillWidth, 0.06, 0.04]} />
            <meshStandardMaterial
              color={fillColor}
              emissive={fillColor}
              emissiveIntensity={0.6}
            />
          </mesh>
        </>
      ) : (
        /* Non-EFS: standard health glow strip */
        <mesh ref={glowRef} position={[0, -0.18, 0.14]}>
          <boxGeometry args={[1.8, 0.06, 0.04]} />
          <meshStandardMaterial
            color={statusColors[data.status]}
            emissive={statusColors[data.status]}
            emissiveIntensity={0.6}
          />
        </mesh>
      )}

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
