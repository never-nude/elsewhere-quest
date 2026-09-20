// Checks the actual exported mesh, independent of the procedural stem paths.
// All botanical triangles are checked against the vase walls and gold lip.
// The interior water disk is deliberately excluded: submerged stems cross it.
//
//   node tools/bouquet/validate-vase-clearance.mjs [public/Omaris/omaris.glb] [--clearance-mm 0.2]
//   node tools/bouquet/validate-vase-clearance.mjs --self-test
//
// Prints a JSON report and exits nonzero when a triangle crosses or comes
// within the requested clearance of the ceramic or lip. Tests full triangle
// interiors and edges, so a long stem segment cannot jump through the wall.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Box3, Matrix4, Quaternion, Ray, Triangle, Vector3 } from 'three'

const args = process.argv.slice(2)
let file = 'public/Omaris/omaris.glb'
let clearance = 0.0002
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--clearance-mm') clearance = Number(args[++i]) / 1000
  else if (args[i] !== '--self-test') file = args[i]
}
if (!Number.isFinite(clearance) || clearance < 0) throw new Error('Clearance must be a nonnegative number of millimeters.')

const EPSILON = 1e-10
const scratch = new Vector3()
const segmentDirection = new Vector3()
const ray = new Ray()

function triangle(a, b, c, kind = '', index = 0) {
  return {
    shape: new Triangle(a, b, c),
    vertices: [a, b, c],
    box: new Box3().setFromPoints([a, b, c]),
    kind,
    index,
  }
}

function segmentHitsTriangle(a, b, target) {
  segmentDirection.subVectors(b, a)
  const length = segmentDirection.length()
  if (length < EPSILON) return false
  ray.set(a, segmentDirection.multiplyScalar(1 / length))
  const point = ray.intersectTriangle(...target.vertices, false, scratch)
  return point !== null && point.distanceToSquared(a) <= (length + EPSILON) ** 2
}

// Closest distance between finite segments (including degenerate segments).
function segmentDistanceSquared(p1, q1, p2, q2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z
  const a = d1x * d1x + d1y * d1y + d1z * d1z
  const e = d2x * d2x + d2y * d2y + d2z * d2z
  const f = d2x * rx + d2y * ry + d2z * rz
  const clamp = (n) => Math.max(0, Math.min(1, n))
  let s, t
  if (a <= 1e-24 && e <= 1e-24) return rx * rx + ry * ry + rz * rz
  if (a <= 1e-24) { s = 0; t = clamp(f / e) }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz
    if (e <= 1e-24) { t = 0; s = clamp(-c / a) }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z
      const denominator = a * e - b * b
      s = denominator > 1e-30 ? clamp((b * f - c * e) / denominator) : 0
      t = (b * s + f) / e
      if (t < 0) { t = 0; s = clamp(-c / a) }
      else if (t > 1) { t = 1; s = clamp((b - c) / a) }
    }
  }
  return (rx + s * d1x - t * d2x) ** 2 + (ry + s * d1y - t * d2y) ** 2 + (rz + s * d1z - t * d2z) ** 2
}

function triangleDistanceSquared(a, b) {
  for (let i = 0; i < 3; i++) {
    if (segmentHitsTriangle(a.vertices[i], a.vertices[(i + 1) % 3], b)) return 0
    if (segmentHitsTriangle(b.vertices[i], b.vertices[(i + 1) % 3], a)) return 0
  }
  let nearest = Infinity
  for (let i = 0; i < 3; i++) {
    b.shape.closestPointToPoint(a.vertices[i], scratch)
    nearest = Math.min(nearest, scratch.distanceToSquared(a.vertices[i]))
    a.shape.closestPointToPoint(b.vertices[i], scratch)
    nearest = Math.min(nearest, scratch.distanceToSquared(b.vertices[i]))
    for (let j = 0; j < 3; j++) {
      nearest = Math.min(nearest, segmentDistanceSquared(
        a.vertices[i], a.vertices[(i + 1) % 3],
        b.vertices[j], b.vertices[(j + 1) % 3],
      ))
    }
  }
  return nearest
}

function selfTest() {
  const tri = (points) => triangle(...points.map((p) => new Vector3(...p)))
  const surface = tri([[-1, -1, 0], [1, -1, 0], [0, 1, 0]])
  const cases = [
    ['edge crosses a triangle interior although all endpoints miss the surface', tri([[0, 0, -1], [0, 0, 1], [0.1, 0.1, 1]]), 0],
    ['coplanar contained triangle', tri([[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0]]), 0],
    ['coplanar crossing edges without contained vertices', tri([[-1, 0.5, 0], [1, 0.5, 0], [0, -1.5, 0]]), 0],
    ['parallel surfaces with a known gap', tri([[-1, -1, 0.001], [1, -1, 0.001], [0, 1, 0.001]]), 1e-6],
    ['separated coplanar triangles', tri([[3, -1, 0], [5, -1, 0], [4, 1, 0]]), 4],
  ]
  for (const [name, target, expected] of cases) {
    const actual = triangleDistanceSquared(surface, target)
    if (Math.abs(actual - expected) > 1e-12) throw new Error(`Self-test failed: ${name}; ${actual} != ${expected}`)
  }
}

