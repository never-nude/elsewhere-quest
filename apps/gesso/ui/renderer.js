// The only WebGL2 context in the app. It draws the working image through the
// develop shader (lib/develop.js) onto the stage canvas, and renders exports into
// an offscreen framebuffer at exact output size.
//
// The CPU-side source canvas is the source of truth: iOS drops WebGL contexts when
// the app is backgrounded, and on restore we simply re-upload from it.

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

const UNIFORM_NAMES = [
  'uImage', 'uBlur', 'uHasBlur', 'uWb', 'uExposure', 'uRolloff', 'uShadows', 'uHighlights', 'uGamma',
  'uContrast', 'uBlacks', 'uWhites', 'uSaturation', 'uVibrance', 'uVignette', 'uGrain', 'uFade',
  'uMono', 'uSplitShadow', 'uSplitHighlight', 'uGrainScale', 'uMix', 'uWipe',
];

export function createRenderer(canvas, { onLost, onRestored } = {}) {
  let gl = null;
  let program = null;
  let loc = {};
  let vao = null;
  let vbo = null;
  let sourceTex = null;
  let blurTex = null;
  let source = null; // { canvas, width, height }
  let blur = null; // { width, height, data: Uint8Array }
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
    const stride = 6 * 4;
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(loc.aUv);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(loc.aOut);
    gl.vertexAttribPointer(loc.aOut, 2, gl.FLOAT, false, stride, 16);
    gl.bindVertexArray(null);
    sourceTex = null;
    blurTex = null;
    if (source) uploadSource();
    if (blur) uploadBlur();
    return true;
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // tells the browser we want it back
    lost = true;
    onLost?.();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    init();
    onRestored?.();
  });

  const ok = init();

  function uploadSource() {
    if (!sourceTex) sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source.canvas);
    setSampling(gl, true);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  function uploadBlur() {
    if (!blurTex) blurTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blurTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, blur.width, blur.height, 0, gl.RED, gl.UNSIGNED_BYTE, blur.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    setSampling(gl, false);
  }

  // Corners in order TL, TR, BL, BR: { x, y } in target px (y down), { u, v } source
  // UV, { ox, oy } output 0..1.
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

  function setUniforms(u, { mix = 1, wipe = -1, grainScale }) {
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(loc.uImage, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurTex);
    gl.uniform1i(loc.uBlur, 1);
    gl.uniform1i(loc.uHasBlur, blurTex ? 1 : 0);
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
    gl.uniform3fv(loc.uSplitShadow, u.splitShadow);
    gl.uniform3fv(loc.uSplitHighlight, u.splitHighlight);
    gl.uniform2fv(loc.uGrainScale, grainScale);
    gl.uniform1f(loc.uMix, mix);
    gl.uniform1f(loc.uWipe, wipe);
  }

  return {
    ok,
    get lost() { return lost; },
    get gl() { return gl; },
    maxTextureSize: ok ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0,

    // Size the drawing buffer to the canvas's CSS box at device resolution.
    resize(cssWidth, cssHeight, dpr) {
      const w = Math.max(1, Math.round(cssWidth * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { width: w, height: h };
    },

    setSource(sourceCanvas) {
      source = { canvas: sourceCanvas, width: sourceCanvas.width, height: sourceCanvas.height };
      if (ok && !lost) uploadSource();
    },

    // After a Remove: re-upload just the changed rectangle, then rebuild mips.
    updateSourceRegion(rect) {
      if (!ok || lost || !sourceTex) return;
      const ctx = source.canvas.getContext('2d');
      const img = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
      gl.generateMipmap(gl.TEXTURE_2D);
    },

    setBlur(width, height, data) {
      blur = { width, height, data };
      if (ok && !lost) uploadBlur();
    },

    clearBlur() {
      blur = null;
      if (blurTex && gl) gl.deleteTexture(blurTex);
      blurTex = null;
    },

    // Draw to the stage. `quads` is a list of corner sets (usually one).
    draw({ quads, uniforms, mix = 1, wipe = -1, grainScale = [1, 1], background = [0, 0, 0] }) {
      if (!ok || lost) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(background[0], background[1], background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!sourceTex) return;
      setUniforms(uniforms, { mix, wipe, grainScale });
      gl.bindVertexArray(vao);
      for (const quad of quads) {
        writeQuad(quad, canvas.width, canvas.height, true);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.bindVertexArray(null);
    },

    // Render at exact output size into an offscreen framebuffer and read it back in
    // the same task (preserveDrawingBuffer is off, so never read the stage).
    // Returns RGBA rows top-first, ready for ImageData.
    renderPixels({ width, height, quad, uniforms }) {
      if (!ok || lost) throw new Error('WebGL is not available right now');
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      try {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('export buffer incomplete');
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        setUniforms(uniforms, { mix: 1, wipe: -1, grainScale: [width, height] });
        gl.bindVertexArray(vao);
        // y not flipped: framebuffer row 0 is output row 0, so readPixels is top-first.
        writeQuad(quad, width, height, false);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        const out = new Uint8ClampedArray(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return out;
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
      }
    },
  };
}

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

// Blurred linear luminance at low resolution, for local shadows/highlights.
// Draws the source small (the browser downsamples), then box-blurs three times
// (≈ Gaussian). Returns { width, height, data: Uint8Array }.
export function computeBlurLum(sourceCanvas, maxSide = 256) {
  const s = Math.min(1, maxSide / Math.max(sourceCanvas.width, sourceCanvas.height));
  const w = Math.max(1, Math.round(sourceCanvas.width * s));
  const h = Math.max(1, Math.round(sourceCanvas.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;
  let lum = new Float32Array(w * h);
  const lin = (v) => { const c1 = v / 255; return c1 <= 0.04045 ? c1 / 12.92 : Math.pow((c1 + 0.055) / 1.055, 2.4); };
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = lin(i);
  for (let i = 0; i < w * h; i++) lum[i] = 0.2126 * table[px[i * 4]] + 0.7152 * table[px[i * 4 + 1]] + 0.0722 * table[px[i * 4 + 2]];
  const radius = Math.max(1, Math.round(Math.max(w, h) / 48));
  for (let pass = 0; pass < 3; pass++) lum = boxBlur(lum, w, h, radius);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.round(Math.min(1, Math.max(0, lum[i])) * 255);
  return { width: w, height: h, data: out };
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
