// Converts a TTF into the three.js "typeface" JSON format, subset to the
// characters a name tag needs. Mirrors three/examples/jsm/loaders/TTFLoader.
//
//   node tools/bouquet/make-font.mjs /path/to/Font.ttf src/bouquet/tag-font.json
import { readFileSync, writeFileSync } from 'node:fs'
import opentype from 'opentype.js'

const [, , ttfPath, outPath] = process.argv
if (!ttfPath || !outPath) {
  console.error('usage: make-font.mjs <font.ttf> <out.json>')
  process.exit(1)
}

const CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ' +
  "'’-&.!" +
  'ÁÉÍÓÚÑÜáéíóúñüàèìòùâêîôûäëïöçÇ'

const font = opentype.parse(new Uint8Array(readFileSync(ttfPath)).buffer)
const scale = (1000 * 100) / ((font.unitsPerEm || 2048) * 72)
const glyphs = {}

for (const ch of CHARS) {
  const glyph = font.charToGlyph(ch)
  if (!glyph || glyph.index === 0 || !glyph.path) continue
  let o = ''
  const path = glyph.getPath ? glyph.path : glyph.path
  for (const cmd of path.commands) {
    if (cmd.type === 'M') o += `m ${Math.round(cmd.x * scale)} ${Math.round(cmd.y * scale)} `
    else if (cmd.type === 'L') o += `l ${Math.round(cmd.x * scale)} ${Math.round(cmd.y * scale)} `
    else if (cmd.type === 'Q')
      o += `q ${Math.round(cmd.x * scale)} ${Math.round(cmd.y * scale)} ${Math.round(cmd.x1 * scale)} ${Math.round(cmd.y1 * scale)} `
    else if (cmd.type === 'C')
      o += `b ${Math.round(cmd.x * scale)} ${Math.round(cmd.y * scale)} ${Math.round(cmd.x1 * scale)} ${Math.round(cmd.y1 * scale)} ${Math.round(cmd.x2 * scale)} ${Math.round(cmd.y2 * scale)} `
    else if (cmd.type === 'Z') o += 'z '
  }
  glyphs[ch] = { ha: Math.round(glyph.advanceWidth * scale), x_min: Math.round(glyph.xMin * scale), x_max: Math.round(glyph.xMax * scale), o: o.trim() }
}

const out = {
  glyphs,
  familyName: font.names.fontFamily?.en ?? 'font',
  ascender: Math.round(font.ascender * scale),
  descender: Math.round(font.descender * scale),
  underlinePosition: Math.round((font.tables.post?.underlinePosition ?? -100) * scale),
  underlineThickness: Math.round((font.tables.post?.underlineThickness ?? 50) * scale),
  boundingBox: {
    xMin: Math.round(font.tables.head.xMin * scale),
    xMax: Math.round(font.tables.head.xMax * scale),
    yMin: Math.round(font.tables.head.yMin * scale),
    yMax: Math.round(font.tables.head.yMax * scale),
  },
  resolution: 1000,
  original_font_information: { format: 0, copyright: font.names.copyright?.en ?? '', license: font.names.license?.en ?? '' },
}

writeFileSync(outPath, JSON.stringify(out))
console.log(`wrote ${outPath}: ${Object.keys(glyphs).length} glyphs from ${out.familyName}`)
