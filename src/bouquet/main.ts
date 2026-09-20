import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js'
import { buildBouquet } from './bouquet'
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
const STATIC_USDZ = new URL('omaris.usdz', location.href).href
const STATIC_GLB = new URL('omaris.glb', location.href).href

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
renderer.toneMappingExposure = 1.05
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const scene = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.55

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20)
camera.position.set(0.0, 0.42, 1.3)

const sun = new THREE.DirectionalLight(0xfff1e0, 2.2)
sun.position.set(0.5, 1.2, 0.7)
sun.castShadow = true
sun.shadow.mapSize.set(1024, 1024)
sun.shadow.camera.near = 0.1
sun.shadow.camera.far = 4
sun.shadow.camera.left = sun.shadow.camera.bottom = -0.5
sun.shadow.camera.right = sun.shadow.camera.top = 0.5
sun.shadow.bias = -0.0005
sun.shadow.radius = 4
scene.add(sun)
scene.add(new THREE.HemisphereLight(0xfff6ea, 0xd9c2a6, 0.7))
const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5)
fill.position.set(-0.8, 0.4, -0.4)
scene.add(fill)

const floor = new THREE.Mesh(new THREE.CircleGeometry(0.8, 48), new THREE.ShadowMaterial({ opacity: 0.16 }))
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)

// The bouquet is the only thing that gets exported.
const { group: bouquet } = buildBouquet(name)
const pivot = new THREE.Group()
pivot.add(bouquet)
scene.add(pivot)

const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 0.21, 0)
controls.enablePan = false
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.maxPolarAngle = Math.PI * 0.55
controls.minPolarAngle = Math.PI * 0.15
controls.autoRotate = true
controls.autoRotateSpeed = 0.7
controls.addEventListener('start', () => (controls.autoRotate = false))
let idleSince = 0
controls.addEventListener('end', () => (idleSince = performance.now()))

// Frame the bouquet so it sits between the header and the card at any aspect.
function frameDistance(aspect: number) {
  const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const byHeight = 0.36 / halfTan // room above and below a ~0.45 m bouquet
  const byWidth = 0.19 / (halfTan * aspect)
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
    controls.minDistance = d * 0.45
    controls.maxDistance = d * 1.4
    if (!framed) {
      const dir = camera.position.clone().sub(controls.target).normalize()
      camera.position.copy(controls.target).addScaledVector(dir, d)
      framed = true
    }
  }
}
addEventListener('resize', resize)

const timer = new THREE.Timer()
function renderFrame() {
  resize()
  timer.update()
  const t = timer.getElapsed()
  if (!controls.autoRotate && idleSince && performance.now() - idleSince > 6000) controls.autoRotate = true
  // a slow breath, like a breeze through the stems
  if (!renderer.xr.isPresenting) {
    bouquet.rotation.z = Math.sin(t * 0.9) * 0.012
    bouquet.rotation.x = Math.sin(t * 0.6 + 1.3) * 0.008
    controls.update()
  }
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
  const exporter = new USDZExporter()
  return exporter.parseAsync(exportGroup(), { quickLookCompatible: true })
}

// Hook used by tools/bouquet/export-assets.mjs to bake the static files.
;(window as unknown as { __bouquet: unknown }).__bouquet = {
  name,
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
}

// ---------------------------------------------------------------- AR

const arButton = $<HTMLButtonElement>('#ar-button')
const arHint = $<HTMLElement>('#ar-hint')
const arOverlay = $<HTMLElement>('#ar-overlay')
const quickLookAnchor = $<HTMLAnchorElement>('#quick-look')

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
function setBusy(on: boolean, label = 'Preparing your bouquet…') {
  busy = on
  arButton.disabled = on
  arButton.textContent = on ? label : 'See it in your room'
}

async function launchQuickLook() {
  if (busy) return
  setBusy(true)
  try {
    let href: string
    if (isDefaultName && (await headExists(STATIC_USDZ))) {
      href = STATIC_USDZ
    } else {
      const blob = new Blob([await toUSDZ() as BlobPart], { type: 'model/vnd.usdz+zip' })
      href = URL.createObjectURL(blob)
    }
    quickLookAnchor.href = href
    quickLookAnchor.click()
  } finally {
    setBusy(false)
  }
}

async function launchSceneViewer() {
  // Android without WebXR: hand the GLB to Google's Scene Viewer.
  if (!isDefaultName || !(await headExists(STATIC_GLB))) {
    arHint.textContent = 'AR needs a newer Chrome on this phone. You can still spin the bouquet here.'
    return
  }
  const fallback = encodeURIComponent(location.href)
  const intent =
    `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(STATIC_GLB)}&mode=ar_preferred&title=${encodeURIComponent('For ' + name)}` +
    `#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${fallback};end;`
  location.href = intent
}

// WebXR (Android Chrome): tap a surface to set the bouquet down.
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
  bouquet.rotation.set(0, 0, 0)
  scene.environmentIntensity = 0.35

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
    // face the bow toward the viewer
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
    scene.environmentIntensity = 0.55
    arOverlay.dataset.state = ''
    renderer.setAnimationLoop(renderFrame)
  })
  arOverlay.dataset.state = 'scanning'
}

$('#ar-exit').addEventListener('click', () => xrSession?.end())

if (supportsQuickLook) {
  arButton.addEventListener('click', launchQuickLook)
  arHint.textContent = 'Opens in AR Quick Look. Move your phone to find a table.'
} else if (isIOS) {
  arButton.hidden = true
  arHint.textContent = 'Open this link in Safari to see the bouquet in your room.'
} else if (isAndroid) {
  arButton.addEventListener('click', launchWebXR)
  arHint.textContent = 'Point your camera at a table, then tap to set it down.'
} else {
  arButton.hidden = true
  arHint.textContent = 'Open this on your phone to place the bouquet in your room.'
}
