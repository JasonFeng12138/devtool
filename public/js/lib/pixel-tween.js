// 像素风补帧：像素网格检测、调色板吸附、整像素位移补帧。纯函数，可在 Node 中测试。
// 原则：补出的帧不产生源帧里没有的颜色，物体只按整像素移动，保持像素画的硬边。

import { buildMask, estimateBackground, findComponents, mergeBoxes } from './sprite-detect.js';

const MAX_GRID = 16; // 放大像素画的最大倍数
const MAX_PALETTE = 4096; // 颜色超过这个数量时不是像素画，不做调色板吸附

const gcd = (a, b) => {
  while (b) [a, b] = [b, a % b];
  return a;
};

// 两个像素是否相同（全透明的像素不论颜色都视为相同）
function samePixel(d, i, j) {
  if (!d[i + 3] && !d[j + 3]) return true;
  return d[i] === d[j] && d[i + 1] === d[j + 1] && d[i + 2] === d[j + 2] && d[i + 3] === d[j + 3];
}

/**
 * 检测放大后的像素画网格：每个“美术像素”都是 k×k 的同色方块时返回 { k, ox, oy }（网格起点），否则 k = 1。
 * 所有颜色边界都落在同一网格线上才算，所以按网格缩小再放大对源帧是无损的。
 */
export function detectPixelGrid(frames, w, h) {
  let gx = 0, gy = 0, bx = -1, by = -1;
  for (const d of frames) {
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4;
        if (samePixel(d, i - 4, i)) continue;
        if (bx < 0) bx = x;
        gx = gcd(gx, Math.abs(x - bx));
      }
      if (gx === 1) return { k: 1, ox: 0, oy: 0 };
    }
    for (let x = 0; x < w; x++) {
      for (let y = 1; y < h; y++) {
        const i = (y * w + x) * 4;
        if (samePixel(d, i - w * 4, i)) continue;
        if (by < 0) by = y;
        gy = gcd(gy, Math.abs(y - by));
      }
      if (gy === 1) return { k: 1, ox: 0, oy: 0 };
    }
  }
  // 只有一条边界时差值为 0，按该方向的位置推断不出倍数，只用另一个方向
  let k = gcd(gx, gy);
  if (!gx && !gy) k = 1;
  if (k < 2 || k > MAX_GRID) return { k: 1, ox: 0, oy: 0 };
  return { k, ox: bx < 0 ? 0 : bx % k, oy: by < 0 ? 0 : by % k };
}

function gridMap(size, k, offset) {
  const shift = (k - (offset % k)) % k; // 让网格线对齐到 0
  const map = new Int32Array(size);
  for (let x = 0; x < size; x++) map[x] = Math.floor((x + shift) / k);
  return map;
}

/** 按网格缩小为每个美术像素一个像素，返回 { data, w, h } */
export function toNative(d, w, h, grid) {
  if (grid.k === 1) return { data: d, w, h };
  const mx = gridMap(w, grid.k, grid.ox);
  const my = gridMap(h, grid.k, grid.oy);
  const nw = mx[w - 1] + 1;
  const nh = my[h - 1] + 1;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (my[y] * nw + mx[x]) * 4;
      const i = (y * w + x) * 4;
      out[o] = d[i];
      out[o + 1] = d[i + 1];
      out[o + 2] = d[i + 2];
      out[o + 3] = d[i + 3];
    }
  }
  return { data: out, w: nw, h: nh };
}

/** toNative 的逆过程：按网格放大回 w × h */
export function fromNative(n, grid, w, h) {
  if (grid.k === 1) return n.data;
  const mx = gridMap(w, grid.k, grid.ox);
  const my = gridMap(h, grid.k, grid.oy);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (my[y] * n.w + mx[x]) * 4;
      const o = (y * w + x) * 4;
      out[o] = n.data[i];
      out[o + 1] = n.data[i + 1];
      out[o + 2] = n.data[i + 2];
      out[o + 3] = n.data[i + 3];
    }
  }
  return out;
}

/** 最近邻放大 s 倍 */
export function scaleUp(n, s) {
  return { data: fromNative(n, { k: s, ox: 0, oy: 0 }, n.w * s, n.h * s), w: n.w * s, h: n.h * s };
}

