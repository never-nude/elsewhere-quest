import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { toARUSDZ } from './ar-export'
import { buildBouquet, loosePetalGeometry } from './bouquet'
import './styles.css'

// ---------------------------------------------------------------- params

const params = new URLSearchParams(location.search)
const DEFAULT_NAME = 'Omaris'
const rawName = (params.get('to') ?? DEFAULT_NAME).trim().slice(0, 24)
const name = rawName.replace(/[^\p{L}\p{N} '’.&!-]/gu, '') || DEFAULT_NAME
const from = (params.get('from') ?? 'Mike').trim().slice(0, 40)
const note = (params.get('note') ?? 'Since I can’t hand you these over FaceTime.').trim().slice(0, 140)
const isDefaultName = name.toLowerCase() === DEFAULT_NAME.toLowerCase()

// Pre-built AR files for the default recipient live next to the page. Anyone
// else gets a model generated on the fly.
const STATIC_GLB = new URL('omaris.glb?v=20260920-2', location.href).href

document.title = `For ${name}`
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
$('#for-name').textContent = name
$('#from').textContent = from ? `— ${from}` : ''
$('#note').textContent = note

// ---------------------------------------------------------------- scene

const canvas = $<HTMLCanvasElement>('#stage')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const scene = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.6

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20)
camera.position.set(0.0, 0.7, 1.3)

// a warm key from the upper right, a cool fill from the left, and a soft dome
const sun = new THREE.DirectionalLight(0xfff0dc, 1.7)
sun.position.set(0.6, 1.3, 0.8)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.near = 0.1
sun.shadow.camera.far = 4
sun.shadow.camera.left = sun.shadow.camera.bottom = -0.5
sun.shadow.camera.right = sun.shadow.camera.top = 0.5
sun.shadow.bias = -0.0004
sun.shadow.normalBias = 0.002
sun.shadow.radius = 6
scene.add(sun)
scene.add(new THREE.HemisphereLight(0xfff6ea, 0xcdb9a0, 0.75))
const fill = new THREE.DirectionalLight(0xdbe6ff, 0.6)
fill.position.set(-0.9, 0.5, -0.3)
scene.add(fill)
const rim = new THREE.DirectionalLight(0xffe8f0, 0.5)
rim.position.set(0.1, 0.6, -1.0)
scene.add(rim)

const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.ShadowMaterial({ opacity: 0.2 }))
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)

// The bouquet is the only thing that gets exported.
const { group: bouquet, materials, height: bouquetHeight } = buildBouquet(name)
const pivot = new THREE.Group()
pivot.add(bouquet)
scene.add(pivot)

const controls = new OrbitControls(camera, canvas)
controls.target.set(0, bouquetHeight * 0.42, 0)
controls.enablePan = false
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.maxPolarAngle = Math.PI * 0.52
controls.minPolarAngle = Math.PI * 0.12
controls.autoRotate = true
controls.autoRotateSpeed = 0.6
controls.addEventListener('start', () => (controls.autoRotate = false))
let idleSince = 0
controls.addEventListener('end', () => (idleSince = performance.now()))

// Frame the arrangement so it sits between the header and the card at any aspect.
function frameDistance(aspect: number) {
  const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const byHeight = (bouquetHeight * 0.68) / halfTan
  const byWidth = 0.21 / (halfTan * aspect)
  return Math.max(byHeight, byWidth)
}

let framed = false
function resize() {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    const d = frameDistance(camera.aspect)
    controls.minDistance = d * 0.4
    controls.maxDistance = d * 1.4
    if (!framed) {
      const dir = camera.position.clone().sub(controls.target).normalize()
      camera.position.copy(controls.target).addScaledVector(dir, d)
      framed = true
    }
  }
}
addEventListener('resize', resize)

// ---------------------------------------------------------------- falling petals
// Tap the arrangement and a few petals let go. Purely decorative, never exported.

interface Petal {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  spin: THREE.Vector3
  phase: number
  life: number
}
const petals: Petal[] = []
const petalGeo = loosePetalGeometry()
const petalMats = [materials.roseCrimson, materials.roseApricot, materials.roseBlush, materials.peony]
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function releasePetals(origin: THREE.Vector3, count: number) {
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(petalGeo, petalMats[Math.floor(Math.random() * petalMats.length)])
    mesh.castShadow = true
    mesh.position.copy(origin).add(new THREE.Vector3((Math.random() - 0.5) * 0.12, Math.random() * 0.04, (Math.random() - 0.5) * 0.12))
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6)
    mesh.scale.setScalar(0.7 + Math.random() * 0.5)
    scene.add(mesh)
    petals.push({
      mesh,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.25, 0.05 + Math.random() * 0.15, (Math.random() - 0.5) * 0.25),
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(6),
      phase: Math.random() * 6,
      life: 0,
    })
  }
}

