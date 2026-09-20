// Procedural hand-tied bouquet. Everything is geometry + solid
// MeshStandardMaterials so it exports cleanly to GLB (Android) and USDZ
// (iOS Quick Look). Units are meters; the origin is at the bottom of the
// stems so the bouquet sits on a table in AR.

import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { Font } from 'three/addons/loaders/FontLoader.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import tagFontData from './tag-font.json'

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

type Rand = () => number

// ---------------------------------------------------------------- materials

const PALETTE = {
  roseOuter: '#f3bcc6',
  roseInner: '#e58aa0',
  ranunculusOuter: '#f6b58f',
  ranunculusInner: '#ec8a68',
  cosmosPetal: '#fbf6ec',
  cosmosBlush: '#f7d5dc',
  pollen: '#e8b53c',
  lavender: '#9c8bc9',
  lavenderDeep: '#7d68b3',
  babysBreath: '#fdfbf6',
  sage: '#94ad97',
  stem: '#5e8a5a',
  kraft: '#c8a679',
  kraftInner: '#eadbbf',
  ribbon: '#8e3a4b',
  tag: '#f7f0e3',
  ink: '#3a2c2c',
  string: '#d8c8a8',
} as const

type MatKey = keyof typeof PALETTE

// Thin, open surfaces (petals, leaves, paper) need to be visible from both
// sides. USDZ/Quick Look does not reliably honor double-sided materials, so
// instead of `side: DoubleSide` we bake a flipped copy of those surfaces.
const TWO_SIDED = new Set<MatKey>(['roseOuter', 'roseInner', 'ranunculusOuter', 'ranunculusInner', 'cosmosPetal', 'cosmosBlush', 'sage', 'kraft', 'kraftInner'])

function makeMaterials(): Record<MatKey, THREE.MeshStandardMaterial> {
  const out = {} as Record<MatKey, THREE.MeshStandardMaterial>
  for (const key of Object.keys(PALETTE) as MatKey[]) {
    out[key] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[key]),
      roughness: key === 'ribbon' ? 0.45 : key === 'ink' ? 0.6 : 0.85,
      metalness: 0,
    })
    out[key].name = key
  }
  return out
}

/** A copy of `g` with reversed winding and normals: its back face. */
function flipped(g: THREE.BufferGeometry) {
  const f = g.clone()
  const idx = f.index!
  const arr = idx.array
  for (let i = 0; i < arr.length; i += 3) {
    const t = arr[i + 1]
    arr[i + 1] = arr[i + 2]
    arr[i + 2] = t
  }
  idx.needsUpdate = true
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
    g.deleteAttribute('uv')
    g.computeVertexNormals()
    let list = this.buckets.get(key)
    if (!list) {
      list = []
      this.buckets.set(key, list)
    }
    list.push(g)
    if (TWO_SIDED.has(key)) list.push(flipped(g))
  }

  build(materials: Record<MatKey, THREE.MeshStandardMaterial>) {
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
  cup: number // how much the petal cups across its width
  segsU?: number
  segsV?: number
  tipPinch?: number
}

