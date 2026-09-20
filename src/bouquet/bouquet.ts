// Procedural garden-style arrangement in a fluted stoneware vase. Everything
// is geometry plus textured PBR materials so it exports to GLB (Android) and
// USDZ (iOS Quick Look). Units are meters at real-world scale; the origin is
// the bottom of the vase so it stands on a table in AR.

import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { Font } from 'three/addons/loaders/FontLoader.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import tagFontData from './tag-font.json'
import { glazeTexture, leafNormal, leafTexture, petalNormal, petalTexture } from './textures'

// ---------------------------------------------------------------- utilities

/** Small deterministic PRNG so the same name always gives the same bouquet. */
function makeRandom(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

function hashString(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))
const lerp = THREE.MathUtils.lerp
type Rand = () => number

// ---------------------------------------------------------------- materials

type MatKey =
  | 'roseCrimson'
  | 'roseApricot'
  | 'roseBlush'
  | 'peony'
  | 'ranunculus'
  | 'lisianthus'
  | 'tulip'
  | 'pollen'
  | 'berry'
  | 'babysBreath'
  | 'roseLeaf'
  | 'eucalyptus'
  | 'vineLeaf'
  | 'stem'
  | 'sepal'
  | 'vase'
  | 'vaseInside'
  | 'gold'

// Thin, open surfaces need to be visible from both sides. USDZ/Quick Look does
// not reliably honor double-sided materials, so we bake a flipped copy.
const TWO_SIDED = new Set<MatKey>(['roseCrimson', 'roseApricot', 'roseBlush', 'peony', 'ranunculus', 'lisianthus', 'tulip', 'roseLeaf', 'eucalyptus', 'vineLeaf', 'sepal', 'vaseInside'])

function makeMaterials(): Record<MatKey, THREE.MeshPhysicalMaterial> {
  const petalN = petalNormal()
  const leafN = leafNormal()
  const petal = (map: THREE.Texture, sheen: string) =>
    new THREE.MeshPhysicalMaterial({ map, normalMap: petalN, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.78, metalness: 0, sheen: 0.25, sheenRoughness: 0.7, sheenColor: new THREE.Color(sheen) })
  const leaf = (map: THREE.Texture) => new THREE.MeshPhysicalMaterial({ map, normalMap: leafN, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.55, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.5 })

  const m: Record<MatKey, THREE.MeshPhysicalMaterial> = {
    // her favorite color is pink, so every bloom is a different pink
    roseCrimson: petal(petalTexture({ base: '#6e0c34', mid: '#b81f66', tip: '#d94a8f', vein: '#4d0823' }, 11), '#f19ac0'),
    roseApricot: petal(petalTexture({ base: '#b0386a', mid: '#df739e', tip: '#eea3bf', vein: '#8a2a52' }, 12), '#f9d3e1'),
    roseBlush: petal(petalTexture({ base: '#cf85a1', mid: '#eeb6c8', tip: '#f6d2dd', vein: '#ab6a85' }, 13), '#fbe9ef'),
    peony: petal(petalTexture({ base: '#d05f8c', mid: '#e992b5', tip: '#f2b9cd', vein: '#b04a75' }, 14), '#f7d9e4'),
    ranunculus: petal(petalTexture({ base: '#5c0f3a', mid: '#a1246b', tip: '#c4498e', vein: '#420a29' }, 15), '#e28ab8'),
    lisianthus: petal(petalTexture({ base: '#c7cca3', mid: '#f1dbe3', tip: '#f8e6ec', vein: '#b3b98f' }, 16), '#fbf0f4'),
    tulip: petal(petalTexture({ base: '#c04a80', mid: '#e587ad', tip: '#f1b3c9', vein: '#9b3a66' }, 17), '#f9dbe6'),
    pollen: new THREE.MeshPhysicalMaterial({ color: '#e9b63a', roughness: 0.9 }),
    berry: new THREE.MeshPhysicalMaterial({ color: '#d4548a', roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 }),
    babysBreath: new THREE.MeshPhysicalMaterial({ color: '#fdfbf4', roughness: 0.95 }),
    roseLeaf: leaf(leafTexture('#2c5430', '#5b8b4c', 21)),
    eucalyptus: leaf(leafTexture('#748f7b', '#a8bda9', 22)),
    vineLeaf: leaf(leafTexture('#38643a', '#6f9c5c', 23)),
    stem: new THREE.MeshPhysicalMaterial({ color: '#4f7f49', roughness: 0.7 }),
    sepal: new THREE.MeshPhysicalMaterial({ color: '#4a7a44', roughness: 0.75 }),
    vase: new THREE.MeshPhysicalMaterial({ map: glazeTexture('#f2ece1', '#6a5947'), color: '#ffffff', roughness: 0.5, clearcoat: 0.9, clearcoatRoughness: 0.18 }),
    vaseInside: new THREE.MeshPhysicalMaterial({ color: '#bfb3a3', roughness: 0.7 }),
    gold: new THREE.MeshPhysicalMaterial({ color: '#d1a94f', metalness: 1, roughness: 0.28 }),
  }
  for (const [k, mat] of Object.entries(m)) mat.name = k
  return m
}