function updatePetals(dt: number, t: number) {
  for (let i = petals.length - 1; i >= 0; i--) {
    const p = petals[i]
    p.life += dt
    // gravity, drag, and a flutter that makes them tumble instead of drop
    p.vel.y -= 0.9 * dt
    p.vel.multiplyScalar(1 - 1.6 * dt)
    p.vel.x += Math.sin(t * 3 + p.phase) * 0.12 * dt
    p.vel.z += Math.cos(t * 2.3 + p.phase) * 0.12 * dt
    p.mesh.position.addScaledVector(p.vel, dt)
    p.mesh.rotation.x += p.spin.x * dt
    p.mesh.rotation.y += p.spin.y * dt
    p.mesh.rotation.z += p.spin.z * dt
    if (p.mesh.position.y < 0.002) {
      p.mesh.position.y = 0.002
      p.vel.set(0, 0, 0)
      p.spin.set(0, 0, 0)
      p.mesh.rotation.x = -Math.PI / 2 + (Math.random() - 0.5) * 0.4
    }
    if (p.life > 14) {
      scene.remove(p.mesh)
      petals.splice(i, 1)
    }
  }
}

let downAt = 0
canvas.addEventListener('pointerdown', () => (downAt = performance.now()))
canvas.addEventListener('pointerup', (e) => {
  if (performance.now() - downAt > 250 || renderer.xr.isPresenting) return // it was a drag
  const rect = canvas.getBoundingClientRect()
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(bouquet, true)[0]
  if (hit && hit.point.y > bouquetHeight * 0.45) releasePetals(hit.point, 6 + Math.floor(Math.random() * 5))
})

// ---------------------------------------------------------------- render loop

const timer = new THREE.Timer()
let settle = 0
function renderFrame() {
  resize()
  timer.update()
  const t = timer.getElapsed()
  const dt = Math.min(timer.getDelta(), 0.05)
  if (!controls.autoRotate && idleSince && performance.now() - idleSince > 6000) controls.autoRotate = true
  if (!renderer.xr.isPresenting) {
    // a soft settle on load, then a slow breath, like a breeze through the stems
    settle = Math.min(1, settle + dt * 0.8)
    const ease = 1 - Math.pow(1 - settle, 3)
    pivot.scale.setScalar(0.92 + 0.08 * ease)
    bouquet.rotation.z = Math.sin(t * 0.8) * 0.01
    bouquet.rotation.x = Math.sin(t * 0.55 + 1.3) * 0.007
    controls.update()
  }
  updatePetals(dt, t)
  renderer.render(scene, camera)
}
renderer.setAnimationLoop(renderFrame)

// ---------------------------------------------------------------- export

function exportGroup() {
  const clone = bouquet.clone(true)
  clone.rotation.set(0, 0, 0)
  clone.position.set(0, 0, 0)
  clone.updateMatrixWorld(true)
  return clone
}

async function toGLB(): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter()
  const result = await exporter.parseAsync(exportGroup(), { binary: true })
  return result as ArrayBuffer
}

async function toUSDZ(): Promise<Uint8Array> {
  return toARUSDZ(exportGroup())
}

// Hook used by tools/bouquet/export-assets.mjs to bake the static files.
;(window as unknown as { __bouquet: unknown }).__bouquet = {
  name,
  poster(yaw = 0) {
    const size = renderer.getSize(new THREE.Vector2())
    const ratio = renderer.getPixelRatio()
    const rotation = bouquet.rotation.clone()
    const scale = pivot.scale.clone()
    const floorVisible = floor.visible
    bouquet.rotation.set(0, 0, 0)
    pivot.scale.setScalar(1)
    floor.visible = false
    const bounds = new THREE.Box3().setFromObject(bouquet)
    const center = bounds.getCenter(new THREE.Vector3())
    const sphere = bounds.getBoundingSphere(new THREE.Sphere())
    const posterCamera = new THREE.PerspectiveCamera(30, 1, 0.01, 20)
    const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.04
    posterCamera.position.copy(center).add(new THREE.Vector3(Math.sin(yaw), 0.18, Math.cos(yaw)).normalize().multiplyScalar(distance))
    posterCamera.lookAt(center)
    renderer.setPixelRatio(1)
    renderer.setSize(640, 640, false)
    renderer.render(scene, posterCamera)
    const png = canvas.toDataURL('image/png')
    bouquet.rotation.copy(rotation)
    pivot.scale.copy(scale)
    floor.visible = floorVisible
    renderer.setPixelRatio(ratio)
    renderer.setSize(size.x, size.y, false)
    return png
  },
  async exportBase64() {
    const [glb, usdz] = await Promise.all([toGLB(), toUSDZ()])
    const b64 = (buf: ArrayBuffer | Uint8Array) => {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(s)
    }
    return { glb: b64(glb), usdz: b64(usdz) }
  },
  triangles: (() => {
    let tris = 0
    bouquet.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3
    })
    return tris
  })(),
  releasePetals: () => releasePetals(new THREE.Vector3(0, bouquetHeight * 0.8, 0), 10),
}

// ---------------------------------------------------------------- AR

const arButton = $<HTMLButtonElement>('#ar-button')
const arHint = $<HTMLElement>('#ar-hint')
const arOverlay = $<HTMLElement>('#ar-overlay')
const quickLookAnchor = document.createElement('a')