/** A single curved petal in the XY plane, base at the origin, growing along +Y. */
function petalGeometry(o: PetalOpts) {
  const segsU = o.segsU ?? 5
  const segsV = o.segsV ?? 8
  const positions: number[] = []
  const indices: number[] = []
  const tipPinch = o.tipPinch ?? 0.35
  for (let j = 0; j <= segsV; j++) {
    const v = j / segsV
    // width profile: narrow base, widest ~60% up, soft rounded tip
    const profile = Math.max(0.12, Math.pow(Math.sin(Math.PI * (0.08 + 0.92 * v)), 0.6)) * (1 - tipPinch * Math.pow(v, 6))
    const theta = o.curl * v
    const arc = o.curl > 1e-4 ? o.length / o.curl : o.length
    const y = o.curl > 1e-4 ? arc * Math.sin(theta) : o.length * v
    const zBend = o.curl > 1e-4 ? arc * (1 - Math.cos(theta)) : 0
    for (let i = 0; i <= segsU; i++) {
      const u = (i / segsU) * 2 - 1
      const x = u * (o.width / 2) * profile
      // cup across the width, plus a soft ruffle toward the tip edge
      const z = zBend + o.cup * u * u * (0.35 + 0.65 * v) * o.width + 0.06 * o.width * Math.sin(u * Math.PI * 1.5) * v * v * v
      positions.push(x, y, z)
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
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------- flower heads
// Each head builder adds geometry into the collector at `frame`, a matrix whose
// +Y axis points along the flower's stem direction (up and out of the bouquet).

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)

function compose(frame: THREE.Matrix4, position: THREE.Vector3, euler: THREE.Euler, scale = 1) {
  _q.setFromEuler(euler)
  _s.setScalar(scale)
  _m.compose(position, _q, _s)
  return new THREE.Matrix4().multiplyMatrices(frame, _m)
}

function spiralHead(
  c: Collector,
  frame: THREE.Matrix4,
  rand: Rand,
  cfg: {
    petals: number
    innerKey: MatKey
    outerKey: MatKey
    innerShare: number
    radius: [number, number]
    length: [number, number]
    width: [number, number]
    tilt: [number, number]
    curl: [number, number]
    cup: number
    segsU: number
    segsV: number
    jitter: number
  },
) {
  const start = rand() * Math.PI * 2
  for (let i = 0; i < cfg.petals; i++) {
    const t = i / (cfg.petals - 1)
    const ease = t * t * (3 - 2 * t)
    const angle = start + i * GOLDEN
    const r = THREE.MathUtils.lerp(cfg.radius[0], cfg.radius[1], ease)
    const len = THREE.MathUtils.lerp(cfg.length[0], cfg.length[1], ease) * (1 + (rand() - 0.5) * cfg.jitter)
    const wid = THREE.MathUtils.lerp(cfg.width[0], cfg.width[1], ease) * (1 + (rand() - 0.5) * cfg.jitter)
    const tilt = THREE.MathUtils.lerp(cfg.tilt[0], cfg.tilt[1], ease) + (rand() - 0.5) * 0.12
    const curl = THREE.MathUtils.lerp(cfg.curl[0], cfg.curl[1], ease)
    const g = petalGeometry({ length: len, width: wid, curl, cup: cfg.cup, segsU: cfg.segsU, segsV: cfg.segsV })
    _p.set(Math.cos(angle) * r, -0.002 + ease * 0.003, Math.sin(angle) * r)
    // yaw so the petal faces outward from the center, then tilt it open
    _e.set(0, -angle + Math.PI / 2, 0, 'YXZ')
    const yaw = new THREE.Quaternion().setFromEuler(_e)
    const open = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt)
    yaw.multiply(open)
    _s.setScalar(1)
    _m.compose(_p, yaw, _s)
    const world = new THREE.Matrix4().multiplyMatrices(frame, _m)
    c.add(g, world, t < cfg.innerShare ? cfg.innerKey : cfg.outerKey)
  }
}

function gardenRose(c: Collector, frame: THREE.Matrix4, rand: Rand, scale = 1) {
  const s = scale
  spiralHead(c, frame, rand, {
    petals: 26,
    innerKey: 'roseInner',
    outerKey: 'roseOuter',
    innerShare: 0.42,
    radius: [0.003 * s, 0.02 * s],
    length: [0.022 * s, 0.038 * s],
    width: [0.016 * s, 0.036 * s],
    tilt: [0.12, 1.25],
    curl: [0.25, 1.6],
    cup: 0.32,
    segsU: 5,
    segsV: 8,
    jitter: 0.12,
  })
}

function ranunculus(c: Collector, frame: THREE.Matrix4, rand: Rand, scale = 1) {
  const s = scale
  spiralHead(c, frame, rand, {
    petals: 30,
    innerKey: 'ranunculusInner',
    outerKey: 'ranunculusOuter',
    innerShare: 0.35,
    radius: [0.002 * s, 0.017 * s],
    length: [0.012 * s, 0.024 * s],
    width: [0.014 * s, 0.03 * s],
    tilt: [0.35, 1.45],
    curl: [0.2, 0.9],
    cup: 0.25,
    segsU: 4,
    segsV: 6,
    jitter: 0.1,
  })
}

function cosmos(c: Collector, frame: THREE.Matrix4, rand: Rand, key: MatKey, scale = 1) {
  const s = scale
  const start = rand() * Math.PI * 2
  for (let ring = 0; ring < 2; ring++) {
    const n = 8
    for (let i = 0; i < n; i++) {
      const angle = start + (i / n) * Math.PI * 2 + ring * (Math.PI / n)
      const len = (0.024 - ring * 0.003) * s * (1 + (rand() - 0.5) * 0.1)
      const g = petalGeometry({ length: len, width: 0.013 * s, curl: 0.55, cup: 0.18, segsU: 3, segsV: 5, tipPinch: 0.15 })
      _p.set(Math.cos(angle) * 0.004 * s, -ring * 0.0015, Math.sin(angle) * 0.004 * s)
      _e.set(0, -angle + Math.PI / 2, 0, 'YXZ')
      const yaw = new THREE.Quaternion().setFromEuler(_e)
      const open = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.3 + ring * 0.15 + (rand() - 0.5) * 0.1)
      yaw.multiply(open)
      _s.setScalar(1)
      _m.compose(_p, yaw, _s)
      c.add(g, new THREE.Matrix4().multiplyMatrices(frame, _m), key)
    }
  }
  const center = new THREE.SphereGeometry(0.0055 * s, 12, 8)
  center.scale(1, 0.6, 1)
  c.add(center, compose(frame, new THREE.Vector3(0, 0.001, 0), new THREE.Euler()), 'pollen')
}