/** A copy of `g` with reversed winding and normals: its back face. */
function flipped(g: THREE.BufferGeometry) {
  const f = g.clone()
  const arr = f.index!.array
  for (let i = 0; i < arr.length; i += 3) {
    const t = arr[i + 1]
    arr[i + 1] = arr[i + 2]
    arr[i + 2] = t
  }
  f.index!.needsUpdate = true
  const n = f.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
  return f
}

// ---------------------------------------------------------------- collector

class Collector {
  private buckets = new Map<MatKey, THREE.BufferGeometry[]>()

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, key: MatKey) {
    const g = geometry.index ? geometry : mergeVertices(geometry)
    g.applyMatrix4(matrix)
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
    }
    g.computeVertexNormals()
    let list = this.buckets.get(key)
    if (!list) {
      list = []
      this.buckets.set(key, list)
    }
    list.push(g)
    if (TWO_SIDED.has(key)) list.push(flipped(g))
  }

  build(materials: Record<MatKey, THREE.MeshPhysicalMaterial>) {
    const group = new THREE.Group()
    group.name = 'Bouquet'
    for (const [key, list] of this.buckets) {
      const merged = mergeGeometries(list, false)
      if (!merged) continue
      const mesh = new THREE.Mesh(merged, materials[key])
      mesh.name = key
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
    return group
  }
}

// ---------------------------------------------------------------- petals

interface PetalOpts {
  length: number
  width: number
  curl: number // how far the petal bends back (radians over its length)
  cup: number // cupping across the width (negative = arched)
  segsU?: number
  segsV?: number
  tipPinch?: number // 0 = round tip, 1 = pointed
  ruffle?: number // waviness of the edge toward the tip
  twist?: number // gentle twist along the length
}

