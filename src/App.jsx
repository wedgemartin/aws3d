import React, { useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { PointerLockControls, Stars } from '@react-three/drei'
import DataCenter from './components/DataCenter'
import HUD from './components/HUD'
import WASDControls from './components/WASDControls'

export default function App() {
  const [selected, setSelected] = useState(null)
  const [locked, setLocked] = useState(false)

  return (
    <>
      <Canvas camera={{ position: [0, 5, 30], fov: 70 }} shadows>
        <color attach="background" args={['#0a0a0f']} />
        <ambientLight intensity={0.3} />
        <directionalLight position={[20, 30, 10]} intensity={0.8} castShadow />
        <pointLight position={[-20, 15, -10]} intensity={0.4} color="#4488ff" />
        <Stars radius={100} depth={50} count={2000} factor={4} fade />
        <DataCenter onSelect={setSelected} />
        <PointerLockControls onLock={() => setLocked(true)} onUnlock={() => setLocked(false)} />
        <WASDControls />
        <gridHelper args={[100, 50, '#1a1a2e', '#1a1a2e']} />
      </Canvas>
      <HUD selected={selected} onClose={() => setSelected(null)} locked={locked} />
    </>
  )
}
