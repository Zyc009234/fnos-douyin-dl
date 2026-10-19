'use strict';
// 生成应用图标（不依赖第三方库）：深色圆角底 + 青/粉错位音符 + 右下角粉色下载徽章
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
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(x, y, cx, cy, r) { return Math.hypot(x - cx, y - cy) - r; }
// 圆弧：圆心 (cx,cy)、半径 r、粗细 t，角度范围 [a0,a1]（弧度，y 轴向下）
function sdArc(x, y, cx, cy, r, t, a0, a1) {
  const ang = Math.atan2(y - cy, x - cx);
  if (ang >= a0 && ang <= a1) return Math.abs(Math.hypot(x - cx, y - cy) - r) - t / 2;
  const e0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const e1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  return Math.min(Math.hypot(x - e0[0], y - e0[1]), Math.hypot(x - e1[0], y - e1[1])) - t / 2;
}
function sdTriangleDown(x, y, cx, top, halfW, h) {
  const ny = (y - top) / h;
  if (ny < 0) return top - y;
  if (ny > 1) return Math.hypot(x - cx, y - (top + h));
  return Math.abs(x - cx) - halfW * (1 - ny);
}

// 音符：圆形符头 + 竖杆 + 向右下弯的符尾（原创造型）
function sdNote(x, y) {
  const head = sdCircle(x, y, 0.385, 0.63, 0.115);
  const stem = sdRoundRect(x, y, 0.47, 0.42, 0.032, 0.21, 0.02);
  const flag = sdArc(x, y, 0.47, 0.37, 0.155, 0.066, -Math.PI / 2, 0.15);
  return Math.min(head, stem, flag);
}
function sdBadge(x, y) { return sdCircle(x, y, 0.73, 0.73, 0.155); }
function sdBadgeArrow(x, y) {
  const shaft = sdRoundRect(x, y, 0.73, 0.69, 0.024, 0.06, 0.012);
  const tip = sdTriangleDown(x, y, 0.73, 0.725, 0.07, 0.065);
  return Math.min(shaft, tip);
}

function shade(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.5, 0.42, 0.42, 0.11) > 0) return null;
  const t = (x + y) / 2;
  let c = [32 - 14 * t, 33 - 14 * t, 46 - 18 * t]; // 深色底
  const d = 0.022;
  if (sdNote(x + d, y + d * 0.7) <= 0) c = [37, 244, 238]; // 青色错位
  if (sdNote(x - d, y - d * 0.7) <= 0) c = [254, 44, 85];  // 粉色错位
  if (sdNote(x, y) <= 0) c = [255, 255, 255];
  const b = sdBadge(x, y);
  if (b <= 0.018 && b > 0) c = [32 - 14 * t, 33 - 14 * t, 46 - 18 * t]; // 徽章外圈描边，和音符隔开
  if (b <= 0) c = [254, 44, 85];
  if (sdBadgeArrow(x, y) <= 0) c = [255, 255, 255];
  return c;
}

function render(size) {
  const ss = 4, out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (py * size + px) * 4;
    if (a) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; }
    out[i + 3] = (a / (ss * ss)) * 255;
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