/** A single curved petal, foot at the origin, growing along +Y, UV u across / v along. */
function petalGeometry(o: PetalOpts) {
  const segsU = o.segsU ?? 4
  const segsV = o.segsV ?? 7
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const tipPinch = o.tipPinch ?? 0.35
  const ruffle = o.ruffle ?? 0.06
  const twist = o.twist ?? 0
  for (let j = 0; j <= segsV; j++) {
    const v = j / segsV
    const profile = Math.max(0.12, Math.pow(Math.sin(Math.PI * (0.08 + 0.92 * v)), 0.6)) * (1 - tipPinch * Math.pow(v, 6))
    const theta = o.curl * v
    const arc = o.curl > 1e-4 ? o.length / o.curl : o.length
    const y = o.curl > 1e-4 ? arc * Math.sin(theta) : o.length * v
    const zBend = o.curl > 1e-4 ? arc * (1 - Math.cos(theta)) : 0
    for (let i = 0; i <= segsU; i++) {
      const u = (i / segsU) * 2 - 1
      let x = u * (o.width / 2) * profile
      let z = zBend + o.cup * u * u * (0.35 + 0.65 * v) * o.width + ruffle * o.width * Math.sin(u * Math.PI * 2.5 + v * 3) * v * v * v
      if (twist) {
        const a = twist * v
        const x2 = x * Math.cos(a) - (z - zBend) * Math.sin(a)
        const z2 = x * Math.sin(a) + (z - zBend) * Math.cos(a) + zBend
        x = x2
        z = z2
      }
      positions.push(x, y, z)
      uvs.push(i / segsU, v)
    }
  }
  for (let j = 0; j < segsV; j++) {
    for (let i = 0; i < segsU; i++) {
      const a = j * (segsU + 1) + i
      const b = a + segsU + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------- placement helpers

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const X_AXIS = new THREE.Vector3(1, 0, 0)
const Y_AXIS = new THREE.Vector3(0, 1, 0)

function compose(frame: THREE.Matrix4, position: THREE.Vector3, euler: THREE.Euler, scale = 1) {
  _q.setFromEuler(euler)
  _s.setScalar(scale)
  _m.compose(position, _q, _s)
  return new THREE.Matrix4().multiplyMatrices(frame, _m)
}

/** Place a petal around the head axis: yaw to face outward, then tilt open. */
function radial(frame: THREE.Matrix4, angle: number, r: number, y: number, tilt: number, scale = 1) {
  _p.set(Math.cos(angle) * r, y, Math.sin(angle) * r)
  _e.set(0, -angle + Math.PI / 2, 0, 'YXZ')
  const q = new THREE.Quaternion().setFromEuler(_e).multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, tilt))
  _s.setScalar(scale)
  _m.compose(_p, q, _s)
  return new THREE.Matrix4().multiplyMatrices(frame, _m)
}

interface SpiralCfg {
  petals: number
  radius: [number, number]
  length: [number, number]
  width: [number, number]
  tilt: [number, number]
  curl: [number, number]
  cup: [number, number]
  ruffle: number
  tipPinch: number
  segsU: number
  segsV: number
  jitter: number
  twist?: number
}

/** Generic spiral bloom: petals placed on a golden-angle spiral from bud to rim. */
function spiral(c: Collector, frame: THREE.Matrix4, rand: Rand, key: MatKey, cfg: SpiralCfg, scale = 1) {
  const start = rand() * Math.PI * 2
  for (let i = 0; i < cfg.petals; i++) {
    const t = i / (cfg.petals - 1)
    const ease = t * t * (3 - 2 * t)
    const angle = start + i * GOLDEN
    const j = (rand() - 0.5) * cfg.jitter
    const g = petalGeometry({
      length: lerp(cfg.length[0], cfg.length[1], ease) * (1 + j) * scale,
      width: lerp(cfg.width[0], cfg.width[1], ease) * (1 + j) * scale,
      curl: lerp(cfg.curl[0], cfg.curl[1], ease * ease),
      cup: lerp(cfg.cup[0], cfg.cup[1], ease),
      ruffle: cfg.ruffle,
      tipPinch: cfg.tipPinch,
      segsU: cfg.segsU,
      segsV: cfg.segsV,
      twist: (rand() - 0.5) * (cfg.twist ?? 0),
    })
    const tilt = lerp(cfg.tilt[0], cfg.tilt[1], ease) + (rand() - 0.5) * 0.1
    c.add(g, radial(frame, angle, lerp(cfg.radius[0], cfg.radius[1], ease) * scale, (0.003 + ease * 0.006) * scale, tilt), key)
  }
}

function sepals(c: Collector, frame: THREE.Matrix4, rand: Rand, count: number, size: number) {
  const hip = new THREE.SphereGeometry(0.0075 * size, 10, 8)
  hip.scale(1, 1.3, 1)
  c.add(hip, compose(frame, new THREE.Vector3(0, -0.002, 0), new THREE.Euler()), 'sepal')
  const start = rand() * Math.PI * 2
  for (let k = 0; k < count; k++) {
    const g = petalGeometry({ length: 0.024 * size, width: 0.007 * size, curl: 0.9, cup: 0.1, segsU: 2, segsV: 4, tipPinch: 0.6, ruffle: 0 })
    c.add(g, radial(frame, start + (k / count) * Math.PI * 2, 0.007 * size, 0.002, 1.5 + rand() * 0.25), 'sepal')
  }
}

// ---------------------------------------------------------------- blooms

function rose(c: Collector, frame: THREE.Matrix4, rand: Rand, key: MatKey, scale: number) {
  const open = 0.55 + rand() * 0.45
  spiral(
    c,
    frame,
    rand,
    key,
    {
      petals: 22,
      radius: [0.002, 0.02],
      length: [0.024, 0.036],
      width: [0.022, 0.04],
      tilt: [0.05, 0.55 + 0.4 * open],
      curl: [0.35, 2.6],
      cup: [0.55, 0.32],
      ruffle: 0.035,
      tipPinch: 0.1,
      segsU: 3,
      segsV: 6,
      jitter: 0.08,
      twist: 0.25,
    },
    scale,
  )
  sepals(c, frame, rand, 5, scale)
}

function peony(c: Collector, frame: THREE.Matrix4, rand: Rand, scale: number) {
  spiral(
    c,
    frame,
    rand,
    'peony',
    {
      petals: 26,
      radius: [0.002, 0.027],
      length: [0.026, 0.044],
      width: [0.028, 0.05],
      tilt: [0.15, 1.05],
      curl: [0.3, 1.4],
      cup: [0.5, 0.28],
      ruffle: 0.08,
      tipPinch: 0.02,
      segsU: 3,
      segsV: 6,
      jitter: 0.12,
      twist: 0.3,
    },
    scale,
  )
  // a few stamens peeking out of the centre
  const stamen = new THREE.SphereGeometry(0.0018, 6, 5)
  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2
    const r = rand() * 0.006
    c.add(stamen.clone(), compose(frame, new THREE.Vector3(Math.cos(a) * r, 0.012 + rand() * 0.006, Math.sin(a) * r), new THREE.Euler()), 'pollen')
  }
  sepals(c, frame, rand, 4, scale * 1.1)
}

