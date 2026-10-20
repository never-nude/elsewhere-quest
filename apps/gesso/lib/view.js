// How the photo sits on screen: fit, zoom and pan of a content rectangle inside
// the stage, plus the four-corner quads the renderer draws. Pure.
//
// A view is { scale, x, y }: content px -> stage px is (x + cx * scale, y + cy * scale).

import { outputToSource, orientedSize, multiply, apply } from './geometry.js';

export const MAX_ZOOM = 8; // relative to the fitted scale

export function fitView(contentW, contentH, stageW, stageH, pad = 0) {
  const scale = Math.min((stageW - 2 * pad) / contentW, (stageH - 2 * pad) / contentH);
  return {
    scale,
    x: (stageW - contentW * scale) / 2,
    y: (stageH - contentH * scale) / 2,
    fit: scale,
  };
}

export function viewMatrix(v) {
  return [v.scale, 0, 0, v.scale, v.x, v.y];
}

export function stageToContent(v, sx, sy) {
  return [(sx - v.x) / v.scale, (sy - v.y) / v.scale];
}

// Zoom by `factor` keeping the content point under (cx, cy) fixed, clamped to
// [fit, fit * MAX_ZOOM].
export function zoomAt(v, factor, cx, cy) {
  const scale = Math.max(v.fit, Math.min(v.fit * MAX_ZOOM, v.scale * factor));
  const k = scale / v.scale;
  return { ...v, scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}

export function panBy(v, dx, dy) {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

// Keep the content filling the stage when it's bigger than it, centred when smaller.
export function clampView(v, contentW, contentH, stageW, stageH) {
  const w = contentW * v.scale, h = contentH * v.scale;
  const x = w <= stageW ? (stageW - w) / 2 : Math.min(0, Math.max(stageW - w, v.x));
  const y = h <= stageH ? (stageH - h) / 2 : Math.min(0, Math.max(stageH - h, v.y));
  return { ...v, x, y };
}

export function isZoomed(v) {
  return v.scale > v.fit * 1.01;
}

// Corners of the cropped output, as drawn: stage position, source UV (0..1) and
// output position (0..1, for the vignette).
export function outputQuad(crop, srcW, srcH, outW, outH, outputToStage) {
  const toSource = outputToSource(crop, srcW, srcH);
  return [[0, 0], [outW, 0], [0, outH], [outW, outH]].map(([ox, oy]) => {
    const [x, y] = apply(outputToStage, ox, oy);
    const [sx, sy] = apply(toSource, ox, oy);
    return { x, y, u: sx / srcW, v: sy / srcH, ox: ox / outW, oy: oy / outH };
  });
}

// Corners of the whole (uncropped) straightened image, for the crop tool. `frameToStage`
// maps frame space (centred, straightened) to the stage; output coords are relative
// to the crop rect so effects line up with what will be exported.
export function frameQuad(crop, srcW, srcH, frameToStage) {
  const o = orientedSize(srcW, srcH, crop.quarter);
  // frame -> output: shift by -rect origin; output -> source via the crop matrix
  const toSource = outputToSource(crop, srcW, srcH);
  const frameToOutput = [1, 0, 0, 1, -crop.rect.x, -crop.rect.y];
  const frameToSource = multiply(toSource, frameToOutput);
  const c = Math.cos((crop.angle * Math.PI) / 180), s = Math.sin((crop.angle * Math.PI) / 180);
  // Oriented image corners (centred), rotated into the frame.
  const corners = [[-o.width / 2, -o.height / 2], [o.width / 2, -o.height / 2], [-o.width / 2, o.height / 2], [o.width / 2, o.height / 2]]
    .map(([x, y]) => [x * c - y * s, x * s + y * c]);
  return corners.map(([fx, fy]) => {
    const [x, y] = apply(frameToStage, fx, fy);
    const [sx, sy] = apply(frameToSource, fx, fy);
    return {
      x, y, u: sx / srcW, v: sy / srcH,
      ox: (fx - crop.rect.x) / crop.rect.width, oy: (fy - crop.rect.y) / crop.rect.height,
    };
  });
}

// Bounding box (in frame space) of the straightened image, for fitting the crop
// tool's view so the whole photo and its frame are visible.
export function frameBounds(crop, srcW, srcH) {
  const o = orientedSize(srcW, srcH, crop.quarter);
  const c = Math.abs(Math.cos((crop.angle * Math.PI) / 180)), s = Math.abs(Math.sin((crop.angle * Math.PI) / 180));
  const w = o.width * c + o.height * s, h = o.width * s + o.height * c;
  return { x: -w / 2, y: -h / 2, width: w, height: h };
}

// Where the visible part of the content sits inside a navigator thumbnail of
// navW x navH (the content fitted inside it), for the zoom navigator.
export function navigatorFrame(v, stageW, stageH, contentW, contentH, navW, navH) {
  const k = Math.min(navW / contentW, navH / contentH);
  const ox = (navW - contentW * k) / 2, oy = (navH - contentH * k) / 2;
  const [x0, y0] = stageToContent(v, 0, 0);
  const [x1, y1] = stageToContent(v, stageW, stageH);
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(contentW, x1), cy1 = Math.min(contentH, y1);
  return { x: ox + cx0 * k, y: oy + cy0 * k, width: Math.max(0, cx1 - cx0) * k, height: Math.max(0, cy1 - cy0) * k, scale: k, offsetX: ox, offsetY: oy };
}