function lavender(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const bud = new THREE.IcosahedronGeometry(0.0032, 1)
  bud.scale(0.8, 1.25, 0.8)
  const whorls = 7
  for (let w = 0; w < whorls; w++) {
    const y = w * 0.0075
    const spread = 0.004 * (1 - w / whorls * 0.35)
    for (let k = 0; k < 4; k++) {
      const angle = (k / 4) * Math.PI * 2 + w * 0.7 + rand() * 0.3
      const pos = new THREE.Vector3(Math.cos(angle) * spread, y, Math.sin(angle) * spread)
      const eul = new THREE.Euler(Math.cos(angle) * 0.5, 0, -Math.sin(angle) * 0.5)
      c.add(bud.clone(), compose(frame, pos, eul, 0.85 + rand() * 0.3), w % 2 === 0 ? 'lavender' : 'lavenderDeep')
    }
  }
  const tip = new THREE.ConeGeometry(0.0025, 0.008, 6)
  c.add(tip, compose(frame, new THREE.Vector3(0, whorls * 0.0075 + 0.002, 0), new THREE.Euler()), 'lavenderDeep')
}

function babysBreath(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const blob = new THREE.IcosahedronGeometry(0.0028, 0)
  const twig = new THREE.CylinderGeometry(0.0005, 0.0006, 1, 4, 1)
  for (let i = 0; i < 9; i++) {
    const angle = rand() * Math.PI * 2
    const spread = 0.008 + rand() * 0.022
    const height = 0.01 + rand() * 0.03
    const end = new THREE.Vector3(Math.cos(angle) * spread, height, Math.sin(angle) * spread)
    // twig from base to blob
    const len = end.length()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().normalize())
    const mid = end.clone().multiplyScalar(0.5)
    const tm = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, len, 1))
    c.add(twig.clone(), new THREE.Matrix4().multiplyMatrices(frame, tm), 'stem')
    for (let b = 0; b < 3; b++) {
      const off = new THREE.Vector3((rand() - 0.5) * 0.006, (rand() - 0.5) * 0.006, (rand() - 0.5) * 0.006)
      c.add(blob.clone(), compose(frame, end.clone().add(off), new THREE.Euler(rand() * 3, rand() * 3, 0), 0.7 + rand() * 0.6), 'babysBreath')
    }
  }
}

