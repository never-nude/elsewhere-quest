// Procedural dozen-rose bouquet. Everything is geometry + solid
// MeshStandardMaterials so it exports cleanly to GLB (Android) and USDZ
// (iOS Quick Look). Units are meters at real-world scale; the origin is at
// the bottom of the stems so the bouquet stands on a table in AR.

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

export const ROSE_COLORS = {
  red: { outer: '#c2263a', inner: '#861325' },
  pink: { outer: '#ee86a6', inner: '#d3527c' },
  blush: { outer: '#f3bcc6', inner: '#e58aa0' },
  coral: { outer: '#ef7a5e', inner: '#d4503b' },
  white: { outer: '#fbf6ee', inner: '#efe1cf' },
  yellow: { outer: '#f5c94a', inner: '#e3a02c' },
} as const

export type RoseColor = keyof typeof ROSE_COLORS
export const DEFAULT_ROSE_COLOR: RoseColor = 'red'

const PALETTE = {
  roseOuter: ROSE_COLORS.red.outer,
  roseInner: ROSE_COLORS.red.inner,
  sepal: '#4f7a48',
  leaf: '#3f6b3c',
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
const TWO_SIDED = new Set<MatKey>(['roseOuter', 'roseInner', 'sepal', 'leaf', 'sage', 'kraft', 'kraftInner'])

function makeMaterials(color: RoseColor): Record<MatKey, THREE.MeshStandardMaterial> {
  const out = {} as Record<MatKey, THREE.MeshStandardMaterial>
  const colors: Record<MatKey, string> = { ...PALETTE, roseOuter: ROSE_COLORS[color].outer, roseInner: ROSE_COLORS[color].inner }
  for (const key of Object.keys(PALETTE) as MatKey[]) {
    out[key] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors[key]),
      roughness: key === 'ribbon' ? 0.45 : key === 'ink' ? 0.6 : key === 'roseOuter' || key === 'roseInner' ? 0.7 : 0.85,
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
  ruffle?: number
}

/** A single curved petal in the XY plane, base at the origin, growing along +Y. */
function petalGeometry(o: PetalOpts) {
  const segsU = o.segsU ?? 4
  const segsV = o.segsV ?? 7
  const positions: number[] = []
  const indices: number[] = []
  const tipPinch = o.tipPinch ?? 0.35
  const ruffle = o.ruffle ?? 0.06
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
      const z = zBend + o.cup * u * u * (0.35 + 0.65 * v) * o.width + ruffle * o.width * Math.sin(u * Math.PI * 1.5) * v * v * v
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

// ---------------------------------------------------------------- heads
// Each head builder adds geometry into the collector at `frame`, a matrix whose
// +Y axis points along the flower's stem direction (up and out of the bouquet).

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const X_AXIS = new THREE.Vector3(1, 0, 0)

function compose(frame: THREE.Matrix4, position: THREE.Vector3, euler: THREE.Euler, scale = 1) {
  _q.setFromEuler(euler)
  _s.setScalar(scale)
  _m.compose(position, _q, _s)
  return new THREE.Matrix4().multiplyMatrices(frame, _m)
}

/** Place a petal-like piece around the head axis: yaw to face outward, then tilt open. */
function radial(frame: THREE.Matrix4, angle: number, r: number, y: number, tilt: number) {
  _p.set(Math.cos(angle) * r, y, Math.sin(angle) * r)
  _e.set(0, -angle + Math.PI / 2, 0, 'YXZ')
  const q = new THREE.Quaternion().setFromEuler(_e).multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, tilt))
  _s.setScalar(1)
  _m.compose(_p, q, _s)
  return new THREE.Matrix4().multiplyMatrices(frame, _m)
}

/**
 * A long-stem rose head, about 7 cm across when open: a tight spiral bud in
 * the middle, cupped mid petals, and outer petals that curl back at the tip.
 */
