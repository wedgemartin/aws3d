import { useRef, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

const SPEED = 12
const SPRINT_MULTIPLIER = 2.5

export default function WASDControls() {
  const { camera } = useThree()
  const keys = useRef({})
  const direction = useRef(new THREE.Vector3())
  const right = useRef(new THREE.Vector3())

  useEffect(() => {
    const onDown = (e) => { keys.current[e.code] = true }
    const onUp = (e) => { keys.current[e.code] = false }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  useFrame((_, delta) => {
    const k = keys.current
    const sprint = k.ShiftLeft || k.ShiftRight ? SPRINT_MULTIPLIER : 1
    const speed = SPEED * sprint * delta

    // Get camera's forward direction (flattened to XZ plane for FPS feel)
    camera.getWorldDirection(direction.current)
    direction.current.y = 0
    direction.current.normalize()

    // Right vector
    right.current.crossVectors(direction.current, camera.up).normalize()

    // WASD movement
    if (k.KeyW || k.ArrowUp) camera.position.addScaledVector(direction.current, speed)
    if (k.KeyS || k.ArrowDown) camera.position.addScaledVector(direction.current, -speed)
    if (k.KeyA || k.ArrowLeft) camera.position.addScaledVector(right.current, -speed)
    if (k.KeyD || k.ArrowRight) camera.position.addScaledVector(right.current, speed)

    // Q/E for vertical movement
    if (k.KeyQ) camera.position.y -= speed
    if (k.KeyE) camera.position.y += speed
  })

  return null
}