/**
 * 把 AI 补出的帧（n.w*s × n.h*s）整理成像素画：透明度二值化、颜色吸附到源帧调色板、
 * 每个 s×s 方块取出现最多的颜色缩回原生尺寸，最后去掉源帧里没有的孤立像素。
 */
export function pixelate(out, w, h, s, sources) {
  const palette = new Map();
  let binary = true;
  let minAlpha = 255;
  for (const src of sources) {
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (!a) continue;
      if (a !== 255) binary = false;
      if (a < minAlpha) minAlpha = a;
      if (palette.size <= MAX_PALETTE) palette.set(((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | a) >>> 0, [d[i], d[i + 1], d[i + 2], a]);
    }
  }
  const colors = palette.size <= MAX_PALETTE ? [...palette.values()] : null;
  const cut = binary ? 128 : minAlpha / 2;
  const cache = new Map();
  const snapped = new Uint8ClampedArray(out.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a < cut) continue;
    if (!colors) {
      snapped[i] = out[i];
      snapped[i + 1] = out[i + 1];
      snapped[i + 2] = out[i + 2];
      snapped[i + 3] = binary ? 255 : a;
      continue;
    }
    const key = ((out[i] >> 1) << 21) | ((out[i + 1] >> 1) << 14) | ((out[i + 2] >> 1) << 7) | (binary ? 127 : a >> 1);
    let c = cache.get(key);
    if (!c) {
      let best = Infinity;
      const aa = binary ? 255 : a;
      for (const p of colors) {
        const dr = p[0] - out[i], dg = p[1] - out[i + 1], db = p[2] - out[i + 2], da = p[3] - aa;
        const dist = dr * dr + dg * dg + db * db + da * da;
        if (dist < best) {
          best = dist;
          c = p;
        }
      }
      cache.set(key, c);
    }
    snapped[i] = c[0];
    snapped[i + 1] = c[1];
    snapped[i + 2] = c[2];
    snapped[i + 3] = c[3];
  }

  // 每个 s×s 方块取出现最多的颜色（透明算一种）
  const nw = w / s;
  const nh = h / s;
  const native = new Uint8ClampedArray(nw * nh * 4);
  const counts = new Map();
  for (let cy = 0; cy < nh; cy++) {
    for (let cx = 0; cx < nw; cx++) {
      counts.clear();
      let bestKey = 0, bestN = 0, bestI = -1;
      for (let y = cy * s; y < cy * s + s; y++) {
        for (let x = cx * s; x < cx * s + s; x++) {
          const i = (y * w + x) * 4;
          const key = snapped[i + 3] ? ((snapped[i] << 24) | (snapped[i + 1] << 16) | (snapped[i + 2] << 8) | snapped[i + 3]) >>> 0 : 0;
          const n = (counts.get(key) || 0) + 1;
          counts.set(key, n);
          if (n > bestN) {
            bestN = n;
            bestKey = key;
            bestI = i;
          }
        }
      }
      if (!bestKey) continue;
      const o = (cy * nw + cx) * 4;
      native.set(snapped.subarray(bestI, bestI + 4), o);
    }
  }
  const result = { data: native, w: nw, h: nh };
  if (!sources.some((src) => countIsolated(src) > 0)) removeIsolated(result);
  return result;
}

// 四周 8 邻域都透明的不透明像素
function isolated(n, x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n.w || ny >= n.h) continue;
      if (n.data[(ny * n.w + nx) * 4 + 3]) return false;
    }
  }
  return true;
}

function countIsolated(n) {
  let count = 0;
  for (let y = 0; y < n.h; y++) {
    for (let x = 0; x < n.w; x++) if (n.data[(y * n.w + x) * 4 + 3] && isolated(n, x, y)) count++;
  }
  return count;
}

function removeIsolated(n) {
  for (let y = 0; y < n.h; y++) {
    for (let x = 0; x < n.w; x++) {
      const i = (y * n.w + x) * 4;
      if (n.data[i + 3] && isolated(n, x, y)) n.data.fill(0, i, i + 4);
    }
  }
}

// ---------- 像素位移 ----------