function ranunculus(c: Collector, frame: THREE.Matrix4, rand: Rand, scale: number) {
  spiral(
    c,
    frame,
    rand,
    'ranunculus',
    {
      petals: 22,
      radius: [0.001, 0.016],
      length: [0.011, 0.022],
      width: [0.013, 0.027],
      tilt: [0.15, 1.3],
      curl: [0.15, 0.85],
      cup: [0.3, 0.2],
      ruffle: 0.02,
      tipPinch: 0.05,
      segsU: 3,
      segsV: 5,
      jitter: 0.1,
    },
    scale,
  )
  const eye = new THREE.SphereGeometry(0.0035 * scale, 8, 6)
  c.add(eye, compose(frame, new THREE.Vector3(0, 0.006, 0), new THREE.Euler()), 'sepal')
  sepals(c, frame, rand, 4, scale * 0.8)
}

function lisianthus(c: Collector, frame: THREE.Matrix4, rand: Rand, scale: number) {
  const start = rand() * Math.PI * 2
  for (let ring = 0; ring < 2; ring++) {
    const n = ring === 0 ? 5 : 6
    for (let i = 0; i < n; i++) {
      const angle = start + (i / n) * Math.PI * 2 + ring * 0.5
      const g = petalGeometry({ length: (0.026 + ring * 0.006) * scale, width: (0.02 + ring * 0.004) * scale, curl: 1.0 + ring * 0.3, cup: 0.32, segsU: 3, segsV: 6, tipPinch: 0.05, ruffle: 0.12, twist: (rand() - 0.5) * 0.3 })
      c.add(g, radial(frame, angle, (0.003 + ring * 0.003) * scale, 0.003 + ring * 0.003, 0.35 + ring * 0.3 + (rand() - 0.5) * 0.1), 'lisianthus')
    }
  }
  const stamen = new THREE.SphereGeometry(0.0016, 6, 5)
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2
    c.add(stamen.clone(), compose(frame, new THREE.Vector3(Math.cos(a) * 0.003, 0.012 + rand() * 0.004, Math.sin(a) * 0.003), new THREE.Euler()), 'pollen')
  }
  sepals(c, frame, rand, 5, scale * 0.7)
}

/** A tulip: six cupped petals in two rings, plus one long leaf on the stem. */
function tulip(c: Collector, frame: THREE.Matrix4, rand: Rand, scale: number) {
  const start = rand() * Math.PI * 2
  const open = 0.25 + rand() * 0.3
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < 3; i++) {
      const angle = start + (i / 3) * Math.PI * 2 + ring * (Math.PI / 3)
      const g = petalGeometry({ length: (0.042 - ring * 0.003) * scale, width: (0.03 + ring * 0.002) * scale, curl: 0.55 + ring * 0.25, cup: 0.55, segsU: 3, segsV: 6, tipPinch: 0.45, ruffle: 0.015, twist: (rand() - 0.5) * 0.15 })
      c.add(g, radial(frame, angle, (0.005 + ring * 0.004) * scale, 0.002 + ring * 0.002, open + ring * 0.2 + (rand() - 0.5) * 0.08), 'tulip')
    }
  }
  const stamen = new THREE.SphereGeometry(0.0016, 6, 5)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    c.add(stamen.clone(), compose(frame, new THREE.Vector3(Math.cos(a) * 0.003, 0.012, Math.sin(a) * 0.003), new THREE.Euler()), 'pollen')
  }
}

function tulipLeaf(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const g = petalGeometry({ length: 0.11, width: 0.03, curl: 0.9, cup: 0.35, segsU: 3, segsV: 8, tipPinch: 0.7, ruffle: 0.04 })
  c.add(g, radial(frame, rand() * Math.PI * 2, 0.003, 0, 0.35 + rand() * 0.2), 'roseLeaf')
}