function eucalyptus(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const leaf = new THREE.CircleGeometry(0.0075, 10)
  leaf.scale(1, 1.2, 1)
  const stalk = new THREE.CylinderGeometry(0.001, 0.0014, 0.09, 5, 1)
  c.add(stalk, compose(frame, new THREE.Vector3(0, 0.045, 0), new THREE.Euler()), 'stem')
  const yaw0 = rand() * Math.PI * 2
  for (let i = 0; i < 11; i++) {
    const y = 0.006 + i * 0.008
    const side = i % 2 === 0 ? 1 : -1
    const yaw = yaw0 + (rand() - 0.5) * 0.6
    const eul = new THREE.Euler(-0.4 + rand() * 0.3, yaw, side * 0.95, 'YXZ')
    const pos = new THREE.Vector3(Math.cos(yaw) * side * 0.007, y, -Math.sin(yaw) * side * 0.007)
    c.add(leaf.clone(), compose(frame, pos, eul, 0.8 + rand() * 0.35), 'sage')
  }
}

// ---------------------------------------------------------------- stems & wrap

function stem(c: Collector, from: THREE.Vector3, to: THREE.Vector3, rand: Rand, radius = 0.0025) {
  const mid = from.clone().lerp(to, 0.5)
  mid.x += (rand() - 0.5) * 0.02
  mid.z += (rand() - 0.5) * 0.02
  const curve = new THREE.CatmullRomCurve3([from, mid, to])
  const g = new THREE.TubeGeometry(curve, 10, radius, 6, false)
  c.add(g, new THREE.Matrix4(), 'stem')
  return curve
}

function frameAt(curve: THREE.Curve<THREE.Vector3>, t: number) {
  const pos = curve.getPoint(t)
  const tangent = curve.getTangent(t).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent)
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1))
}

/**
 * Paper wrap: a skirt below the binding point, pinched to `bindR` at `bindY`,
 * then flaring to `topR` at `topY` with a gently waved rim.
 */
function wrap(
  c: Collector,
  key: MatKey,
  o: { bottomY: number; bindY: number; topY: number; skirtR: number; bindR: number; topR: number; waves: number; phase: number },
) {
  const radial = 48
  const rows = 10
  const g = new THREE.CylinderGeometry(1, 1, 1, radial, rows, true)
  const pos = g.attributes.position as THREE.BufferAttribute
  const smooth = (t: number) => t * t * (3 - 2 * t)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i) + 0.5 // 0..1 bottom→top
    const z = pos.getZ(i)
    const angle = Math.atan2(z, x)
    const height = o.bottomY + (o.topY - o.bottomY) * y
    let r: number
    let rim = 0
    if (height <= o.bindY) {
      const t = (height - o.bottomY) / (o.bindY - o.bottomY)
      r = THREE.MathUtils.lerp(o.skirtR, o.bindR, smooth(t))
    } else {
      const t = (height - o.bindY) / (o.topY - o.bindY)
      r = THREE.MathUtils.lerp(o.bindR, o.topR, Math.pow(t, 1.25))
      rim = t * t
    }
    const wave = 1 + 0.05 * Math.sin(o.waves * angle + o.phase) * rim
    pos.setXYZ(i, Math.cos(angle) * r * wave, height + 0.014 * Math.sin(o.waves * angle + o.phase) * rim, Math.sin(angle) * r * wave)
  }
  g.computeVertexNormals()
  c.add(g, new THREE.Matrix4(), key)
}

function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape()
  s.moveTo(-w / 2 + r, -h / 2)
  s.lineTo(w / 2 - r, -h / 2)
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r)
  s.lineTo(w / 2, h / 2 - r)
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
  s.lineTo(-w / 2 + r, h / 2)
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
  s.lineTo(-w / 2, -h / 2 + r)
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2)
  return s
}