// 前景物体：相距 ≤ 2px 的连通块合为一个物体，返回每个物体的像素下标
function findObjects(n, bg) {
  const mask = buildMask(n.data, n.w, n.h, bg, 2);
  const boxes = findComponents(mask, n.w, n.h);
  const merged = boxes ? mergeBoxes(boxes, 2) : [{ x: 0, y: 0, w: n.w, h: n.h }];
  const taken = new Uint8Array(n.w * n.h);
  const objects = [];
  for (const b of merged) {
    const pixels = [];
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const p = y * n.w + x;
        if (mask[p] && !taken[p]) {
          taken[p] = 1;
          pixels.push(p);
        }
      }
    }
    if (pixels.length) objects.push(pixels);
  }
  return { mask, objects };
}

// 由近到远排列的候选位移，距离相同时优先选位移小的
function offsetList(r) {
  const list = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) list.push([dx, dy]);
  return list.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
}

const MAX_SAMPLES = 1500;
const MATCH_LIMIT = 255; // 平均每像素差异（RGBA 绝对差之和）超过它视为没有对应物体，不移动

// 物体在另一帧中的整像素位移：采样物体像素，找差异最小的位移
function matchOffset(pixels, src, dst, offsets) {
  const step = Math.max(1, Math.floor(pixels.length / MAX_SAMPLES));
  const samples = [];
  for (let i = 0; i < pixels.length; i += step) samples.push(pixels[i]);
  const { w, h } = src;
  const s = src.data;
  const d = dst.data;
  let best = Infinity;
  let bestOff = [0, 0];
  for (const [dx, dy] of offsets) {
    let cost = 0;
    for (const p of samples) {
      const x = (p % w) + dx;
      const y = ((p / w) | 0) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) {
        cost += 1020;
      } else {
        const i = p * 4;
        const j = (y * w + x) * 4;
        cost += Math.abs(s[i] - d[j]) + Math.abs(s[i + 1] - d[j + 1]) + Math.abs(s[i + 2] - d[j + 2]) + Math.abs(s[i + 3] - d[j + 3]);
      }
      if (cost >= best) break;
    }
    if (cost < best) {
      best = cost;
      bestOff = [dx, dy];
    }
  }
  return best / samples.length <= MATCH_LIMIT ? bestOff : [0, 0];
}

// 正负对称的四舍五入（Math.round(-7.5) 是 -7），让前进和后退的位移一致
const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

/**
 * 像素位移补帧：前半段用前一帧的造型、后半段用后一帧的造型，每个物体按整像素从起点移向终点，
 * 不混合颜色。适合平移为主的动作（弹道、漂浮、行走时身体的起伏等）。
 */
export function shiftTween(a, b, w, h, times) {
  const grid = detectPixelGrid([a, b], w, h);
  const A = toNative(a, w, h, grid);
  const B = toNative(b, w, h, grid);
  const bg = estimateBackground(A.data, A.w, A.h);
  const fill = bg.length ? [...bg[0], 255] : [0, 0, 0, 0];
  const r = Math.min(64, Math.max(A.w, A.h)); // 像素画尺寸小，直接在整个画面内搜索位移
  const offsets = offsetList(r);
  const plan = (src, dst) => {
    const { mask, objects } = findObjects(src, bg);
    return { src, mask, moves: objects.map((pixels) => ({ pixels, d: matchOffset(pixels, src, dst, offsets) })) };
  };
  let forward = null; // A 的物体移向 B
  let backward = null; // B 的物体从 A 的位置移来
  return times.map((t) => {
    const early = t < 0.5;
    const p = early ? (forward ??= plan(A, B)) : (backward ??= plan(B, A));
    const f = early ? t : 1 - t;
    const { src, mask, moves } = p;
    const out = new Uint8ClampedArray(src.data);
    for (let q = 0; q < mask.length; q++) if (mask[q]) out.set(fill, q * 4);
    for (const { pixels, d } of moves) {
      const dx = roundHalfAway(d[0] * f);
      const dy = roundHalfAway(d[1] * f);
      for (const q of pixels) {
        const x = (q % src.w) + dx;
        const y = ((q / src.w) | 0) + dy;
        if (x < 0 || y < 0 || x >= src.w || y >= src.h) continue;
        out.set(src.data.subarray(q * 4, q * 4 + 4), (y * src.w + x) * 4);
      }
    }
    return fromNative({ data: out, w: src.w, h: src.h }, grid, w, h);
  });
}