function hypericum(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const berry = new THREE.IcosahedronGeometry(0.0052, 1)
  berry.scale(0.9, 1.15, 0.9)
  const twig = new THREE.CylinderGeometry(0.0007, 0.0009, 1, 4, 1)
  for (let i = 0; i < 7; i++) {
    const angle = rand() * Math.PI * 2
    const spread = 0.004 + rand() * 0.014
    const height = 0.008 + rand() * 0.022
    const end = new THREE.Vector3(Math.cos(angle) * spread, height, Math.sin(angle) * spread)
    const len = end.length()
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, end.clone().normalize())
    const tm = new THREE.Matrix4().compose(end.clone().multiplyScalar(0.5), q, new THREE.Vector3(1, len, 1))
    c.add(twig.clone(), new THREE.Matrix4().multiplyMatrices(frame, tm), 'stem')
    c.add(berry.clone(), compose(frame, end, new THREE.Euler(rand(), rand(), 0), 0.85 + rand() * 0.35), 'berry')
  }
  for (let k = 0; k < 4; k++) {
    const g = petalGeometry({ length: 0.03, width: 0.014, curl: 0.5, cup: -0.08, segsU: 3, segsV: 5, tipPinch: 0.5, ruffle: 0 })
    c.add(g, radial(frame, (k / 4) * Math.PI * 2 + rand(), 0.004, -0.004, 1.3 + rand() * 0.3), 'roseLeaf')
  }
}

function babysBreath(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const blob = new THREE.IcosahedronGeometry(0.003, 0)
  const twig = new THREE.CylinderGeometry(0.0005, 0.0006, 1, 4, 1)
  for (let i = 0; i < 10; i++) {
    const angle = rand() * Math.PI * 2
    const spread = 0.01 + rand() * 0.035
    const height = 0.01 + rand() * 0.045
    const end = new THREE.Vector3(Math.cos(angle) * spread, height, Math.sin(angle) * spread)
    const len = end.length()
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, end.clone().normalize())
    const tm = new THREE.Matrix4().compose(end.clone().multiplyScalar(0.5), q, new THREE.Vector3(1, len, 1))
    c.add(twig.clone(), new THREE.Matrix4().multiplyMatrices(frame, tm), 'stem')
    for (let b = 0; b < 3; b++) {
      const off = new THREE.Vector3((rand() - 0.5) * 0.007, (rand() - 0.5) * 0.007, (rand() - 0.5) * 0.007)
      c.add(blob.clone(), compose(frame, end.clone().add(off), new THREE.Euler(rand() * 3, rand() * 3, 0), 0.7 + rand() * 0.6), 'babysBreath')
    }
  }
}

function eucalyptus(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const stalk = new THREE.CylinderGeometry(0.001, 0.0014, 0.08, 5, 1)
  c.add(stalk, compose(frame, new THREE.Vector3(0, 0.04, 0), new THREE.Euler()), 'stem')
  const yaw0 = rand() * Math.PI * 2
  for (let i = 0; i < 9; i++) {
    const y = 0.006 + i * 0.009
    const side = i % 2 === 0 ? 1 : -1
    const yaw = yaw0 + (rand() - 0.5) * 0.6
    // round silver-dollar leaf: a short wide petal with a rounded tip
    const g = petalGeometry({ length: 0.022, width: 0.02, curl: 0.4, cup: -0.06, segsU: 4, segsV: 5, tipPinch: 0.0, ruffle: 0.02 })
    const eul = new THREE.Euler(-1.1 + rand() * 0.3, yaw, side * 0.9, 'YXZ')
    const pos = new THREE.Vector3(Math.cos(yaw) * side * 0.004, y, -Math.sin(yaw) * side * 0.004)
    c.add(g, compose(frame, pos, eul, 0.8 + rand() * 0.4 - i * 0.02), 'eucalyptus')
  }
}

