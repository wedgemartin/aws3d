import React from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import ServerBox from './ServerBox'
import ManagedServiceBox from './ManagedServiceBox'

export default function Rack({ position, label, color, darkColor, category, items, onSelect, onClick, pinnedId, highlightIds }) {
  const MAX_PER_RACK = 12
  const MAX_COLS = 10
  const rackWidth = 2.5
  const rackDepth = 1.5
  const isManaged = category && category !== 'ec2'

  // Split items into chunks of MAX_PER_RACK
  const chunks = []
  for (let i = 0; i < items.length; i += MAX_PER_RACK) {
    chunks.push(items.slice(i, i + MAX_PER_RACK))
  }

  return (
    <group position={position}>
      {chunks.map((chunk, ci) => {
        const col = ci % MAX_COLS
        const row = Math.floor(ci / MAX_COLS)
        const rackHeight = Math.max(chunk.length * 0.6 + 1, 2)
        return (
          <group key={ci} position={[col * (rackWidth + 0.3), 0, row * (rackDepth + 1.5)]}>
            {/* Rack frame */}
            <mesh position={[0, rackHeight / 2, 0]} castShadow>
              <boxGeometry args={[rackWidth, rackHeight, rackDepth]} />
              <meshStandardMaterial color="#1e1e2e" metalness={0.6} roughness={0.4} />
            </mesh>
            {/* Rack edge outline */}
            <lineSegments position={[0, rackHeight / 2, 0]}>
              <edgesGeometry args={[new THREE.BoxGeometry(rackWidth, rackHeight, rackDepth)]} />
              <lineBasicMaterial color="#3a3a4e" />
            </lineSegments>

            {/* Rack label (only on first) */}
            {ci === 0 && (
              <Text
                position={[((chunks.length - 1) * (rackWidth + 0.3)) / 2, rackHeight + 0.3, 0]}
                fontSize={0.35}
                color={color}
                anchorX="center"
                anchorY="bottom"
              >
                {label}{chunks.length > 1 ? ` (${items.length})` : ''}
              </Text>
            )}

            {/* Server units */}
            {chunk.map((item, i) =>
              isManaged ? (
                <ManagedServiceBox
                  key={item.id}
                  position={[0, 0.5 + i * 0.6, rackDepth / 2 + 0.01]}
                  data={item}
                  color={color}
                  darkColor={darkColor}
                  onSelect={onSelect}
                  onClick={onClick}
                  isPinned={pinnedId === item.id}
                  isHighlighted={highlightIds?.includes(item.id)}
                />
              ) : (
                <ServerBox
                  key={item.id}
                  position={[0, 0.5 + i * 0.6, rackDepth / 2 + 0.01]}
                  data={item}
                  color={color}
                  darkColor={darkColor}
                  onSelect={onSelect}
                  onClick={onClick}
                  isPinned={pinnedId === item.id}
                  isHighlighted={highlightIds?.includes(item.id)}
                />
              )
            )}
          </group>
        )
      })}
    </group>
  )
}
