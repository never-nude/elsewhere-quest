// The acceptance fixture (SPEC §1b): a 4000×3000 photo whose horizon is tilted
// +3° (it falls to the right, so Crop's Auto must answer about −3°), with one dark
// 30 px speck for Remove and a median luma of about 0.30, so Auto-enhance has real
// work to do. It is drawn in the browser at run time and saved as a JPEG next to
// the harness output, so no binary ever lives in the repo.
//
// Luma is Rec. 709 on the sRGB-encoded values, the way lib/autofix.js measures it.
// Colours are a luma plus a chroma offset that adds no luma, so the median stays
// where it is put while the photo still has a gentle blue sky and brown ground
// (Color's Auto then has a cast and some muted saturation to work on).

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const FIXTURE = Object.freeze({
  width: 4000,
  height: 3000,
  tiltDeg: 3, // the horizon falls to the right by this much; the correction is −3°
  horizonAt: 0.42, // horizon height at the centre column, as a share of the height
  speck: Object.freeze({ x: 1150, y: 700, diameter: 30 }), // source px, in the sky
  medianLuma: 0.3,
  quality: 0.92,
  name: 'gesso-acceptance-fixture.jpg',
});

// Where the horizon crosses column x (source px, y down).
export function horizonY(x, f = FIXTURE) {
  return f.height * f.horizonAt + (x - f.width / 2) * Math.tan((f.tiltDeg * Math.PI) / 180);
}

// Runs inside the page: paints the fixture and returns a JPEG data URL plus the
// median luma it measured on the painted pixels (before JPEG).
function paintFixture(f) {
  const { width: W, height: H } = f;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const rad = (f.tiltDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const cx = W / 2, cy = H * f.horizonAt;
  const sr = f.speck.diameter / 2;
  // Deterministic value noise: the same fixture on every run and every machine.
  const hash = (x, y) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // Zero-luma chroma offsets: 0.2126·r + 0.7152·g + 0.0722·b = 0.
  const SKY = [-0.04, -0.005, 0.1673];
  const GROUND = [0.02, 0, -0.0589];
  for (let y = 0; y < H; y++) {
    const skyY = 0.62 - 0.14 * (y / (H * f.horizonAt)); // brighter towards the top
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Signed distance to the horizon, positive below it (the level test's convention).
      const dist = -(x - cx) * s + (y - cy) * c;
      const k = clamp((dist + 1) / 2); // a 2 px antialiased edge
      const sky = Math.min(0.62, skyY) + 0.008 * (hash(x, y) - 0.5);
      const ground = 0.24 + 0.07 * hash(x >> 1, (y >> 1) + 7919); // grain in 2 px blocks
      let Y = sky * (1 - k) + ground * k;
      let r = Y + SKY[0] * (1 - k) + GROUND[0] * k;
      let g = Y + SKY[1] * (1 - k) + GROUND[1] * k;
      let b = Y + SKY[2] * (1 - k) + GROUND[2] * k;
      const ds = Math.hypot(x + 0.5 - f.speck.x, y + 0.5 - f.speck.y);
      if (ds < sr + 1) {
        const a = clamp(sr + 0.5 - ds); // 1 px soft rim
        Y = 0.06;
        r = r * (1 - a) + Y * a;
        g = g * (1 - a) + Y * a;
        b = b * (1 - a) + Y * a;
      }
      d[i] = Math.round(clamp(r) * 255);
      d[i + 1] = Math.round(clamp(g) * 255);
      d[i + 2] = Math.round(clamp(b) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // The median over a sparse, even sample is plenty to confirm "about 0.30".
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    n++;
  }
  let acc = 0, median = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n / 2) { median = v / 255; break; }
  }
  const url = canvas.toDataURL('image/jpeg', f.quality);
  canvas.width = canvas.height = 0;
  return { url, median };
}

// Paint the fixture in `page` (any page will do; it is left as it was) and write
// it to `outDir`. Returns { path, bytes, median, width, height }.
export async function writeFixture(page, outDir, f = FIXTURE) {
  const { url, median } = await page.evaluate(paintFixture, f);
  const prefix = 'data:image/jpeg;base64,';
  if (!url.startsWith(prefix)) throw new Error('fixture: the browser did not encode a JPEG');
  const buf = Buffer.from(url.slice(prefix.length), 'base64');
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, f.name);
  await writeFile(path, buf);
  return { path, bytes: buf.length, median, width: f.width, height: f.height };
}