/** A rose leaf set: three leaflets on a short stalk. */
function roseLeaf(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const stalk = new THREE.CylinderGeometry(0.0009, 0.0011, 0.03, 4, 1)
  c.add(stalk, compose(frame, new THREE.Vector3(0, 0.015, 0), new THREE.Euler()), 'stem')
  for (let k = 0; k < 3; k++) {
    const g = petalGeometry({ length: 0.042, width: 0.026, curl: 0.55, cup: -0.1, segsU: 4, segsV: 6, tipPinch: 0.7, ruffle: 0.05 })
    const angle = (k - 1) * 0.9 + (rand() - 0.5) * 0.3
    const pos = new THREE.Vector3(Math.sin(angle) * 0.004, 0.028 - Math.abs(k - 1) * 0.012, 0)
    c.add(g, compose(frame, pos, new THREE.Euler(-1.15, angle, 0, 'YXZ'), 0.9 + rand() * 0.25), 'roseLeaf')
  }
}

/** Trailing vine draping over the vase rim and down its side. */
function vine(c: Collector, rimPoint: THREE.Vector3, outward: THREE.Vector3, rand: Rand) {
  const p1 = rimPoint.clone().addScaledVector(outward, 0.045).add(new THREE.Vector3(0, 0.01, 0))
  const p2 = p1.clone().addScaledVector(outward, 0.03).add(new THREE.Vector3(0, -0.07, 0))
  const p3 = p2.clone().addScaledVector(outward, -0.015).add(new THREE.Vector3(0, -0.07 - rand() * 0.04, 0))
  // Start inside the mouth, then arc over the lip before draping outside.
  const root = rimPoint.clone().addScaledVector(outward, -0.016).add(new THREE.Vector3(0, -0.02, 0))
  const curve = new THREE.CatmullRomCurve3([root, rimPoint, p1, p2, p3])
  c.add(new THREE.TubeGeometry(curve, 16, 0.0012, 5, false), new THREE.Matrix4(), 'stem')
  for (let i = 0; i < 16; i++) {
    const t = 0.22 + (i / 16) * 0.77
    const f = frameAt(curve, t, rand() * Math.PI * 2)
    const g = petalGeometry({ length: 0.026 - i * 0.0007, width: 0.021 - i * 0.0006, curl: 0.5, cup: -0.08, segsU: 3, segsV: 5, tipPinch: 0.55, ruffle: 0.03 })
    const side = i % 2 === 0 ? 1 : -1
    c.add(g, compose(f, new THREE.Vector3(0, 0, 0), new THREE.Euler(-1.2 + rand() * 0.4, side * 1.2, 0, 'YXZ')), 'vineLeaf')
  }
}

// ---------------------------------------------------------------- stems & vase

function stem(c: Collector, points: THREE.Vector3[], radius: number) {
  const curve = new THREE.CatmullRomCurve3(points)
  c.add(new THREE.TubeGeometry(curve, 24, radius, 6, false), new THREE.Matrix4(), 'stem')
  return curve
}

function frameAt(curve: THREE.Curve<THREE.Vector3>, t: number, yaw = 0) {
  const pos = curve.getPoint(t)
  const tangent = curve.getTangent(t).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, tangent)
  if (yaw) q.multiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw))
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1))
}

const VASE_H = 0.25
const FLUTES = 22
const FLUTE_AMP = 0.03

/** Vase silhouette: radius at height t∈[0,1]. Foot, full belly, waist, flared lip. */
const vaseProfile = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0.046, 0, 0),
  new THREE.Vector3(0.07, 0.1, 0),
  new THREE.Vector3(0.088, 0.36, 0),
  new THREE.Vector3(0.072, 0.62, 0),
  new THREE.Vector3(0.054, 0.82, 0),
  new THREE.Vector3(0.06, 0.96, 0),
  new THREE.Vector3(0.064, 1, 0),
])
function vaseRadius(t: number) {
  // the curve is parametrised by arc length, so search for the height
  let lo = 0
  let hi = 1
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (vaseProfile.getPoint(mid).y < t) lo = mid
    else hi = mid
  }
  return vaseProfile.getPoint((lo + hi) / 2).x
}