function rose(c: Collector, frame: THREE.Matrix4, rand: Rand, openness: number) {
  const petals = 28
  const start = rand() * Math.PI * 2
  for (let i = 0; i < petals; i++) {
    const t = i / (petals - 1)
    const ease = t * t * (3 - 2 * t)
    const angle = start + i * GOLDEN
    const r = THREE.MathUtils.lerp(0.002, 0.02, ease)
    const len = THREE.MathUtils.lerp(0.024, 0.036, ease) * (1 + (rand() - 0.5) * 0.08)
    const wid = THREE.MathUtils.lerp(0.022, 0.04, ease) * (1 + (rand() - 0.5) * 0.08)
    // inner petals stand almost upright; outer ones open to ~55° and fold back
    const tilt = THREE.MathUtils.lerp(0.05, 0.65 + 0.35 * openness, ease) + (rand() - 0.5) * 0.08
    const curl = THREE.MathUtils.lerp(0.35, 2.4, ease * ease)
    const cup = THREE.MathUtils.lerp(0.5, 0.3, ease)
    const g = petalGeometry({ length: len, width: wid, curl, cup, tipPinch: 0.12, ruffle: 0.03 })
    c.add(g, radial(frame, angle, r, 0.004 + ease * 0.006, tilt), t < 0.45 ? 'roseInner' : 'roseOuter')
  }
  // receptacle and five sepals under the bloom
  const hip = new THREE.SphereGeometry(0.008, 10, 8)
  hip.scale(1, 1.3, 1)
  c.add(hip, compose(frame, new THREE.Vector3(0, -0.002, 0), new THREE.Euler()), 'sepal')
  for (let k = 0; k < 5; k++) {
    const angle = start + (k / 5) * Math.PI * 2
    const g = petalGeometry({ length: 0.024, width: 0.007, curl: 0.9, cup: 0.1, segsU: 2, segsV: 4, tipPinch: 0.6, ruffle: 0 })
    c.add(g, radial(frame, angle, 0.007, 0.002, 1.5 + rand() * 0.25), 'sepal')
  }
}

/** A rose leaf: a serrated oval on a short midrib. */
function roseLeaf(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const cluster = 3
  const stalk = new THREE.CylinderGeometry(0.0009, 0.0011, 0.03, 4, 1)
  c.add(stalk, compose(frame, new THREE.Vector3(0, 0.015, 0), new THREE.Euler()), 'stem')
  for (let k = 0; k < cluster; k++) {
    const g = petalGeometry({ length: 0.045, width: 0.028, curl: 0.5, cup: -0.08, segsU: 4, segsV: 6, tipPinch: 0.75, ruffle: 0.04 })
    const angle = (k - 1) * 0.9 + (rand() - 0.5) * 0.3
    const pos = new THREE.Vector3(Math.sin(angle) * 0.004, 0.028 - Math.abs(k - 1) * 0.012, 0)
    const eul = new THREE.Euler(-1.15, angle, 0, 'YXZ')
    c.add(g, compose(frame, pos, eul, 0.9 + rand() * 0.25), 'leaf')
  }
}

function babysBreath(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const blob = new THREE.IcosahedronGeometry(0.003, 0)
  const twig = new THREE.CylinderGeometry(0.0005, 0.0006, 1, 4, 1)
  for (let i = 0; i < 10; i++) {
    const angle = rand() * Math.PI * 2
    const spread = 0.01 + rand() * 0.03
    const height = 0.01 + rand() * 0.04
    const end = new THREE.Vector3(Math.cos(angle) * spread, height, Math.sin(angle) * spread)
    const len = end.length()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().normalize())
    const mid = end.clone().multiplyScalar(0.5)
    const tm = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, len, 1))
    c.add(twig.clone(), new THREE.Matrix4().multiplyMatrices(frame, tm), 'stem')
    for (let b = 0; b < 3; b++) {
      const off = new THREE.Vector3((rand() - 0.5) * 0.007, (rand() - 0.5) * 0.007, (rand() - 0.5) * 0.007)
      c.add(blob.clone(), compose(frame, end.clone().add(off), new THREE.Euler(rand() * 3, rand() * 3, 0), 0.7 + rand() * 0.6), 'babysBreath')
    }
  }
}

