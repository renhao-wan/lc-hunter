/**
 * 生成应用图标 —— 只用 node:zlib，不引任何包。
 *
 * 为什么自己写：项目的硬原则是零 npm 依赖（dependencies 恒为 {}）。
 * 为了一个图标去装 sharp / pngjs / to-ico，会把这条底线破掉。
 * PNG 的编码其实就三件事：IHDR/IDAT/IEND 三个 chunk + CRC32 + deflate，
 * ICO 是「头部 + 若干张 PNG」的目录结构，ICNS 同理，都能手写。
 *
 * 用法：node tools/gen-icon.js
 *
 * 产物：
 *   assets/icon.png      512×512 母版（人也看得懂的那张）
 *   build/icon.png       512×512，Linux 用
 *   build/icon.ico       Windows，内嵌 16/24/32/48/64/128/256 七档
 *   build/icon.icns      macOS，ic11/ic12/ic07/ic08/ic09 五档
 *   web/favicon.png      64×64，浏览器标签页
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------- 图形设计 ----------------
//
// 深橙→橙的渐变圆角方块，中间一个深色的 "LC"。
// 主色沿用界面的 --accent（力扣橙 #ffa116），这样窗口图标和界面是一套色。
// 图标要在 16×16 的任务栏上也认得出来，所以只放两个字母，不画细节。

const BG_TOP = [0xff, 0xb3, 0x40]; // #ffb340
const BG_BOT = [0xff, 0x8a, 0x00]; // #ff8a00
const FG = [0x1f, 0x23, 0x28]; // #1f2328

const RADIUS = 0.22; // 圆角半径（归一化）
const STROKE = 0.125; // 笔画粗细

// L：竖 + 底横
const L_X = 0.145;
const L_Y = 0.26;
const L_H = 0.48;
const L_W = 0.25;

// C：圆环挖掉右侧一段
const C_CX = 0.64;
const C_CY = 0.5;
const C_RO = 0.235;
const C_GAP = 0.9; // 开口半角（弧度），约 52°

/**
 * 判断一个归一化坐标属于哪一层：
 *   0 = 圆角方块外（透明）
 *   1 = 背景
 *   2 = 前景（LC 两个字）
 */
function classify(x, y) {
  // 圆角矩形：把点夹到"去掉四个角的中间矩形"里，再看离最近角心的距离
  const cx = Math.min(Math.max(x, RADIUS), 1 - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), 1 - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  if (dx * dx + dy * dy > RADIUS * RADIUS) return 0;

  // L 的竖笔
  if (x >= L_X && x <= L_X + STROKE && y >= L_Y && y <= L_Y + L_H) return 2;
  // L 的底横
  if (x >= L_X && x <= L_X + L_W && y >= L_Y + L_H - STROKE && y <= L_Y + L_H) return 2;

  // C 的环：半径落在 [RO-T, RO] 且不在右侧开口内
  const ax = x - C_CX;
  const ay = y - C_CY;
  const r = Math.sqrt(ax * ax + ay * ay);
  if (r <= C_RO && r >= C_RO - STROKE) {
    if (Math.abs(Math.atan2(ay, ax)) >= C_GAP) return 2;
  }

  return 1;
}

/**
 * 渲染成 RGBA。
 *
 * 抗锯齿用超采样：每个像素取 SS×SS 个子样本，按落点分类统计，
 * 最后按覆盖率混色。没有第三方库，这是最简单也最稳的做法
 * （比手写直线光栅化省事得多，而且斜边/圆弧都是一样的代码）。
 */
function render(size) {
  const SS = 3;
  const total = SS * SS;
  const bgHit = new Uint16Array(size * size);
  const fgHit = new Uint16Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let b = 0;
      let f = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const k = classify(x, y);
          if (k === 1) b++;
          else if (k === 2) f++;
        }
      }
      const i = py * size + px;
      bgHit[i] = b;
      fgHit[i] = f;
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const b = bgHit[i];
      const f = fgHit[i];
      if (b + f === 0) continue; // 全透明，RGBA 已经是 0

      // 背景沿左上→右下做线性渐变
      const t = ((px + 0.5) / size + (py + 0.5) / size) / 2;
      // 背景色和前景色按各自的覆盖率加权混合，边缘自然就是抗锯齿后的中间色
      const mix = (bgChan, fgChan) => (bgChan * b + fgChan * f) / (b + f);
      rgba[i * 4] = Math.round(mix(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t, FG[0]));
      rgba[i * 4 + 1] = Math.round(mix(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t, FG[1]));
      rgba[i * 4 + 2] = Math.round(mix(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t, FG[2]));
      rgba[i * 4 + 3] = Math.round(((b + f) / total) * 255);
    }
  }
  return rgba;
}

// ---------------- PNG ----------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA(8bit, color type 6) → PNG。每行前面加一个 filter=0 的字节 */
function png(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 容器 ----------------

/**
 * ICO：6 字节头 + 每图 16 字节目录项 + 图片数据。
 * 图片直接用 PNG —— Vista 之后都支持，比手写 BMP 省事得多。
 * 尺寸 ≥256 时目录项的 w/h 字节写 0（那个字段是 1 字节，放不下 256）。
 */
function ico(sizes) {
  const imgs = sizes.map((s) => ({ s, data: png(s, s, render(s)) }));
  const dir = Buffer.alloc(6 + 16 * imgs.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(imgs.length, 4);

  let offset = dir.length;
  imgs.forEach((im, i) => {
    const e = 6 + 16 * i;
    dir[e] = im.s >= 256 ? 0 : im.s;
    dir[e + 1] = im.s >= 256 ? 0 : im.s;
    dir[e + 2] = 0; // 调色板色数
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // color planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(im.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += im.data.length;
  });

  return Buffer.concat([dir, ...imgs.map((im) => im.data)]);
}

/**
 * ICNS：'icns' + 总长度，之后是若干 (类型, 长度, PNG) 块。
 * 类型对应固定的像素尺寸，这里给全 32/64/128/256/512 五档。
 */
function icns(entries) {
  const parts = entries.map(({ type, size }) => {
    const data = png(size, size, render(size));
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------- 输出 ----------------

function write(rel, buf) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  console.log(`  ${rel.padEnd(22)} ${(buf.length / 1024).toFixed(1)} KB`);
}

console.log('生成图标…');
write('assets/icon.png', png(512, 512, render(512)));
write('build/icon.png', png(512, 512, render(512)));
write('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256]));
write(
  'build/icon.icns',
  icns([
    { type: 'ic11', size: 32 },
    { type: 'ic12', size: 64 },
    { type: 'ic07', size: 128 },
    { type: 'ic08', size: 256 },
    { type: 'ic09', size: 512 },
  ]),
);
write('web/favicon.png', png(64, 64, render(64)));
console.log('完成。');
