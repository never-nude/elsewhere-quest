// The only WebGL2 context in the app (iOS allows 16; we never need a second).
//
// Textures, all in source (S) space:
//   pristine  the imported photo, uploaded in strips through an sRGB 2D canvas,
//             immutable, mipmapped. Before is drawn from it.
//   base      pristine + Remove fills. Created lazily on the first fill, so most
//             sessions hold one full-size copy, not two.
//   blur      small blurred-luminance map (R8) for local shadows/highlights.
//   paint     RG8 dodge/burn mask at S/4 (r = brighten, g = darken; 1.0 = 1.5 EV).
//
// The GPU is never the only copy of the user's work: the original file and the
// fill tiles live in IndexedDB, so a lost context is rebuilt from them.

import { DEVELOP_GLSL } from '../lib/develop.js';

const VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in vec2 aOut;
out vec2 vUv;
out vec2 vOut;
void main() {
  vUv = aUv;
  vOut = aOut;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// Paint-light dabs: Gaussian splats into the RG8 mask.
const DAB_VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aLocal;
out vec2 vLocal;
void main() { vLocal = aLocal; gl_Position = vec4(aPos, 0.0, 1.0); }
`;
const DAB_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
out vec4 outColor;
uniform vec3 uChannel;  // (1,0,0) brighten, (0,1,0) darken, (0,0,1) erase
uniform float uAmount;
void main() {
  float w = exp(-dot(vLocal, vLocal) * 3.0) * uAmount;
  if (uChannel.b > 0.5) outColor = vec4(0.0, 0.0, 0.0, w);
  else outColor = vec4(uChannel.rg * w, 0.0, 0.0);
}
`;

const UNIFORM_NAMES = [
  'uImage', 'uBlur', 'uHasBlur', 'uPaint', 'uHasPaint', 'uWb', 'uExposure', 'uRolloff', 'uShadows',
  'uHighlights', 'uGamma', 'uContrast', 'uBlacks', 'uWhites', 'uSaturation', 'uVibrance', 'uVignette',
  'uGrain', 'uFade', 'uMono', 'uMonoMix', 'uSplitShadow', 'uSplitHighlight', 'uGrainScale',
];

const STRIP_ROWS = 512;
export const DAB_AMOUNT = 0.12; // per dab, saturating at 1.0 (= ±1.5 EV)

export function createRenderer(canvas, { onLost, onRestored } = {}) {
  let gl = null;
  let program = null;
  let dabProgram = null;
  let loc = {};
  let dabLoc = {};
  let vao = null;
  let vbo = null;
  let dabVao = null;
  let dabVbo = null;
  let pristine = null;
  let base = null; // null = same as pristine
  let blurTex = null;
  let paintTex = null;
  let paintFbo = null;
  let size = null; // { width, height } of the source
  let paintSize = null;
  let lost = false;

  function init() {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;
    program = link(gl, VERTEX, DEVELOP_GLSL);
    loc = { aPos: gl.getAttribLocation(program, 'aPos'), aUv: gl.getAttribLocation(program, 'aUv'), aOut: gl.getAttribLocation(program, 'aOut') };
    for (const n of UNIFORM_NAMES) loc[n] = gl.getUniformLocation(program, n);
    vao = gl.createVertexArray();
    vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(loc.aUv);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 24, 8);
    gl.enableVertexAttribArray(loc.aOut);
    gl.vertexAttribPointer(loc.aOut, 2, gl.FLOAT, false, 24, 16);

    dabProgram = link(gl, DAB_VERTEX, DAB_FRAGMENT);
    dabLoc = {
      aPos: gl.getAttribLocation(dabProgram, 'aPos'),
      aLocal: gl.getAttribLocation(dabProgram, 'aLocal'),
      uChannel: gl.getUniformLocation(dabProgram, 'uChannel'),
      uAmount: gl.getUniformLocation(dabProgram, 'uAmount'),
    };
    dabVao = gl.createVertexArray();
    dabVbo = gl.createBuffer();
    gl.bindVertexArray(dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, dabVbo);
    gl.enableVertexAttribArray(dabLoc.aPos);
    gl.vertexAttribPointer(dabLoc.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(dabLoc.aLocal);
    gl.vertexAttribPointer(dabLoc.aLocal, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    pristine = base = blurTex = paintTex = paintFbo = null;
    return true;
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // ask for it back
    lost = true;
    onLost?.();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    init();
    onRestored?.(); // the editor re-imports from the stored original
  });

  const ok = init();
  const maxTextureSize = ok ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0;

  function mipLevels(w, h) {
    return Math.floor(Math.log2(Math.max(w, h))) + 1;
  }

  function newImageTexture(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, mipLevels(w, h), gl.RGBA8, w, h);
    setSampling(gl, true);
    return t;
  }

  function withFbo(tex, fn) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    try {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
      return fn();
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
    }
  }

  // Corners TL, TR, BL, BR: { x, y } target px (y down), { u, v } source UV,
  // { ox, oy } output 0..1.
  function writeQuad(quad, targetW, targetH, flipY) {
    const data = new Float32Array(24);
    quad.forEach((c, i) => {
      data[i * 6] = (c.x / targetW) * 2 - 1;
      data[i * 6 + 1] = flipY ? 1 - (c.y / targetH) * 2 : (c.y / targetH) * 2 - 1;
      data[i * 6 + 2] = c.u;
      data[i * 6 + 3] = c.v;
      data[i * 6 + 4] = c.ox;
      data[i * 6 + 5] = c.oy;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  function bindDevelop(u, { texture, grainScale, paint }) {
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc.uImage, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurTex);
    gl.uniform1i(loc.uBlur, 1);
    gl.uniform1i(loc.uHasBlur, blurTex ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, paint ? paintTex : null);
    gl.uniform1i(loc.uPaint, 2);
    gl.uniform1i(loc.uHasPaint, paint && paintTex ? 1 : 0);
    gl.uniform3fv(loc.uWb, u.wb);
    gl.uniform1f(loc.uExposure, u.exposure);
    gl.uniform1f(loc.uRolloff, u.rolloff);
    gl.uniform1f(loc.uShadows, u.shadows);
    gl.uniform1f(loc.uHighlights, u.highlights);
    gl.uniform1f(loc.uGamma, u.gamma);
    gl.uniform1f(loc.uContrast, u.contrast);
    gl.uniform1f(loc.uBlacks, u.blacks);
    gl.uniform1f(loc.uWhites, u.whites);
    gl.uniform1f(loc.uSaturation, u.saturation);
    gl.uniform1f(loc.uVibrance, u.vibrance);
    gl.uniform1f(loc.uVignette, u.vignette);
    gl.uniform1f(loc.uGrain, u.grain);
    gl.uniform1f(loc.uFade, u.fade);
    gl.uniform1f(loc.uMono, u.mono);
    gl.uniform3fv(loc.uMonoMix, u.monoMix);
    gl.uniform3fv(loc.uSplitShadow, u.splitShadow);
    gl.uniform3fv(loc.uSplitHighlight, u.splitHighlight);
    gl.uniform2fv(loc.uGrainScale, grainScale);
  }

  // Render into a temporary RGBA8 target and read it back in the same task.
  function renderToBuffer(width, height, quad, u, opts) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    try {
      return withFbo(tex, () => {
        gl.viewport(0, 0, width, height);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        bindDevelop(u, opts);
        gl.bindVertexArray(vao);
        writeQuad(quad, width, height, false); // FBO row 0 = top row: readPixels is top-first
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        const out = new Uint8ClampedArray(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return out;
      });
    } finally {
      gl.deleteTexture(tex);
    }
  }

  const api = {
    ok,
    maxTextureSize,
    get lost() { return lost; },
    get size() { return size; },
    get hasBase() { return base !== null; },

    resize(cssWidth, cssHeight, dpr) {
      const w = Math.max(1, Math.round(cssWidth * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { width: w, height: h };
    },

    // Upload an ImageBitmap (or canvas) as the pristine texture, a strip at a
    // time through a small sRGB 2D canvas (colour-managed, never one giant canvas).
    loadSource(image) {
      if (!ok || lost) throw new Error('WebGL is not available');
      api.unloadSource();
      const w = image.width, h = image.height;
      if (w > maxTextureSize || h > maxTextureSize) throw new Error('photo too large for this device');
      pristine = newImageTexture(w, h);
      const strip = document.createElement('canvas');
      strip.width = w;
      strip.height = Math.min(STRIP_ROWS, h);
      const ctx = strip.getContext('2d', { colorSpace: 'srgb', willReadFrequently: false });
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, pristine);
      for (let y = 0; y < h; y += STRIP_ROWS) {
        const rows = Math.min(STRIP_ROWS, h - y);
        ctx.clearRect(0, 0, w, strip.height);
        ctx.drawImage(image, 0, y, w, rows, 0, 0, w, rows);
        if (rows === strip.height) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, gl.RGBA, gl.UNSIGNED_BYTE, strip);
        } else {
          const part = ctx.getImageData(0, 0, w, rows);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, part.data);
        }
      }
      strip.width = strip.height = 0; // free it now, not at GC
      gl.generateMipmap(gl.TEXTURE_2D);
      size = { width: w, height: h };
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`upload failed (${err})`);
    },

    unloadSource() {
      if (!gl) return;
      if (base && base !== pristine) gl.deleteTexture(base);
      if (pristine) gl.deleteTexture(pristine);
      if (blurTex) gl.deleteTexture(blurTex);
      if (paintFbo) gl.deleteFramebuffer(paintFbo);
      if (paintTex) gl.deleteTexture(paintTex);
      pristine = base = blurTex = paintTex = paintFbo = null;
      size = paintSize = null;
    },

    // First Remove: give fills their own copy to write into.
    ensureBase() {
      if (base) return;
      base = newImageTexture(size.width, size.height);
      withFbo(pristine, () => {
        gl.bindTexture(gl.TEXTURE_2D, base);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, size.width, size.height);
      });
      gl.bindTexture(gl.TEXTURE_2D, base);
      gl.generateMipmap(gl.TEXTURE_2D);
    },

    // A fill tile: RGBA of `rect` (source px) holding exact final pixels where
    // alpha > 0 and "leave base alone" where alpha is 0 — so replaying tiles in
    // order is bit-exact. `clip` limits the paste (undo repaints only the area
    // it restored, so later fills elsewhere are never overwritten).
    pasteTile(rect, rgba, clip = null) {
      api.ensureBase();
      let r = rect;
      if (clip) {
        const x0 = Math.max(rect.x, clip.x), y0 = Math.max(rect.y, clip.y);
        const x1 = Math.min(rect.x + rect.w, clip.x + clip.w), y1 = Math.min(rect.y + rect.h, clip.y + clip.h);
        if (x1 <= x0 || y1 <= y0) return;
        r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      const current = api.readRect(r, false);
      for (let yy = 0; yy < r.h; yy++) {
        for (let xx = 0; xx < r.w; xx++) {
          const si = ((r.y - rect.y + yy) * rect.w + (r.x - rect.x + xx)) * 4;
          if (rgba[si + 3] === 0) continue;
          const di = (yy * r.w + xx) * 4;
          current[di] = rgba[si]; current[di + 1] = rgba[si + 1]; current[di + 2] = rgba[si + 2]; current[di + 3] = 255;
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, base);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, current);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.generateMipmap(gl.TEXTURE_2D);
    },

    // Undo a fill: copy the pristine pixels of `rect` back into base.
    restoreRect(rect) {
      if (!base) return;
      withFbo(pristine, () => {
        gl.bindTexture(gl.TEXTURE_2D, base);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.x, rect.y, rect.w, rect.h);
      });
      gl.bindTexture(gl.TEXTURE_2D, base);
      gl.generateMipmap(gl.TEXTURE_2D);
    },

    // Drop all fills (e.g. undo back past the first one).
    resetBase() {
      if (base) gl.deleteTexture(base);
      base = null;
    },

    // Exact source pixels of a rect (top-first RGBA), from base or pristine.
    readRect(rect, fromPristine = false) {
      const tex = fromPristine || !base ? pristine : base;
      return withFbo(tex, () => {
        const out = new Uint8ClampedArray(rect.w * rect.h * 4);
        gl.readPixels(rect.x, rect.y, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return out;
      });
    },

    // A small, filtered copy of a source rect (whole image by default), for
    // analysis, the blur map, thumbnails and Remove's search region.
    readSource({ rect = null, maxSide = 512, scale = null, pristine: usePristine = false } = {}) {
      const r = rect ?? { x: 0, y: 0, w: size.width, h: size.height };
      const s = scale ?? Math.min(1, maxSide / Math.max(r.w, r.h));
      const w = Math.max(1, Math.round(r.w * s)), h = Math.max(1, Math.round(r.h * s));
      const W = size.width, H = size.height;
      const quad = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => ({
        x, y,
        u: (r.x + (x / w) * r.w) / W,
        v: (r.y + (y / h) * r.h) / H,
        ox: x / w, oy: y / h,
      }));
      const data = renderToBuffer(w, h, quad, IDENTITY, { texture: usePristine || !base ? pristine : base, grainScale: [w, h], paint: false });
      return { width: w, height: h, data, scale: s };
    },

    setBlur({ width, height, data }) {
      if (!blurTex) blurTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, blurTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      setSampling(gl, false);
    },

    // ---- painted light ------------------------------------------------------
    clearPaint() {
      if (!size) return;
      if (!paintTex) {
        const s = Math.min(0.25, 2048 / Math.max(size.width, size.height));
        paintSize = { width: Math.max(1, Math.round(size.width * s)), height: Math.max(1, Math.round(size.height * s)), scale: s };
        paintTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, paintTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG8, paintSize.width, paintSize.height);
        setSampling(gl, false);
        paintFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, paintFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, paintTex, 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, paintFbo);
      gl.viewport(0, 0, paintSize.width, paintSize.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    hasPaint() { return paintTex !== null; },

    // Dab centres (flat x,y in source px) of radius r (source px).
    paintDabs(mode, centres, r) {
      if (!paintTex) api.clearPaint();
      const s = paintSize.scale;
      const W = paintSize.width, H = paintSize.height;
      const n = centres.length / 2;
      const data = new Float32Array(n * 6 * 4);
      const rr = Math.max(1, r * s);
      let k = 0;
      const corner = [[-1, -1], [1, -1], [-1, 1], [-1, 1], [1, -1], [1, 1]];
      for (let i = 0; i < n; i++) {
        const cx = centres[i * 2] * s, cy = centres[i * 2 + 1] * s;
        for (const [lx, ly] of corner) {
          data[k++] = ((cx + lx * rr) / W) * 2 - 1;
          data[k++] = ((cy + ly * rr) / H) * 2 - 1; // mask row 0 = source row 0
          data[k++] = lx;
          data[k++] = ly;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, paintFbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(dabProgram);
      gl.uniform3fv(dabLoc.uChannel, mode === 'brighten' ? [1, 0, 0] : mode === 'darken' ? [0, 1, 0] : [0, 0, 1]);
      gl.uniform1f(dabLoc.uAmount, mode === 'erase' ? 0.5 : DAB_AMOUNT);
      gl.enable(gl.BLEND);
      if (mode === 'erase') gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(dabVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, dabVbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, n * 6);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    dropPaint() {
      if (paintFbo) gl.deleteFramebuffer(paintFbo);
      if (paintTex) gl.deleteTexture(paintTex);
      paintTex = paintFbo = null;
      paintSize = null;
    },

    // ---- drawing --------------------------------------------------------------
    // Draw the photo on the stage. `before` draws pristine with identity tone;
    // `wipeX` (device px) draws After, then Before to the left of it.
    draw({ quads, uniforms, before = false, wipeX = null, background = [0.051, 0.047, 0.043] }) {
      if (!ok || lost) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(background[0], background[1], background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!pristine) return;
      const grainScale = quads.grainScale ?? [canvas.width, canvas.height];
      const pass = (u, tex, paint) => {
        bindDevelop(u, { texture: tex, grainScale, paint });
        gl.bindVertexArray(vao);
        for (const quad of quads) {
          writeQuad(quad, canvas.width, canvas.height, true);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        gl.bindVertexArray(null);
      };
      if (before) {
        pass(IDENTITY, pristine, false);
        return;
      }
      pass(uniforms, base ?? pristine, true);
      if (wipeX !== null) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, Math.max(0, Math.round(wipeX)), canvas.height);
        pass(IDENTITY, pristine, false);
        gl.disable(gl.SCISSOR_TEST);
      }
    },

    // Render the edit at exact size (e.g. an export band or a thumbnail) and
    // return RGBA rows top-first.
    // `before` = pristine, untouched; `tone: false` = the current pixels (fills
    // included) through the crop but with no tone, for analysis.
    renderPixels({ width, height, quad, uniforms, grainScale = [width, height], before = false, tone = true }) {
      if (!ok || lost) throw new Error('WebGL is not available right now');
      const plain = before || !tone;
      return renderToBuffer(width, height, quad, plain ? IDENTITY : uniforms, {
        texture: before ? pristine : base ?? pristine,
        grainScale,
        paint: !plain,
      });
    },
  };
  return api;
}

// Develop uniforms that leave the image untouched (Before, analysis, readbacks).
export const IDENTITY = Object.freeze({
  wb: [1, 1, 1], exposure: 1, rolloff: 0, shadows: 0, highlights: 0, gamma: 1, contrast: 0,
  blacks: 0, whites: 0, saturation: 1, vibrance: 0, vignette: 0, grain: 0, fade: 0, mono: 0,
  monoMix: [0.2126, 0.7152, 0.0722], splitShadow: [0, 0, 0], splitHighlight: [0, 0, 0],
});

function setSampling(gl, mipmaps) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function link(gl, vsSource, fsSource) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`shader compile failed: ${log}`);
    }
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

// Blurred linear luminance (R8) from a small RGBA readback: three box blurs ≈ a
// Gaussian of σ ≈ 8 px at 512 px.
export function blurLuminance({ width: w, height: h, data }) {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  let lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.2126 * table[data[i * 4]] + 0.7152 * table[data[i * 4 + 1]] + 0.0722 * table[data[i * 4 + 2]];
  const radius = Math.max(1, Math.round((Math.max(w, h) / 512) * 8));
  for (let pass = 0; pass < 3; pass++) lum = boxBlur(lum, w, h, radius);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.round(Math.min(1, Math.max(0, lum[i])) * 255);
  return { width: w, height: h, data: out };
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