function vase(c: Collector) {
  const radial = 88
  const rows = 24
  const outer = new THREE.CylinderGeometry(1, 1, 1, radial, rows, true)
  const pos = outer.attributes.position as THREE.BufferAttribute
  const uv = outer.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) + 0.5
    const angle = Math.atan2(pos.getZ(i), pos.getX(i))
    // flutes fade out at the foot and lip
    const fade = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.04) / 0.92)))
    const r = vaseRadius(t) * (1 + FLUTE_AMP * Math.pow(0.5 + 0.5 * Math.sin(FLUTES * angle), 1.6) * fade)
    pos.setXYZ(i, Math.cos(angle) * r, t * VASE_H, Math.sin(angle) * r)
    uv.setXY(i, (angle / Math.PI + 1) * 1.5, t)
  }
  outer.computeVertexNormals()
  c.add(outer, new THREE.Matrix4(), 'vase')

  // inner wall, seen when looking down past the flowers
  const inner = new THREE.CylinderGeometry(1, 1, 1, 48, 6, true)
  const ip = inner.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < ip.count; i++) {
    const t = ip.getY(i) + 0.5
    const angle = Math.atan2(ip.getZ(i), ip.getX(i))
    const h = 0.55 + t * 0.45
    const r = vaseRadius(h) - 0.004
    ip.setXYZ(i, Math.cos(angle) * r, h * VASE_H, Math.sin(angle) * r)
  }
  c.add(inner, new THREE.Matrix4(), 'vaseInside')

  // foot and a water line inside
  const foot = new THREE.CircleGeometry(vaseRadius(0) * 1.01, 48)
  c.add(foot, compose(new THREE.Matrix4(), new THREE.Vector3(0, 0.0005, 0), new THREE.Euler(-Math.PI / 2, 0, 0)), 'vase')
  const water = new THREE.CircleGeometry(vaseRadius(0.68) - 0.004, 48)
  c.add(water, compose(new THREE.Matrix4(), new THREE.Vector3(0, 0.68 * VASE_H, 0), new THREE.Euler(-Math.PI / 2, 0, 0)), 'vaseInside')

  // gold lip
  const lipR = vaseRadius(1) * (1 + FLUTE_AMP * 0.1)
  const lip = new THREE.TorusGeometry(lipR, 0.0032, 10, 72)
  c.add(lip, compose(new THREE.Matrix4(), new THREE.Vector3(0, VASE_H, 0), new THREE.Euler(Math.PI / 2, 0, 0)), 'gold')
  const footRing = new THREE.TorusGeometry(vaseRadius(0.02), 0.002, 8, 72)
  c.add(footRing, compose(new THREE.Matrix4(), new THREE.Vector3(0, 0.005, 0), new THREE.Euler(Math.PI / 2, 0, 0)), 'gold')
}

/** The name in raised gold lettering, wrapped around the belly of the vase. */
function vaseName(c: Collector, name: string, font: Font) {
  const size = 0.024
  const text = new TextGeometry(name, { font, size, depth: 0.0022, curveSegments: 3, bevelEnabled: true, bevelThickness: 0.0004, bevelSize: 0.0003, bevelSegments: 1 })
  text.computeBoundingBox()
  const bb = text.boundingBox!
  const w = bb.max.x - bb.min.x
  const h = bb.max.y - bb.min.y
  const yCenter = 0.4 * VASE_H
  // fit long names by shrinking to at most ~120° of the belly
  const R0 = vaseRadius(0.4) * (1 + FLUTE_AMP)
  const maxW = R0 * 2.1
  const s = Math.min(1, maxW / w)
  text.scale(s, s, 1)
  text.translate(-(bb.min.x + w / 2) * s, yCenter - (bb.min.y + h / 2) * s, 0)
  const p = text.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const R = vaseRadius(y / VASE_H) * (1 + FLUTE_AMP) + 0.0003 + z
    const theta = x / R0
    p.setXYZ(i, R * Math.sin(theta), y, R * Math.cos(theta))
  }
  c.add(text, new THREE.Matrix4(), 'gold')
}

// ---------------------------------------------------------------- arrangement

export interface BouquetResult {
  group: THREE.Group
  materials: Record<MatKey, THREE.MeshPhysicalMaterial>
  /** Overall height in meters. */
  height: number
}