function ribbonAndBow(c: Collector, y: number, radius: number, rand: Rand) {
  // band around the binding point
  const band = new THREE.CylinderGeometry(radius, radius * 1.04, 0.022, 48, 1, true)
  c.add(band, compose(new THREE.Matrix4(), new THREE.Vector3(0, y, 0), new THREE.Euler()), 'ribbon')
  // knot on the front
  const knotPos = new THREE.Vector3(0, y, radius + 0.004)
  const knot = new THREE.SphereGeometry(0.0085, 12, 8)
  knot.scale(1.2, 0.8, 0.8)
  c.add(knot, compose(new THREE.Matrix4(), knotPos, new THREE.Euler()), 'ribbon')
  // two loops
  for (const side of [-1, 1]) {
    const loop = new THREE.TorusGeometry(0.02, 0.0045, 8, 24)
    loop.scale(1, 0.55, 0.35)
    const pos = knotPos.clone().add(new THREE.Vector3(side * 0.022, 0.004, 0.002))
    c.add(loop, compose(new THREE.Matrix4(), pos, new THREE.Euler(0.15, side * 0.35, side * 0.55)), 'ribbon')
  }
  // two tails with notched ends
  for (const side of [-1, 1]) {
    const tail = new THREE.Shape()
    const w = 0.014
    const len = 0.075 + rand() * 0.02
    tail.moveTo(-w / 2, 0)
    tail.lineTo(w / 2, 0)
    tail.lineTo(w / 2, -len)
    tail.lineTo(0, -len + 0.01)
    tail.lineTo(-w / 2, -len)
    tail.closePath()
    const g = new THREE.ExtrudeGeometry(tail, { depth: 0.0012, bevelEnabled: false, steps: 1 })
    const pos = knotPos.clone().add(new THREE.Vector3(side * 0.009, -0.004, 0.003))
    c.add(g, compose(new THREE.Matrix4(), pos, new THREE.Euler(-0.25, side * 0.15, side * 0.28)), 'ribbon')
  }
  return knotPos
}

function nameTag(c: Collector, name: string, anchor: THREE.Vector3, font: Font) {
  const textSize = 0.0155
  const text = new TextGeometry(name, { font, size: textSize, depth: 0.0012, curveSegments: 4, bevelEnabled: false })
  text.computeBoundingBox()
  const bb = text.boundingBox!
  const textW = bb.max.x - bb.min.x
  const textH = bb.max.y - bb.min.y
  const pad = 0.011
  const tagW = Math.max(0.06, textW + pad * 2 + 0.008)
  const tagH = Math.max(0.034, textH + pad * 2)
  const cardShape = roundedRect(tagW, tagH, 0.005)
  const hole = new THREE.Path()
  hole.absarc(-tagW / 2 + 0.007, 0, 0.0022, 0, Math.PI * 2, true)
  cardShape.holes.push(hole)
  const card = new THREE.ExtrudeGeometry(cardShape, { depth: 0.0018, bevelEnabled: false, steps: 1 })

  // tag hangs down-right from the knot, tilted so it reads from the front
  const tagCenter = anchor.clone().add(new THREE.Vector3(0.052, -0.068, 0.016))
  const tilt = new THREE.Euler(-0.1, 0.22, -0.32, 'YXZ')
  const cardM = compose(new THREE.Matrix4(), tagCenter, tilt)
  c.add(card, cardM, 'tag')

  // text centered on the card, in front of it
  text.translate(-(bb.min.x + textW / 2) + 0.004, -(bb.min.y + textH / 2), 0.0018)
  c.add(text, cardM.clone(), 'ink')

  // string from the knot to the tag hole
  const holeLocal = new THREE.Vector3(-tagW / 2 + 0.007, 0, 0.0009).applyMatrix4(cardM)
  const knotOut = anchor.clone().add(new THREE.Vector3(0, -0.002, 0.004))
  const sag = knotOut.clone().lerp(holeLocal, 0.5).add(new THREE.Vector3(0.004, -0.012, 0.006))
  const curve = new THREE.CatmullRomCurve3([knotOut, sag, holeLocal])
  c.add(new THREE.TubeGeometry(curve, 8, 0.0008, 5, false), new THREE.Matrix4(), 'string')
}

// ---------------------------------------------------------------- bouquet

export interface BouquetResult {
  group: THREE.Group
  materials: Record<MatKey, THREE.MeshStandardMaterial>
  height: number
}

