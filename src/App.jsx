import React, { useState, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { PointerLockControls, Stars } from '@react-three/drei'
import DataCenter from './components/DataCenter'
import HUD from './components/HUD'
import WASDControls from './components/WASDControls'

export default function App() {
  const [selected, setSelected] = useState(null)
  const [pinned, setPinned] = useState(null)
  const [locked, setLocked] = useState(false)
  const [viewMode, setViewMode] = useState('role')
  const [dataLoaded, setDataLoaded] = useState(false)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey) return // don't toggle view when using Ctrl shortcuts
      if (e.key === 'v' || e.key === 'V') {
        setViewMode(m => m === 'role' ? 'subnet' : 'role')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <Canvas camera={{ position: [0, 5, 30], fov: 70 }} shadows>
        <color attach="background" args={['#0a0a0f']} />
        <ambientLight intensity={0.3} />
        <directionalLight position={[20, 30, 10]} intensity={0.8} castShadow />
        <pointLight position={[-20, 15, -10]} intensity={0.4} color="#4488ff" />
        <Stars radius={100} depth={50} count={2000} factor={4} fade />
        <DataCenter onSelect={setSelected} onPin={setPinned} viewMode={viewMode} onLoaded={() => setDataLoaded(true)} onFetching={setFetching} />
        <PointerLockControls onLock={() => setLocked(true)} onUnlock={() => setLocked(false)} />
        <WASDControls />
        <gridHelper args={[100, 50, '#1a1a2e', '#1a1a2e']} />
      </Canvas>
      <HUD selected={selected} onClose={() => setSelected(null)} locked={locked} pinned={pinned} viewMode={viewMode} dataLoaded={dataLoaded} fetching={fetching} />
    </>
  )
}
