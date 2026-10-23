// Synthetic images with an original, generated ICC v4 CLUT profile. No
// personal image or vendor profile is embedded. WebKit has a distinct color
// conversion path for resized ImageBitmap JPEGs/PNGs; compare with the same
// browser's HTMLImage decode rather than assuming every browser's ICC result.
import { deflateSync } from 'node:zlib';

const uint32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const fixed = (value) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(Math.round(value * 65536)); return bytes; };
const aligned = (bytes) => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
const label = (text) => {
  const encoded = Buffer.from(text, 'utf16le'); encoded.swap16();
  return Buffer.concat([Buffer.from('mluc'), Buffer.alloc(4), uint32(1), uint32(12), Buffer.from('enUS'), uint32(encoded.length), uint32(28), encoded]);
};

export function syntheticRgbProfile() {
  const curve = Buffer.concat([Buffer.from('curv'), Buffer.alloc(4), uint32(0)]);
  const clut = Buffer.alloc(20 + 8 * 3 * 2);
  clut.set([2, 2, 2]); clut[16] = 2; // two grid points per RGB channel, 16-bit entries
  // Linear RGB to D50 XYZ; ICC's 16-bit XYZ PCS uses 1.0 = 32768.
  const matrix = [[0.4360747, 0.3850649, 0.1430804], [0.2225045, 0.7168786, 0.0606169], [0.0139322, 0.0971045, 0.7141733]];
  let at = 20;
  for (const r of [0, 1]) for (const g of [0, 1]) for (const b of [0, 1]) {
    for (const row of matrix) { clut.writeUInt16BE(Math.round((row[0] * r + row[1] * g + row[2] * b) * 32768), at); at += 2; }
  }
  const lut = Buffer.concat([
    Buffer.from('mAB '), Buffer.alloc(4), Buffer.from([3, 3, 0, 0]),
    uint32(32), uint32(0), uint32(0), uint32(68), uint32(32), curve, curve, curve, clut,
  ]);
  const white = Buffer.concat([Buffer.from('XYZ '), Buffer.alloc(4), fixed(0.9642), fixed(1), fixed(0.8249)]);
  const tags = [
    ['desc', label('Gesso synthetic RGB CLUT')], ['cprt', label('Public domain synthetic test profile')],
    ['wtpt', white], ['A2B0', lut], ['A2B1', lut], ['A2B2', lut],
  ];
  const header = Buffer.alloc(128);
  header.set([4, 0, 0, 0], 8); header.write('scnrRGB XYZ ', 12);
  [2026, 1, 1, 0, 0, 0].forEach((value, i) => header.writeUInt16BE(value, 24 + i * 2));
  header.write('acsp', 36); header.writeUInt32BE(1, 64);
  Buffer.concat([fixed(0.9642), fixed(1), fixed(0.8249)]).copy(header, 68);
  const table = [uint32(tags.length)], body = [];
  let offset = header.length + 4 + tags.length * 12;
  for (const [name, bytes] of tags) {
    table.push(Buffer.from(name), uint32(offset), uint32(bytes.length));
    const padded = aligned(bytes); body.push(padded); offset += padded.length;
  }
  const profile = Buffer.concat([header, ...table, ...body]); profile.writeUInt32BE(profile.length);
  return profile;
}

async function paintSwatches(page, { width, height, type, alpha = false }) {
  const url = await page.evaluate(({ width, height, type, alpha }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    ['rgb(210,140,80)', 'rgb(60,140,190)', 'rgb(180,80,160)', 'rgb(125,160,90)'].forEach((color, i) => {
      context.fillStyle = color; context.fillRect((i % 2) * width / 2, Math.floor(i / 2) * height / 2, width / 2, height / 2);
    });
    if (alpha) {
      context.clearRect(width * 0.4, height * 0.4, width * 0.2, height * 0.2);
      context.clearRect(width * 0.05, height * 0.05, width * 0.1, height * 0.1);
      context.fillStyle = 'rgba(210,140,80,0.5)';
      context.fillRect(width * 0.05, height * 0.05, width * 0.1, height * 0.1);
    }
    const result = canvas.toDataURL(type, 0.95); canvas.width = canvas.height = 0;
    return result;
  }, { width, height, type, alpha });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

export async function profiledJpeg(page, { width = 2560, height = 1920 } = {}) {
  const jpeg = await paintSwatches(page, { width, height, type: 'image/jpeg' });
  const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from([1, 1]), syntheticRgbProfile()]);
  const marker = Buffer.alloc(4); marker[0] = 0xff; marker[1] = 0xe2; marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

function pngChunk(name, payload) {
  const type = Buffer.from(name), data = Buffer.concat([type, payload]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return Buffer.concat([uint32(payload.length), data, uint32((crc ^ 0xffffffff) >>> 0)]);
}

export async function profiledPng(page, { width = 2560, height = 1920 } = {}) {
  const png = await paintSwatches(page, { width, height, type: 'image/png', alpha: true });
  const profile = pngChunk('iCCP', Buffer.concat([Buffer.from('Gesso synthetic\0'), Buffer.from([0]), deflateSync(syntheticRgbProfile())]));
  const chunks = [png.subarray(0, 8)];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8);
    if (!['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP'].includes(name)) chunks.push(png.subarray(offset, offset + length + 12));
    if (name === 'IHDR') chunks.push(profile);
    offset += length + 12;
  }
  return Buffer.concat(chunks);
}
