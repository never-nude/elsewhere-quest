// Procedural textures drawn on canvases at load time. Everything here exports
// to GLB/USDZ as ordinary PNG images, so the AR versions carry the same
// surface detail as the live page.

import * as THREE from 'three'

function canvas(size: number) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return { c, ctx: c.getContext('2d')! }
}

function tex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.anisotropy = 4
  return t
}

/** Tiny deterministic PRNG so textures are the same on every load. */
function rng(seed: number) {
  let s = seed >>> 0 || 7
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

export interface PetalPalette {
  base: string // deep color at the petal's foot
  mid: string
  tip: string // lighter, often paler at the edge
  vein: string
}

/**
 * Petal albedo. UV v runs foot→tip (bottom→top of the canvas because
 * CanvasTexture flips Y), u runs across the width.
 */
export function petalTexture(p: PetalPalette, seed = 1, size = 512) {
  const { c, ctx } = canvas(size)
  const rand = rng(seed)
  const g = ctx.createLinearGradient(0, size, 0, 0)
  g.addColorStop(0, p.base)
  g.addColorStop(0.45, p.mid)
  g.addColorStop(1, p.tip)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  // a paler wash toward the edges, like light passing through thinner tissue
  const edge = ctx.createLinearGradient(0, 0, size, 0)
  edge.addColorStop(0, 'rgba(255,255,255,0.16)')
  edge.addColorStop(0.2, 'rgba(255,255,255,0)')
  edge.addColorStop(0.8, 'rgba(255,255,255,0)')
  edge.addColorStop(1, 'rgba(255,255,255,0.16)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, size, size)

  // veins fanning from the foot
  ctx.lineCap = 'round'
  for (let i = 0; i < 34; i++) {
    const t = (i + 0.5) / 34
    const x1 = size * (0.5 + (t - 0.5) * 0.18)
    const x2 = size * (0.04 + t * 0.92) + (rand() - 0.5) * 20
    const cx = size * (0.5 + (t - 0.5) * 0.5)
    ctx.strokeStyle = p.vein
    ctx.globalAlpha = 0.05 + rand() * 0.09
    ctx.lineWidth = 1 + rand() * 2.2
    ctx.beginPath()
    ctx.moveTo(x1, size)
    ctx.quadraticCurveTo(cx, size * 0.5, x2, size * (0.02 + rand() * 0.08))
    ctx.stroke()
  }
  // soft blotches
  for (let i = 0; i < 40; i++) {
    ctx.globalAlpha = 0.03 + rand() * 0.05
    ctx.fillStyle = rand() > 0.5 ? p.tip : p.base
    ctx.beginPath()
    ctx.ellipse(rand() * size, rand() * size, 20 + rand() * 70, 10 + rand() * 40, rand() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  return tex(c)
}

/** Height→normal conversion for a small canvas of grey heights. */
function heightToNormal(height: HTMLCanvasElement, strength: number) {
  const size = height.width
  const src = height.getContext('2d')!.getImageData(0, 0, size, size).data
  const { c, ctx } = canvas(size)
  const out = ctx.createImageData(size, size)
  const h = (x: number, y: number) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength
      const len = Math.hypot(dx, dy, 1)
      const i = (y * size + x) * 4
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255
      out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255
      out.data[i + 2] = (1 / len) * 0.5 * 255 + 127
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  return tex(c, false)
}

/** Petal normal map: raised veins plus fine tissue grain. */
export function petalNormal(seed = 2, size = 256) {
  const { c, ctx } = canvas(size)
  const rand = rng(seed)
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, size, size)
  ctx.lineCap = 'round'
  for (let i = 0; i < 26; i++) {
    const t = (i + 0.5) / 26
    ctx.strokeStyle = '#9a9a9a'
    ctx.globalAlpha = 0.6
    ctx.lineWidth = 1.2 + rand() * 1.5
    ctx.beginPath()
    ctx.moveTo(size * (0.5 + (t - 0.5) * 0.15), size)
    ctx.quadraticCurveTo(size * (0.5 + (t - 0.5) * 0.5), size * 0.5, size * (0.04 + t * 0.92), size * 0.05)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  for (let i = 0; i < 2500; i++) {
    const v = 118 + Math.floor(rand() * 20)
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(rand() * size, rand() * size, 1.5, 1.5)
  }
  return heightToNormal(c, 1.6)
}

export function leafTexture(dark: string, light: string, seed = 3, size = 512) {
  const { c, ctx } = canvas(size)
  const rand = rng(seed)
  const g = ctx.createLinearGradient(0, size, 0, 0)
  g.addColorStop(0, dark)
  g.addColorStop(0.6, light)
  g.addColorStop(1, dark)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  // midrib and side veins
  ctx.strokeStyle = 'rgba(235,240,210,0.55)'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(size / 2, size)
  ctx.lineTo(size / 2, size * 0.04)
  ctx.stroke()
  ctx.lineWidth = 2
  for (let i = 0; i < 12; i++) {
    const y = size * (0.1 + i * 0.075)
    for (const s of [-1, 1]) {
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.moveTo(size / 2, y + 20)
      ctx.quadraticCurveTo(size / 2 + s * size * 0.25, y - 10, size / 2 + s * size * 0.48, y - size * 0.1)
      ctx.stroke()
    }
  }
  for (let i = 0; i < 60; i++) {
    ctx.globalAlpha = 0.04 + rand() * 0.05
    ctx.fillStyle = rand() > 0.5 ? dark : light
    ctx.beginPath()
    ctx.ellipse(rand() * size, rand() * size, 15 + rand() * 50, 8 + rand() * 30, rand() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  return tex(c)
}

export function leafNormal(size = 256) {
  const { c, ctx } = canvas(size)
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = '#a8a8a8'
  ctx.lineCap = 'round'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(size / 2, size)
  ctx.lineTo(size / 2, size * 0.04)
  ctx.stroke()
  ctx.lineWidth = 2
  for (let i = 0; i < 12; i++) {
    const y = size * (0.1 + i * 0.075)
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(size / 2, y + 10)
      ctx.quadraticCurveTo(size / 2 + s * size * 0.25, y - 5, size / 2 + s * size * 0.48, y - size * 0.1)
      ctx.stroke()
    }
  }
  return heightToNormal(c, 2.2)
}

/** Speckled stoneware glaze for the vase. */
export function glazeTexture(base: string, speck: string, seed = 5, size = 512) {
  const { c, ctx } = canvas(size)
  const rand = rng(seed)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)
  // slow tonal drift
  for (let i = 0; i < 14; i++) {
    ctx.globalAlpha = 0.05
    ctx.fillStyle = rand() > 0.5 ? '#ffffff' : speck
    ctx.beginPath()
    ctx.ellipse(rand() * size, rand() * size, 80 + rand() * 160, 60 + rand() * 120, rand() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  // fine iron speckle
  for (let i = 0; i < 1400; i++) {
    ctx.globalAlpha = 0.25 + rand() * 0.5
    ctx.fillStyle = speck
    const r = 0.6 + rand() * 1.4
    ctx.beginPath()
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  const t = tex(c)
  t.wrapS = THREE.RepeatWrapping
  return t
}
