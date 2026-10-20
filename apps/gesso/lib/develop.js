// The develop pipeline: every global Light / Color / Look adjustment, as data, as a
// pure-JS reference implementation (for tests, Auto, and a no-WebGL fallback), and
// as the GLSL that ui/renderer.js runs. Keep the two implementations in lockstep:
// test/develop.test.mjs checks the maths, and the shader mirrors it line for line.
//
// Order, all on straight (non-premultiplied) colour:
//   sRGB decode -> white balance -> exposure -> local shadows/highlights (gain from a
//   blurred luminance map) -> sRGB encode -> brightness (gamma) -> contrast (S-curve)
//   -> blacks/whites -> saturation & vibrance -> look (split tone, fade, mono)
//   -> vignette -> grain.

export const PARAMS = [
  { key: 'brightness', label: 'Brightness', group: 'light', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', group: 'light', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', group: 'light', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', group: 'light', min: -100, max: 100 },
  { key: 'exposure', label: 'Exposure', group: 'light', min: -100, max: 100 },
  { key: 'blacks', label: 'Blacks', group: 'light', min: -100, max: 100 },
  { key: 'whites', label: 'Whites', group: 'light', min: -100, max: 100 },
  { key: 'warmth', label: 'Warmth', group: 'color', min: -100, max: 100 },
  { key: 'tint', label: 'Tint', group: 'color', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', group: 'color', min: -100, max: 100 },
  { key: 'vibrance', label: 'Vibrance', group: 'color', min: -100, max: 100 },
  { key: 'vignette', label: 'Vignette', group: 'color', min: -100, max: 100 },
  { key: 'grain', label: 'Grain', group: 'color', min: 0, max: 100 },
];

export const PARAM_KEYS = PARAMS.map((p) => p.key);
const BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function paramInfo(key) {
  const p = BY_KEY[key];
  if (!p) throw new Error(`unknown param ${key}`);
  return p;
}

export function defaultAdjust() {
  return Object.fromEntries(PARAM_KEYS.map((k) => [k, 0]));
}

export function clampParam(key, value) {
  const p = paramInfo(key);
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return 0;
  return Math.max(p.min, Math.min(p.max, v));
}

// Revive untrusted/saved params: unknown keys dropped, missing ones zero.
export function reviveAdjust(raw) {
  const out = defaultAdjust();
  if (raw && typeof raw === 'object') for (const k of PARAM_KEYS) if (k in raw) out[k] = clampParam(k, raw[k]);
  return out;
}

export function changedParams(adjust) {
  return PARAM_KEYS.filter((k) => adjust[k] !== 0);
}

// ------------------------------------------------------------------ looks
// A look is a recipe of parameter offsets plus finishing touches the sliders don't
// expose (split toning, fade, mono). `amount` (0..100) scales all of it, so a look
// is never a black box: it is the same dials, pushed.

export const LOOKS = [
  { id: 'none', label: 'None' },
  { id: 'vivid', label: 'Vivid', params: { saturation: 15, contrast: 12, vibrance: 15 } },
  { id: 'warm', label: 'Warm', params: { warmth: 18, saturation: 5 }, split: { shadow: [0.02, 0.0, -0.02], highlight: [0.08, 0.04, -0.02] } },
  { id: 'cool', label: 'Cool', params: { warmth: -15, contrast: 4 }, split: { shadow: [-0.03, 0.02, 0.05], highlight: [-0.01, 0.0, 0.04] } },
  { id: 'film', label: 'Film', params: { saturation: -12, contrast: -8, highlights: -12, vignette: 25, grain: 18 }, fade: 0.05, split: { shadow: [-0.02, 0.03, 0.06], highlight: [0.07, 0.035, -0.03] } },
  // Red-weighted mix, like a red filter on black-and-white film: kind to skin, dramatic skies.
  { id: 'mono', label: 'Mono', params: { contrast: 18, vignette: 15 }, mono: true, monoMix: [0.4, 0.45, 0.15] },
];

export function lookById(id) {
  return LOOKS.find((l) => l.id === id) ?? LOOKS[0];
}

// The effective state the pipeline runs: sliders + look * amount.
export function resolve(adjust, look = { id: 'none', amount: 100 }) {
  const L = lookById(look.id);
  const t = Math.max(0, Math.min(100, look.amount ?? 100)) / 100;
  const p = { ...adjust };
  if (L.params) for (const [k, v] of Object.entries(L.params)) p[k] = clampParam(k, p[k] + v * t);
  const split = L.split ?? { shadow: [0, 0, 0], highlight: [0, 0, 0] };
  return {
    params: p,
    fade: (L.fade ?? 0) * t,
    mono: L.mono ? t : 0,
    monoMix: L.monoMix ?? [0.2126, 0.7152, 0.0722],
    splitShadow: split.shadow.map((v) => v * t),
    splitHighlight: split.highlight.map((v) => v * t),
  };
}

// ------------------------------------------------------------------ maths
// Uniform values derived from params. Shared by the JS reference and the shader
// (ui/renderer.js uploads exactly these).

export function uniforms(state) {
  const p = state.params;
  const n = (k) => p[k] / 100;
  // White balance as gains in linear light, normalised so mid-grey keeps its
  // luminance: warmth trades blue for red, tint trades green for magenta.
  const w = n('warmth'), t = n('tint');
  let gr = Math.exp(0.32 * w + 0.08 * t), gg = Math.exp(-0.2 * t), gb = Math.exp(-0.36 * w + 0.08 * t);
  const lum = 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
  gr /= lum; gg /= lum; gb /= lum;
  return {
    wb: [gr, gg, gb],
    exposure: Math.pow(2, n('exposure') * 2), // ±2 stops
    shadows: n('shadows'),
    highlights: n('highlights'),
    gamma: Math.pow(2, -n('brightness') * 0.85), // brightness: midtone gamma, keeps black & white
    contrast: n('contrast'),
    blacks: n('blacks') * 0.12, // move the black point
    whites: n('whites') * 0.12, // move the white point
    saturation: 1 + n('saturation') * (p.saturation > 0 ? 0.8 : 1),
    vibrance: n('vibrance'),
    vignette: n('vignette'),
    grain: p.grain / 100,
    fade: state.fade,
    mono: state.mono,
    monoMix: state.monoMix ?? [0.2126, 0.7152, 0.0722],
    splitShadow: state.splitShadow,
    splitHighlight: state.splitHighlight,
  };
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c) {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Highlight roll-off for one channel whose light was multiplied by `gain`: tones
// above 0.8 ease in so that white times the gain lands exactly on 1.0 instead of
// clipping flat. It engages only where something pushed this pixel's channel up
// (gain > 1), so a neutral edit is an exact identity and a white nothing
// brightened stays white.
export function shoulder(s, gain) {
  if (!(gain > 1) || s <= 0.8) return s;
  const a = (linearToSrgb(gain) - 1) / 0.2;
  const t = Math.min(1, (s - 0.8) / (0.2 * (1 + a)));
  return 0.8 + (0.2 * t * (1 + a)) / (1 + a * t);
}

// Contrast as a blend toward a smooth S-curve (more) or toward mid-grey (less),
// pivoting at 0.5 so it never drifts the overall exposure.
function contrastCurve(x, c) {
  if (c >= 0) {
    const s = x * x * (3 - 2 * x); // smoothstep(0,1,x)
    return mix(x, s, c * 0.9);
  }
  return 0.5 + (x - 0.5) * (1 + c * 0.6);
}

// One pixel through the pipeline. rgb in 0..1 sRGB; blur is the blurred
// luminance (0..1, linear) around this pixel; (u, v) its position in the output
// (0..1) for the vignette; noise a value in [-0.5, 0.5) for grain; paintEV the
// painted-light exposure (stops, ±1.5) at this pixel.
export function developPixel(r, g, b, U, blur = null, u = 0.5, v = 0.5, noise = 0, paintEV = 0) {
  // to linear, white balance, exposure, painted light
  let k = U.exposure * (paintEV ? Math.pow(2, paintEV) : 1);
  let lr = srgbToLinear(r) * U.wb[0] * k;
  let lg = srgbToLinear(g) * U.wb[1] * k;
  let lb = srgbToLinear(b) * U.wb[2] * k;

  // local shadows / highlights: an exposure-style gain chosen from the
  // neighbourhood's brightness, so detail within the shadows survives.
  if (U.shadows !== 0 || U.highlights !== 0) {
    const L = blur ?? luma(lr, lg, lb);
    // Weights are chosen so the transfer stays monotonic at the slider extremes
    // (x * 2^(a*w(x)) is increasing iff 1 + a*ln2*x*w'(x) > 0): highlights use
    // L^1.4, so even -100 (-0.95 stops) never turns a brighter tone darker.
    const ws = Math.pow(1 - smoothstep(0.0, 0.45, L), 2);
    const wh = Math.pow(clamp01(L), 1.4);
    const stops = U.shadows * 1.6 * ws + U.highlights * 0.95 * wh;
    const gain = Math.pow(2, stops);
    lr *= gain; lg *= gain; lb *= gain;
    k *= gain;
  }

  // soft shoulder: compress light pushed past white instead of clipping hard
  let cr = shoulder(linearToSrgb(lr), U.wb[0] * k);
  let cg = shoulder(linearToSrgb(lg), U.wb[1] * k);
  let cb = shoulder(linearToSrgb(lb), U.wb[2] * k);

  // brightness (midtone gamma), contrast, black & white points — per channel
  const tone = (x) => {
    let y = Math.pow(clamp01(x), U.gamma);
    y = contrastCurve(y, U.contrast);
    y = (y - U.blacks) / Math.max(0.05, 1 - U.whites - U.blacks);
    return clamp01(y);
  };
  cr = tone(cr); cg = tone(cg); cb = tone(cb);

  // saturation and vibrance (vibrance favours muted colours and spares skin a little)
  let Y = luma(cr, cg, cb);
  const mx = Math.max(cr, cg, cb), mn = Math.min(cr, cg, cb);
  const sat = mx - mn;
  const vib = 1 + U.vibrance * (1 - sat) * (U.vibrance > 0 ? 1.1 : 1);
  const s = U.saturation * vib;
  cr = Y + (cr - Y) * s; cg = Y + (cg - Y) * s; cb = Y + (cb - Y) * s;

  // look: split tone, mono, fade
  Y = luma(clamp01(cr), clamp01(cg), clamp01(cb));
  // A cool shadow tint spares colours that were warm to begin with (skin, wood):
  // added to deep skin, which sits wholly in the shadow weight, it would turn it
  // grey or teal.
  const warm = clamp01((4 * (r - b)) / Math.max(r, 0.1)); // near-black hue is noise
  const guard = U.splitShadow[2] > U.splitShadow[0] ? 1 - 0.85 * warm : 1;
  const sw = (1 - smoothstep(0.0, 0.55, Y)) * guard, hw = smoothstep(0.45, 1.0, Y);
  cr += U.splitShadow[0] * sw + U.splitHighlight[0] * hw;
  cg += U.splitShadow[1] * sw + U.splitHighlight[1] * hw;
  cb += U.splitShadow[2] * sw + U.splitHighlight[2] * hw;
  if (U.mono > 0) {
    const m = cr * U.monoMix[0] + cg * U.monoMix[1] + cb * U.monoMix[2];
    cr = mix(cr, m, U.mono); cg = mix(cg, m, U.mono); cb = mix(cb, m, U.mono);
  }
  if (U.fade > 0) {
    cr = U.fade + cr * (1 - U.fade * 1.2); cg = U.fade + cg * (1 - U.fade * 1.2); cb = U.fade + cb * (1 - U.fade * 1.2);
  }

  // vignette: an ellipse that follows the frame, 0 at the centre and 1 in the
  // corners; positive darkens the edges, negative lightens them
  if (U.vignette !== 0) {
    const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
    const d = Math.sqrt(dx * dx + dy * dy) * Math.SQRT1_2;
    const k = 1 - smoothstep(0.35, 1.05, d) * U.vignette * 0.75;
    cr *= k; cg *= k; cb *= k;
  }

  // grain: luminance noise, strongest in the midtones like film
  if (U.grain > 0) {
    const m = luma(clamp01(cr), clamp01(cg), clamp01(cb));
    const amt = noise * U.grain * 0.16 * (0.35 + 4 * m * (1 - m));
    cr += amt; cg += amt; cb += amt;
  }

  return [clamp01(cr), clamp01(cg), clamp01(cb)];
}

// Develop a whole RGBA buffer on the CPU. Used by tests, Auto previews and the
// WebGL-less fallback. `blurLum` (linear luminance) and `paintEV` (stops) are
// optional Float32Arrays of w*h. Output is dithered like the shader's.
export function developImage(image, state, blurLum = null, paintEV = null) {
  const U = uniforms(state);
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const n = U.grain > 0 ? hashNoise(x, y) : 0;
      const [r, g, b] = developPixel(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, U,
        blurLum ? blurLum[y * width + x] : null, (x + 0.5) / width, (y + 0.5) / height, n,
        paintEV ? paintEV[y * width + x] : 0);
      const d = ditherNoise(x, y) / 255;
      out[i] = Math.round((r + d) * 255); out[i + 1] = Math.round((g + d) * 255); out[i + 2] = Math.round((b + d) * 255);
      out[i + 3] = data[i + 3];
    }
  }
  return { width, height, data: out };
}

// ±0.5 LSB of noise before 8-bit quantisation, so smooth skies don't band. A
// different hash from grain's so the two never correlate.
export function ditherNoise(x, y) {
  const s = Math.sin((x + 17.31) * 39.346 + (y + 41.17) * 11.135) * 15718.6243;
  return s - Math.floor(s) - 0.5;
}

// Same hash as the shader's: fract(sin(dot(p, k)) * 43758.5453) - 0.5.
export function hashNoise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

// ------------------------------------------------------------------ GLSL
// Mirrors developPixel. `uBlur` is a small (a, b) map sampled with the same UV as
// the photo, giving the neighbourhood luminance a·Y + b from the pixel's own linear
// luminance Y; `uOut` maps fragment coords to output 0..1.

export const DEVELOP_GLSL = `#version 300 es
precision highp float;
in vec2 vUv;        // source texture coords
in vec2 vOut;       // output-space 0..1, for the vignette
out vec4 outColor;
uniform sampler2D uImage;
uniform sampler2D uBlur;
uniform bool uHasBlur;
uniform sampler2D uPaint;  // RG8 in source UV: r = brighten, g = darken (1.0 = 1.5 EV)
uniform bool uHasPaint;
uniform vec3 uWb;
uniform float uExposure, uShadows, uHighlights, uGamma, uContrast, uBlacks, uWhites;
uniform float uSaturation, uVibrance, uVignette, uGrain, uFade, uMono;
uniform vec3 uSplitShadow, uSplitHighlight, uMonoMix;
uniform vec2 uGrainScale;  // output size in px, so grain and dither are per output pixel
uniform float uOutPerPx;   // output px per target px: a smaller render shows grain averaged, as the saved photo looks at that size

float toLin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float toSrgb(float c) { return c <= 0.0 ? 0.0 : (c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float shoulder(float s, float gain) {
  if (gain <= 1.0 || s <= 0.8) return s;
  float a = (toSrgb(gain) - 1.0) / 0.2;
  float t = min(1.0, (s - 0.8) / (0.2 * (1.0 + a)));
  return 0.8 + 0.2 * t * (1.0 + a) / (1.0 + a * t);
}
float contrastCurve(float x, float c) {
  if (c >= 0.0) { float s = x * x * (3.0 - 2.0 * x); return mix(x, s, c * 0.9); }
  return 0.5 + (x - 0.5) * (1.0 + c * 0.6);
}
float tone(float x) {
  float y = pow(clamp(x, 0.0, 1.0), uGamma);
  y = contrastCurve(y, uContrast);
  y = (y - uBlacks) / max(0.05, 1.0 - uWhites - uBlacks);
  return clamp(y, 0.0, 1.0);
}
float hashNoise(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5; }
float ditherNoise(vec2 p) { return fract(sin((p.x + 17.31) * 39.346 + (p.y + 41.17) * 11.135) * 15718.6243) - 0.5; }

vec3 develop(vec3 c) {
  float k = uExposure;
  if (uHasPaint) { vec2 m = texture(uPaint, vUv).rg; k *= exp2(1.5 * (m.r - m.g)); }
  vec3 l = vec3(toLin(c.r), toLin(c.g), toLin(c.b)) * uWb * k;
  if (uShadows != 0.0 || uHighlights != 0.0) {
    vec2 ab = texture(uBlur, vUv).rg; // L = a·Y + b, edge-aware (ui/renderer.js blurLuminance)
    float L = uHasBlur ? ab.x * luma(vec3(toLin(c.r), toLin(c.g), toLin(c.b))) + ab.y : luma(l);
    float ws = pow(1.0 - smoothstep(0.0, 0.45, L), 2.0);
    float wh = pow(clamp(L, 0.0, 1.0), 1.4);
    float gain = exp2(uShadows * 1.6 * ws + uHighlights * 0.95 * wh);
    l *= gain; k *= gain;
  }
  vec3 g = uWb * k;
  vec3 s = vec3(shoulder(toSrgb(l.r), g.r), shoulder(toSrgb(l.g), g.g), shoulder(toSrgb(l.b), g.b));
  s = vec3(tone(s.r), tone(s.g), tone(s.b));
  float Y = luma(s);
  float sat = max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b));
  float vib = 1.0 + uVibrance * (1.0 - sat) * (uVibrance > 0.0 ? 1.1 : 1.0);
  s = vec3(Y) + (s - vec3(Y)) * (uSaturation * vib);
  Y = luma(clamp(s, 0.0, 1.0));
  float warm = clamp(4.0 * (c.r - c.b) / max(c.r, 0.1), 0.0, 1.0);
  float guard = uSplitShadow.b > uSplitShadow.r ? 1.0 - 0.85 * warm : 1.0;
  float sw = (1.0 - smoothstep(0.0, 0.55, Y)) * guard, hw = smoothstep(0.45, 1.0, Y);
  s += uSplitShadow * sw + uSplitHighlight * hw;
  if (uMono > 0.0) s = mix(s, vec3(dot(s, uMonoMix)), uMono);
  if (uFade > 0.0) s = vec3(uFade) + s * (1.0 - uFade * 1.2);
  if (uVignette != 0.0) {
    float d = length((vOut - 0.5) * 2.0) * 0.70710678;
    s *= 1.0 - smoothstep(0.35, 1.05, d) * uVignette * 0.75;
  }
  if (uGrain > 0.0) {
    float m = luma(clamp(s, 0.0, 1.0));
    vec2 px = floor(vOut * uGrainScale);
    s += vec3(hashNoise(px) * uGrain * 0.16 * (0.35 + 4.0 * m * (1.0 - m)) / max(1.0, uOutPerPx));
  }
  return clamp(s, 0.0, 1.0);
}

void main() {
  vec3 edited = develop(texture(uImage, vUv).rgb);
  edited += ditherNoise(floor(vOut * uGrainScale)) / 255.0;
  outColor = vec4(clamp(edited, 0.0, 1.0), 1.0);
}
`;
