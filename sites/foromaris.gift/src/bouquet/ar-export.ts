import * as THREE from 'three'
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js'

// Quick Look gets a separate, simpler material set. Keep the web bouquet's
// geometry and appearance, but use one small diffuse atlas and plain metallic
// PBR materials instead of normal maps, sheen, and clearcoat.
const ATLAS_SIZE = 1024
const GUTTER = 4

interface AtlasTile {
  x: number
  y: number
  size: number
}

function makeAtlas(maps: THREE.Texture[]) {
  if (maps.length > 16) throw new Error('The AR bouquet has too many color textures.')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ATLAS_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the AR bouquet textures.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
  const columns = Math.ceil(Math.sqrt(maps.length))
  const cell = Math.floor(ATLAS_SIZE / columns)
  const size = cell - GUTTER * 2
  const tiles = new Map<THREE.Texture, AtlasTile>()

  maps.forEach((map, index) => {
    const x = (index % columns) * cell + GUTTER
    const y = Math.floor(index / columns) * cell + GUTTER
    const image = map.image as HTMLCanvasElement
    if (!image?.width || !image.height) throw new Error('An AR bouquet texture is not ready.')
    context.drawImage(image, x, y, size, size)

    // Extrude each tile's edge pixels so filtering does not pick up adjacent
    // petals' colors. UVs below point at the centers of the interior pixels.
    context.drawImage(canvas, x, y, size, 1, x, y - GUTTER, size, GUTTER)
    context.drawImage(canvas, x, y + size - 1, size, 1, x, y + size, size, GUTTER)
    context.drawImage(canvas, x, y, 1, size, x - GUTTER, y, GUTTER, size)
    context.drawImage(canvas, x + size - 1, y, 1, size, x + size, y, GUTTER, size)
    for (const [sx, dx] of [[x, x - GUTTER], [x + size - 1, x + size]]) {
      for (const [sy, dy] of [[y, y - GUTTER], [y + size - 1, y + size]]) {
        context.drawImage(canvas, sx, sy, 1, 1, dx, dy, GUTTER, GUTTER)
      }
    }
    tiles.set(map, { x, y, size })
  })

  const texture = new THREE.CanvasTexture(canvas)
  texture.name = 'bouquet-ar-colors'
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  return { texture, tiles }
}

/** Export without changing the live bouquet's materials, textures, or UVs. */
export async function toARUSDZ(group: THREE.Group): Promise<Uint8Array> {
  const clone = group.clone(true)
  // The web preview has a gentle animated sway. The AR asset stands upright;
  // its geometry is already authored in meters, so preserve its scale.
  clone.position.set(0, 0, 0)
  clone.rotation.set(0, 0, 0)
  const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = []
  const maps = new Set<THREE.Texture>()
  clone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    if (!(object.material instanceof THREE.MeshStandardMaterial)) {
      throw new Error('The AR bouquet needs a single PBR material per mesh.')
    }
    meshes.push(object)
    if (object.material.map) maps.add(object.material.map)
  })
  const atlas = maps.size ? makeAtlas([...maps]) : null
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.MeshStandardMaterial[] = []

  try {
    for (const mesh of meshes) {
      const source = mesh.material
      const geometry = mesh.geometry.clone()
      geometries.push(geometry)
      mesh.geometry = geometry
      const material = new THREE.MeshStandardMaterial({
        name: source.name,
        color: source.color.clone(),
        roughness: source.roughness,
        metalness: source.metalness,
        opacity: source.opacity,
        transparent: source.transparent,
        alphaTest: source.alphaTest,
        side: source.side,
        vertexColors: source.vertexColors,
        flatShading: source.flatShading,
      })
      materials.push(material)
      mesh.material = material

      if (source.map && atlas) {
        const tile = atlas.tiles.get(source.map)!
        const uv = geometry.getAttribute(source.map.channel ? `uv${source.map.channel}` : 'uv')
        if (!uv) throw new Error('The AR bouquet is missing texture coordinates.')
        // A texture clone applies existing transforms/wrapping/flipY without
        // mutating the source. Baking them into UVs leaves the exported atlas
        // with identity transforms, avoiding Quick Look's transform quirks.
        const sampling = source.map.clone()
        if (sampling.matrixAutoUpdate) sampling.updateMatrix()
        const point = new THREE.Vector2()
        const atlasUV = new Float32Array(uv.count * 2)
        for (let index = 0; index < uv.count; index++) {
          sampling.transformUv(point.set(uv.getX(index), uv.getY(index)))
          atlasUV[index * 2] = (tile.x + 0.5 + point.x * (tile.size - 1)) / ATLAS_SIZE
          atlasUV[index * 2 + 1] = 1 - (tile.y + 0.5 + point.y * (tile.size - 1)) / ATLAS_SIZE
        }
        sampling.dispose()
        geometry.setAttribute('uv', new THREE.BufferAttribute(atlasUV, 2))
        material.map = atlas.texture
      }
    }
    clone.updateMatrixWorld(true)
    return await new USDZExporter().parseAsync(clone, {
      quickLookCompatible: true,
      includeAnchoringProperties: true,
      maxTextureSize: ATLAS_SIZE,
      ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'horizontal' } },
    })
  } finally {
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    atlas?.texture.dispose()
  }
}