function eucalyptus(c: Collector, frame: THREE.Matrix4, rand: Rand) {
  const leaf = new THREE.CircleGeometry(0.009, 10)
  leaf.scale(1, 1.2, 1)
  const stalk = new THREE.CylinderGeometry(0.001, 0.0014, 0.11, 5, 1)
  c.add(stalk, compose(frame, new THREE.Vector3(0, 0.055, 0), new THREE.Euler()), 'stem')
  const yaw0 = rand() * Math.PI * 2
  for (let i = 0; i < 11; i++) {
    const y = 0.006 + i * 0.01
    const side = i % 2 === 0 ? 1 : -1
    const yaw = yaw0 + (rand() - 0.5) * 0.6
    const eul = new THREE.Euler(-0.4 + rand() * 0.3, yaw, side * 0.95, 'YXZ')
    const pos = new THREE.Vector3(Math.cos(yaw) * side * 0.008, y, -Math.sin(yaw) * side * 0.008)
    c.add(leaf.clone(), compose(frame, pos, eul, 0.8 + rand() * 0.35), 'sage')
  }
}

// ---------------------------------------------------------------- stems & wrap

function stem(c: Collector, from: THREE.Vector3, to: THREE.Vector3, rand: Rand, radius = 0.003) {
  const mid = from.clone().lerp(to, 0.5)
  mid.x += (rand() - 0.5) * 0.02
  mid.z += (rand() - 0.5) * 0.02
  const curve = new THREE.CatmullRomCurve3([from, mid, to])
  const g = new THREE.TubeGeometry(curve, 10, radius, 6, false)
  c.add(g, new THREE.Matrix4(), 'stem')
  return curve
}

function frameAt(curve: THREE.Curve<THREE.Vector3>, t: number, yaw = 0) {
  const pos = curve.getPoint(t)
  const tangent = curve.getTangent(t).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent)
  if (yaw) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
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
    pos.setXYZ(i, Math.cos(angle) * r * wave, height + 0.016 * Math.sin(o.waves * angle + o.phase) * rim, Math.sin(angle) * r * wave)
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
  const band = new THREE.CylinderGeometry(radius, radius * 1.04, 0.025, 48, 1, true)
  c.add(band, compose(new THREE.Matrix4(), new THREE.Vector3(0, y, 0), new THREE.Euler()), 'ribbon')
  // knot on the front
  const knotPos = new THREE.Vector3(0, y, radius + 0.004)
  const knot = new THREE.SphereGeometry(0.0095, 12, 8)
  knot.scale(1.2, 0.8, 0.8)
  c.add(knot, compose(new THREE.Matrix4(), knotPos, new THREE.Euler()), 'ribbon')
  // two loops
  for (const side of [-1, 1]) {
    const loop = new THREE.TorusGeometry(0.023, 0.005, 8, 24)
    loop.scale(1, 0.55, 0.35)
    const pos = knotPos.clone().add(new THREE.Vector3(side * 0.025, 0.004, 0.002))
    c.add(loop, compose(new THREE.Matrix4(), pos, new THREE.Euler(0.15, side * 0.35, side * 0.55)), 'ribbon')
  }
  // two tails with notched ends
  for (const side of [-1, 1]) {
    const tail = new THREE.Shape()
    const w = 0.016
    const len = 0.09 + rand() * 0.025
    tail.moveTo(-w / 2, 0)
    tail.lineTo(w / 2, 0)
    tail.lineTo(w / 2, -len)
    tail.lineTo(0, -len + 0.011)
    tail.lineTo(-w / 2, -len)
    tail.closePath()
    const g = new THREE.ExtrudeGeometry(tail, { depth: 0.0012, bevelEnabled: false, steps: 1 })
    const pos = knotPos.clone().add(new THREE.Vector3(side * 0.01, -0.004, 0.003))
    c.add(g, compose(new THREE.Matrix4(), pos, new THREE.Euler(-0.25, side * 0.15, side * 0.28)), 'ribbon')
  }
  return knotPos
}

function nameTag(c: Collector, name: string, anchor: THREE.Vector3, font: Font) {
  const textSize = 0.017
  const text = new TextGeometry(name, { font, size: textSize, depth: 0.0012, curveSegments: 4, bevelEnabled: false })
  text.computeBoundingBox()
  const bb = text.boundingBox!
  const textW = bb.max.x - bb.min.x
  const textH = bb.max.y - bb.min.y
  const pad = 0.012
  const tagW = Math.max(0.065, textW + pad * 2 + 0.008)
  const tagH = Math.max(0.037, textH + pad * 2)
  const cardShape = roundedRect(tagW, tagH, 0.005)
  const hole = new THREE.Path()
  hole.absarc(-tagW / 2 + 0.007, 0, 0.0022, 0, Math.PI * 2, true)
  cardShape.holes.push(hole)
  const card = new THREE.ExtrudeGeometry(cardShape, { depth: 0.0018, bevelEnabled: false, steps: 1 })

  // tag hangs down-right from the knot, tilted so it reads from the front
  const tagCenter = anchor.clone().add(new THREE.Vector3(0.056, -0.074, 0.016))
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
  /** Overall height in meters. */
  height: number
}