function readTriangles(path) {
  const bytes = readFileSync(path)
  if (bytes.toString('utf8', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) throw new Error('Expected GLB version 2.')
  let json, binary
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8').trim())
    else if (type === 0x004e4942) binary = data
    offset += 8 + length
  }
  if (!json || !binary) throw new Error('GLB must contain JSON and binary chunks.')
  const readAccessor = (id) => {
    const accessor = json.accessors[id]
    if (accessor.sparse) throw new Error('Sparse accessors are not supported by this validator.')
    const view = json.bufferViews[accessor.bufferView]
    if (view.buffer !== 0) throw new Error('Only the embedded GLB buffer is supported.')
    const types = { 5120: ['readInt8', 1], 5121: ['readUInt8', 1], 5122: ['readInt16LE', 2], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4], 5126: ['readFloatLE', 4] }
    const [method, size] = types[accessor.componentType] ?? []
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type]
    if (!method || !components || accessor.normalized) throw new Error('Unsupported accessor format.')
    const stride = view.byteStride ?? size * components
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    return Array.from({ length: accessor.count }, (_, i) =>
      Array.from({ length: components }, (_, j) => binary[method](start + i * stride + j * size)),
    )
  }
  const result = []
  const seen = new Set()
  const visit = (id, parent) => {
    const node = json.nodes[id]
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3(...(node.translation ?? [0, 0, 0])),
      new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
      new Vector3(...(node.scale ?? [1, 1, 1])),
    )
    const world = new Matrix4().multiplyMatrices(parent, local)
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) {
        if ((primitive.mode ?? 4) !== 4) throw new Error('Only triangle primitives are supported.')
        if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('Draco compression must be decoded first.')
        const positions = readAccessor(primitive.attributes.POSITION).map((p) => new Vector3(...p).applyMatrix4(world))
        const indices = primitive.indices === undefined ? positions.map((_, i) => i) : readAccessor(primitive.indices).flat()
        const kind = json.materials?.[primitive.material]?.name ?? node.name ?? `mesh-${node.mesh}`
        for (let i = 0; i < indices.length; i += 3) {
          const vertices = indices.slice(i, i + 3).map((j) => positions[j])
          // The exporter bakes both sides of leaves/inner wall; test each
          // physical triangle once, regardless of winding or vertex sharing.
          const key = `${kind}:${vertices.map((p) => `${p.x},${p.y},${p.z}`).sort().join(';')}`
          if (seen.has(key)) continue
          seen.add(key)
          const item = triangle(...vertices, kind, i / 3)
          if (item.shape.getArea() > 1e-16) result.push(item)
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  for (const id of json.scenes[json.scene ?? 0].nodes) visit(id, new Matrix4())
  return result
}

function buildBVH(items) {
  const box = new Box3()
  for (const item of items) box.union(item.box)
  if (items.length <= 12) return { box, items }
  const size = box.getSize(new Vector3())
  const axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z'
  items.sort((a, b) => a.box.min[axis] + a.box.max[axis] - b.box.min[axis] - b.box.max[axis])
  const split = Math.floor(items.length / 2)
  return { box, left: buildBVH(items.slice(0, split)), right: buildBVH(items.slice(split)) }
}

function candidates(node, box, callback) {
  if (!node.box.intersectsBox(box)) return
  if (node.items) {
    for (const item of node.items) if (item.box.intersectsBox(box)) callback(item)
  } else {
    candidates(node.left, box, callback)
    candidates(node.right, box, callback)
  }
}

selfTest()
if (args.includes('--self-test')) {
  console.log('Triangle/segment clearance self-tests passed (5 cases).')
  process.exit(0)
}

const triangles = readTriangles(resolve(file))
const vaseTriangles = triangles.filter((t) => t.kind === 'vase')
if (!vaseTriangles.length) throw new Error('No material named vase was found.')
const vaseTop = Math.max(...vaseTriangles.map((t) => t.box.max.y))
const targets = triangles.filter((t) => {
  if (t.kind === 'vase') return true
  // Horizontal triangles in vaseInside are the decorative water surface.
  if (t.kind === 'vaseInside') return t.box.max.y - t.box.min.y > 1e-7
  // The other gold geometry is the name and bottom ring, far below the lip.
  return t.kind === 'gold' && t.box.min.y > vaseTop - 0.006
})
const plants = triangles.filter((t) => !['vase', 'vaseInside', 'gold'].includes(t.kind))
const bvh = buildBVH(targets)
const byMaterial = {}
const samples = []
let contactTriangles = 0
let intersectionTriangles = 0
let candidatePairs = 0
const expanded = new Box3()
for (const source of plants) {
  let nearest = Infinity
  let targetKind = ''
  expanded.copy(source.box).expandByScalar(clearance + EPSILON)
  candidates(bvh, expanded, (target) => {
    candidatePairs++
    const distance = triangleDistanceSquared(source, target)
    if (distance < nearest) { nearest = distance; targetKind = target.kind }
  })
  if (nearest > (clearance + EPSILON) ** 2) continue
  contactTriangles++
  const intersects = nearest < EPSILON ** 2
  if (intersects) intersectionTriangles++
  const counts = byMaterial[source.kind] ??= { contactTriangles: 0, intersectionTriangles: 0, surfaces: {} }
  counts.contactTriangles++
  if (intersects) counts.intersectionTriangles++
  counts.surfaces[targetKind] = (counts.surfaces[targetKind] ?? 0) + 1
  if (samples.length < 30) {
    samples.push({ material: source.kind, triangle: source.index, surface: targetKind, intersects, distanceMm: Math.sqrt(nearest) * 1000, bounds: { min: source.box.min.toArray(), max: source.box.max.toArray() } })
  }
}
console.log(JSON.stringify({
  asset: resolve(file),
  pass: contactTriangles === 0,
  clearanceMm: clearance * 1000,
  botanicalTriangles: plants.length,
  vaseAndLipTriangles: targets.length,
  candidatePairs,
  contactTriangles,
  intersectionTriangles,
  byMaterial,
  samples,
}, null, 2))
process.exitCode = contactTriangles === 0 ? 0 : 1