export function buildBouquet(name: string): BouquetResult {
  const rand = makeRandom(hashString(name.toLowerCase()))
  const font = new Font(tagFontData as unknown as ConstructorParameters<typeof Font>[0])
  const c = new Collector()
  const materials = makeMaterials()

  vase(c)
  vaseName(c, name, font)

  const RIM_Y = VASE_H
  const NECK_R = vaseRadius(0.82) - 0.008
  const DOME_R = 0.17

  type Kind = 'roseCrimson' | 'roseApricot' | 'roseBlush' | 'peony' | 'ranunculus' | 'lisianthus' | 'tulip' | 'hypericum' | 'eucalyptus' | 'babys'
  const plan: Kind[] = [
    ...Array<Kind>(4).fill('roseCrimson'),
    ...Array<Kind>(4).fill('roseApricot'),
    ...Array<Kind>(4).fill('roseBlush'),
    ...Array<Kind>(3).fill('peony'),
    ...Array<Kind>(5).fill('ranunculus'),
    ...Array<Kind>(5).fill('lisianthus'),
    ...Array<Kind>(4).fill('tulip'),
    ...Array<Kind>(4).fill('hypericum'),
    ...Array<Kind>(4).fill('eucalyptus'),
    ...Array<Kind>(4).fill('babys'),
  ]
  // showy blooms take the middle of the dome; texture and greenery ride the rim
  const rank: Record<Kind, number> = { peony: 0.6, roseCrimson: 0.5, roseApricot: 0.8, roseBlush: 0.9, ranunculus: 1.6, tulip: 1.9, lisianthus: 2.2, eucalyptus: 2.8, babys: 3.2, hypericum: 3.6 }
  // shuffle within rank so colors intermix
  const order = plan.map((k, i) => ({ k, key: rank[k] + rand() * 0.9, i })).sort((a, b) => a.key - b.key).map((o) => o.k)

  const n = order.length
  const startAngle = rand() * Math.PI * 2
  order.forEach((kind, i) => {
    const t = (i + 0.5) / n
    const angle = startAngle + i * GOLDEN
    const r = DOME_R * Math.sqrt(t) * (0.9 + rand() * 0.2)
    const lift = kind === 'babys' ? 0.015 : kind === 'eucalyptus' ? -0.03 : kind === 'hypericum' ? -0.015 : kind === 'peony' ? 0.005 : kind === 'tulip' ? 0.03 : 0
    // a low, wide dome that sits right on the rim and spills past it
    const y = RIM_Y + 0.105 - 0.085 * (r / DOME_R) ** 2 + lift + (rand() - 0.5) * 0.02
    const head = new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r)

    const foot = new THREE.Vector3((rand() - 0.5) * 0.04, 0.03, (rand() - 0.5) * 0.04)
    const neck = new THREE.Vector3(Math.cos(angle) * NECK_R * (0.3 + 0.7 * Math.sqrt(t)), 0.82 * VASE_H, Math.sin(angle) * NECK_R * (0.3 + 0.7 * Math.sqrt(t)))
    const thick = kind.startsWith('rose') || kind === 'peony' || kind === 'tulip' ? 0.003 : 0.0018
    // Every stem clears the vase opening before fanning out toward its bloom.
    const mouth = neck.clone().setY(RIM_Y + 0.02)
    const shoulder = head.clone().lerp(mouth, 0.45)
    shoulder.y = Math.max(shoulder.y, RIM_Y + 0.03)
    const curve = stem(c, [foot, neck, mouth, shoulder, head], thick)
    const frame = frameAt(curve, 1)

    switch (kind) {
      case 'roseCrimson':
      case 'roseApricot':
      case 'roseBlush':
        rose(c, frame, rand, kind, 0.95 + rand() * 0.2)
        if (i % 2 === 0) roseLeaf(c, frameAt(curve, 0.86, angle + Math.PI / 2), rand)
        break
      case 'peony':
        peony(c, frame, rand, 0.82 + rand() * 0.12)
        break
      case 'ranunculus':
        ranunculus(c, frame, rand, 0.9 + rand() * 0.2)
        break
      case 'lisianthus':
        lisianthus(c, frame, rand, 0.9 + rand() * 0.2)
        break
      case 'tulip':
        tulip(c, frame, rand, 0.95 + rand() * 0.15)
        tulipLeaf(c, frameAt(curve, 0.86), rand)
        break
      case 'hypericum':
        hypericum(c, frame, rand)
        break
      case 'eucalyptus':
        eucalyptus(c, frame, rand)
        break
      case 'babys':
        babysBreath(c, frame, rand)
        break
    }
  })

  // three vines trailing over the rim
  for (let k = 0; k < 3; k++) {
    const a = startAngle + 0.9 + k * 2.1 + rand() * 0.6
    const outward = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
    const rimPoint = outward.clone().multiplyScalar(vaseRadius(1) - 0.006).setY(RIM_Y + 0.02)
    vine(c, rimPoint, outward, rand)
  }

  const group = c.build(materials)
  return { group, materials, height: RIM_Y + 0.2 }
}

/** A single loose petal, for the page's falling-petal effect (not exported). */
export function loosePetalGeometry() {
  return petalGeometry({ length: 0.032, width: 0.03, curl: 1.1, cup: 0.4, segsU: 4, segsV: 6, tipPinch: 0.1, ruffle: 0.05 })
}