export function buildBouquet(name: string, color: RoseColor = DEFAULT_ROSE_COLOR): BouquetResult {
  const rand = makeRandom(hashString(name.toLowerCase()))
  const font = new Font(tagFontData as unknown as ConstructorParameters<typeof Font>[0])
  const c = new Collector()
  const materials = makeMaterials(color)

  // Real-world proportions for a wrapped dozen: ~55 cm tall, ~28 cm across.
  const BIND_Y = 0.19
  const BIND_R = 0.03
  const DOME_R = 0.105

  type Kind = 'rose' | 'babys' | 'euc' | 'leaf'
  const plan: Kind[] = [
    ...Array<Kind>(12).fill('rose'),
    'babys', 'babys', 'babys', 'babys', 'babys',
    'euc', 'euc', 'euc', 'euc',
    'leaf', 'leaf', 'leaf', 'leaf',
  ]

  const n = plan.length
  const startAngle = rand() * Math.PI * 2
  plan.forEach((kind, i) => {
    // roses fill the dome from the centre out; fillers ride the rim
    const t = (i + 0.5) / n
    const angle = startAngle + i * GOLDEN
    const r = DOME_R * Math.sqrt(t) * (0.92 + rand() * 0.16)
    const lift = kind === 'babys' ? 0.01 : kind === 'euc' ? -0.035 : kind === 'leaf' ? -0.05 : 0
    const y = 0.445 - 0.07 * (r / DOME_R) ** 2 + lift + (rand() - 0.5) * 0.02
    const head = new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r)

    const base = new THREE.Vector3(Math.cos(angle) * BIND_R * 0.5 * rand(), BIND_Y, Math.sin(angle) * BIND_R * 0.5 * rand())
    const foot = new THREE.Vector3(Math.cos(angle) * BIND_R * 1.15, 0.0, Math.sin(angle) * BIND_R * 1.15)
    // stem below the binding point down to the table
    const lower = new THREE.CatmullRomCurve3([foot, base.clone().setY(BIND_Y * 0.5), base])
    const thick = kind === 'rose' ? 0.003 : 0.0018
    c.add(new THREE.TubeGeometry(lower, 6, thick, 6, false), new THREE.Matrix4(), 'stem')

    const curve = stem(c, base, head, rand, thick)
    const frame = frameAt(curve, 1)

    switch (kind) {
      case 'rose':
        rose(c, frame, rand, 0.6 + rand() * 0.4)
        // a leaf cluster part way up half the rose stems
        if (i % 2 === 0) roseLeaf(c, frameAt(curve, 0.8, angle + Math.PI / 2), rand)
        break
      case 'babys':
        babysBreath(c, frame, rand)
        break
      case 'euc':
        eucalyptus(c, frame, rand)
        break
      case 'leaf':
        roseLeaf(c, frameAt(curve, 1, angle + Math.PI / 2), rand)
        break
    }
  })

  // paper: inner cream tissue peeking above the outer kraft
  wrap(c, 'kraftInner', { bottomY: BIND_Y - 0.05, bindY: BIND_Y, topY: BIND_Y + 0.16, skirtR: 0.042, bindR: BIND_R * 1.0, topR: 0.12, waves: 4, phase: 1.3 })
  wrap(c, 'kraft', { bottomY: BIND_Y - 0.055, bindY: BIND_Y, topY: BIND_Y + 0.145, skirtR: 0.046, bindR: BIND_R * 1.04, topR: 0.13, waves: 5, phase: 0.2 })

  const knot = ribbonAndBow(c, BIND_Y, BIND_R * 1.12, rand)
  nameTag(c, name, knot, font)

  const group = c.build(materials)
  return { group, materials, height: 0.55 }
}