const supportsQuickLook = quickLookAnchor.relList?.supports?.('ar') ?? false
const isAndroid = /android/i.test(navigator.userAgent)
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

async function headExists(url: string) {
  try {
    const r = await fetch(url, { method: 'HEAD' })
    return r.ok
  } catch {
    return false
  }
}

let busy = false
function setBusy(on: boolean, label = 'Preparing your flowers…') {
  busy = on
  arButton.disabled = on
  arButton.textContent = on ? label : 'See it in your room'
}

function openARPage() {
  // Release the live preview before the camera opens. The next document has no
  // WebGL renderer and launches Quick Look from an ordinary, user-tapped link.
  renderer.setAnimationLoop(null)
  renderer.dispose()
  renderer.forceContextLoss()
  const destination = new URL('ar.html', location.href)
  destination.search = location.search
  location.assign(destination.href)
}

// A back-forward cache restore must rebuild the preview's released context.
addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload()
})

async function launchSceneViewer() {
  // Android without WebXR: hand the GLB to Google's Scene Viewer.
  if (!isDefaultName || !(await headExists(STATIC_GLB))) {
    arHint.textContent = 'AR needs a newer Chrome on this phone. You can still spin the flowers here.'
    return
  }
  const fallback = encodeURIComponent(location.href)
  const intent =
    `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(STATIC_GLB)}&mode=ar_preferred&resizable=false&title=${encodeURIComponent('For ' + name)}` +
    `#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${fallback};end;`
  location.href = intent
}

// WebXR (Android Chrome): tap a surface to set the vase down.
let xrSession: XRSession | null = null
async function launchWebXR() {
  if (busy) return
  const xr = navigator.xr
  if (!xr) return launchSceneViewer()
  let ok = false
  try {
    ok = await xr.isSessionSupported('immersive-ar')
  } catch {
    ok = false
  }
  if (!ok) return launchSceneViewer()

  setBusy(true, 'Opening camera…')
  try {
    xrSession = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'light-estimation'],
      domOverlay: { root: arOverlay },
    })
  } catch (err) {
    console.warn('AR session failed', err)
    setBusy(false)
    return launchSceneViewer()
  }
  setBusy(false)

  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local')
  await renderer.xr.setSession(xrSession)
  document.body.classList.add('in-ar')
  floor.visible = false
  pivot.visible = false
  pivot.scale.setScalar(1)
  bouquet.rotation.set(0, 0, 0)
  scene.environmentIntensity = 0.5

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xfff3e6, transparent: true, opacity: 0.9 }),
  )
  reticle.matrixAutoUpdate = false
  reticle.visible = false
  scene.add(reticle)

  const viewerSpace = await xrSession.requestReferenceSpace('viewer')
  const hitSource = await xrSession.requestHitTestSource?.({ space: viewerSpace })
  const controller = renderer.xr.getController(0)
  controller.addEventListener('select', () => {
    if (!reticle.visible) return
    pivot.position.setFromMatrixPosition(reticle.matrix)
    pivot.quaternion.identity()
    // face the name toward the viewer
    const cam = renderer.xr.getCamera().position
    pivot.rotation.y = Math.atan2(cam.x - pivot.position.x, cam.z - pivot.position.z)
    pivot.visible = true
    arOverlay.dataset.state = 'placed'
  })
  scene.add(controller)

  renderer.setAnimationLoop((_time, frame?: XRFrame) => {
    if (frame && hitSource) {
      const refSpace = renderer.xr.getReferenceSpace()
      const hits = frame.getHitTestResults(hitSource)
      if (hits.length > 0 && refSpace) {
        const pose = hits[0].getPose(refSpace)
        if (pose) {
          reticle.visible = !pivot.visible
          reticle.matrix.fromArray(pose.transform.matrix)
        }
      } else {
        reticle.visible = false
      }
    }
    renderer.render(scene, camera)
  })

  xrSession.addEventListener('end', () => {
    xrSession = null
    renderer.xr.enabled = false
    document.body.classList.remove('in-ar')
    scene.remove(reticle, controller)
    floor.visible = true
    pivot.visible = true
    pivot.position.set(0, 0, 0)
    pivot.rotation.set(0, 0, 0)
    scene.environmentIntensity = 0.6
    arOverlay.dataset.state = ''
    renderer.setAnimationLoop(renderFrame)
  })
  arOverlay.dataset.state = 'scanning'
}

$('#ar-exit').addEventListener('click', () => xrSession?.end())

if (supportsQuickLook) {
  arButton.addEventListener('click', openARPage)
  arHint.textContent = 'A little space on a table is all you need.'
} else if (isIOS) {
  arButton.hidden = true
  arHint.textContent = 'Open this link in Safari to see the flowers in your room.'
} else if (isAndroid) {
  arButton.addEventListener('click', isDefaultName ? openARPage : launchWebXR)
  arHint.textContent = 'Point your camera at a table or the floor, then tap to set it down.'
} else {
  arButton.hidden = true
  arHint.textContent = 'Open this on your phone to place the flowers in your room.'
}
