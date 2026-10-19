'use strict';
// 生成应用图标（不依赖第三方库）：圆角渐变底 + 白色下载箭头
// 用法：node tools/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 有符号距离函数，坐标归一化到 [0,1]
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdTriangleDown(x, y, cx, top, halfW, h) {
  // 倒三角：顶边 y=top，宽 2*halfW，尖点在 top+h
  const ny = (y - top) / h;
  if (ny < 0) return top - y;
  if (ny > 1) return Math.hypot(x - cx, y - (top + h));
  const w = halfW * (1 - ny);
  return Math.max(Math.abs(x - cx) - w, -(y - top), 0) * 0.9 + Math.min(0, Math.abs(x - cx) - w);
}

function render(size) {
  const ss = 4; // 超采样抗锯齿
  const out = Buffer.alloc(size * size * 4);
  const pink = [254, 44, 85];
  const deep = [190, 20, 70];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (sdRoundRect(x, y, 0.5, 0.5, 0.42, 0.42, 0.11) > 0) continue;
          const t = (x + y) / 2;
          let c = pink.map((v, i) => v + (deep[i] - v) * t);
          // 青色描边点缀（抖音风格的错位色）
          const shaft = sdRoundRect(x, y, 0.5, 0.40, 0.065, 0.16, 0.03);
          const head = sdTriangleDown(x, y, 0.5, 0.50, 0.17, 0.15);
          const base = sdRoundRect(x, y, 0.5, 0.75, 0.2, 0.04, 0.04);
          const arrow = Math.min(shaft, head, base);
          const shadow = Math.min(
            sdRoundRect(x + 0.02, y, 0.5, 0.40, 0.065, 0.16, 0.03),
            sdTriangleDown(x + 0.02, y, 0.5, 0.50, 0.17, 0.15),
            sdRoundRect(x + 0.02, y, 0.5, 0.75, 0.2, 0.04, 0.04)
          );
          if (arrow <= 0) c = [255, 255, 255];
          else if (shadow <= 0) c = [37, 244, 238];
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, out);
}

const root = path.join(__dirname, '..');
const targets = [
  ['ICON.PNG', 64],
  ['ICON_256.PNG', 256],
  ['app/ui/images/icon_64.png', 64],
  ['app/ui/images/icon_256.png', 256],
  ['app/www/icon.png', 128],
];
for (const [file, size] of targets) {
  const p = path.join(root, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, render(size));
  console.log('wrote', file);
}