export function buildBouquet(name: string): BouquetResult {
  const rand = makeRandom(hashString(name.toLowerCase()))
  const font = new Font(tagFontData as unknown as ConstructorParameters<typeof Font>[0])
  const c = new Collector()
  const materials = makeMaterials()

  const BIND_Y = 0.15
  const BIND_R = 0.028
  const DOME_R = 0.13

  type Kind = 'rose' | 'ranunculus' | 'cosmos' | 'cosmosBlush' | 'lavender' | 'euc' | 'babys'
  const plan: Kind[] = [
    'rose', 'rose', 'rose', 'rose',
    'ranunculus', 'ranunculus', 'ranunculus', 'ranunculus',
    'cosmos', 'cosmosBlush', 'cosmos', 'cosmosBlush', 'cosmos',
    'lavender', 'lavender', 'lavender', 'lavender', 'lavender',
    'euc', 'euc', 'euc', 'euc',
    'babys', 'babys', 'babys',
  ]
  // Sort so the showy heads take the middle of the dome and greenery the rim.
  const rank: Record<Kind, number> = { rose: 0, ranunculus: 1, cosmos: 2, cosmosBlush: 2, babys: 3, lavender: 4, euc: 5 }
  plan.sort((a, b) => rank[a] - rank[b])

  const n = plan.length
  const startAngle = rand() * Math.PI * 2
  plan.forEach((kind, i) => {
    const t = (i + 0.5) / n
    const angle = startAngle + i * GOLDEN
    const r = DOME_R * Math.sqrt(t) * (0.92 + rand() * 0.16)
    const lift = kind === 'lavender' ? 0.06 : kind === 'euc' ? 0.01 : kind === 'babys' ? 0.02 : 0
    const y = 0.345 - 0.08 * (r / DOME_R) ** 2 + lift + (rand() - 0.5) * 0.025
    const head = new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r)

    const base = new THREE.Vector3(Math.cos(angle) * BIND_R * 0.5 * rand(), BIND_Y, Math.sin(angle) * BIND_R * 0.5 * rand())
    const foot = new THREE.Vector3(Math.cos(angle) * BIND_R * 1.15, 0.0, Math.sin(angle) * BIND_R * 1.15)
    // stem below the binding point down to the table
    const lower = new THREE.CatmullRomCurve3([foot, base.clone().setY(BIND_Y * 0.5), base])
    c.add(new THREE.TubeGeometry(lower, 6, 0.0024, 6, false), new THREE.Matrix4(), 'stem')

    const curve = stem(c, base, head, rand, kind === 'babys' ? 0.0015 : 0.0024)
    const frame = frameAt(curve, 1)

    switch (kind) {
      case 'rose':
        gardenRose(c, frame, rand, 0.95 + rand() * 0.15)
        break
      case 'ranunculus':
        ranunculus(c, frame, rand, 0.9 + rand() * 0.2)
        break
      case 'cosmos':
        cosmos(c, frame, rand, 'cosmosPetal', 0.9 + rand() * 0.2)
        break
      case 'cosmosBlush':
        cosmos(c, frame, rand, 'cosmosBlush', 0.85 + rand() * 0.2)
        break
      case 'lavender':
        lavender(c, frame, rand)
        break
      case 'euc':
        eucalyptus(c, frame, rand)
        break
      case 'babys':
        babysBreath(c, frame, rand)
        break
    }
  })

  // paper: inner cream tissue peeking above the outer kraft
  wrap(c, 'kraftInner', { bottomY: BIND_Y - 0.045, bindY: BIND_Y, topY: BIND_Y + 0.125, skirtR: 0.038, bindR: BIND_R * 1.0, topR: 0.105, waves: 4, phase: 1.3 })
  wrap(c, 'kraft', { bottomY: BIND_Y - 0.05, bindY: BIND_Y, topY: BIND_Y + 0.11, skirtR: 0.042, bindR: BIND_R * 1.04, topR: 0.115, waves: 5, phase: 0.2 })

  const knot = ribbonAndBow(c, BIND_Y, BIND_R * 1.12, rand)
  nameTag(c, name, knot, font)

  const group = c.build(materials)
  return { group, materials, height: 0.5 }
}
