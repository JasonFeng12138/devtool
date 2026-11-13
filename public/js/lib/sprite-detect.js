// 素材识别：把图片分为背景 / 前景，按 8 连通找出前景块，合并相近的块、过滤噪点、外扩并按阅读顺序排序。
// 纯函数，可在 Worker 或主线程中运行。

import { MAX_COLOR_DISTANCE } from './color-key.js';

export const ALPHA_THRESHOLD = 16; // alpha ≤ 此值的像素始终视为背景
const MAX_COMPONENTS = 50000;

/**
 * 采样图片最外一圈像素估计背景：多数透明则按透明度判断，否则取出现最多的颜色（按 4 位量化统计后取均值）。
 * @returns {number[][]} 背景色列表，空数组表示透明背景
 */
export function estimateBackground(data, width, height) {
  const buckets = new Map();
  let transparent = 0;
  let total = 0;
  const visit = (x, y) => {
    const i = (y * width + x) * 4;
    total++;
    if (data[i + 3] <= ALPHA_THRESHOLD) {
      transparent++;
      return;
    }
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { n: 0, r: 0, g: 0, b: 0 }));
    e.n++;
    e.r += data[i];
    e.g += data[i + 1];
    e.b += data[i + 2];
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    if (height > 1) visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    if (width > 1) visit(width - 1, y);
  }
  if (transparent * 2 >= total) return [];
  let best = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  return [[Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]];
}

/** 前景掩码：1 = 素材像素。与任一背景色的距离 ≤ 容差（0~100 百分比）视为背景 */
export function buildMask(data, width, height, colors, tolerance) {
  const n = width * height;
  const mask = new Uint8Array(n);
  const t = (tolerance / 100) * MAX_COLOR_DISTANCE;
  const t2 = t * t;
  const k = colors.length;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (data[i + 3] <= ALPHA_THRESHOLD) continue;
    if (k) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let near = false;
      for (let c = 0; c < k; c++) {
        const col = colors[c];
        const dr = r - col[0], dg = g - col[1], db = b - col[2];
        if (dr * dr + dg * dg + db * db <= t2) {
          near = true;
          break;
        }
      }
      if (near) continue;
    }
    mask[p] = 1;
  }
  return mask;
}

/** 8 连通前景块的外接矩形；块数超过上限时返回 null */
export function findComponents(mask, width, height) {
  const n = width * height;
  const todo = mask.slice(); // 1 = 尚未访问的前景像素
  let stack = new Int32Array(1 << 16);
  const boxes = [];
  for (let p = 0; p < n; p++) {
    if (!todo[p]) continue;
    todo[p] = 0;
    let sp = 0;
    stack[sp++] = p;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    while (sp) {
      const q = stack[--sp];
      const x = q % width;
      const y = (q - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < width - 1 ? x + 1 : x;
      const y0 = y > 0 ? y - 1 : y;
      const y1 = y < height - 1 ? y + 1 : y;
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0, r = ny * width + x0; nx <= x1; nx++, r++) {
          if (!todo[r]) continue;
          todo[r] = 0;
          if (sp === stack.length) {
            const bigger = new Int32Array(stack.length * 2);
            bigger.set(stack);
            stack = bigger;
          }
          stack[sp++] = r;
        }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    if (boxes.length > MAX_COMPONENTS) return null;
  }
  return boxes;
}

// 两框之间的直线距离（重叠时为 0）是否 ≤ dist；斜向相邻时不会因横纵间距各自较小而误合并
function near(a, b, dist) {
  const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return gapX * gapX + gapY * gapY <= dist * dist;
}

/** 合并间距 ≤ dist（含重叠、包含）的框，反复进行直到稳定；用网格只比较邻近的框 */
export function mergeBoxes(boxes, dist) {
  let list = boxes.map((b) => ({ ...b }));
  for (let pass = 0; pass < 64 && list.length > 1; pass++) {
    const n = list.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i) => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };

    const cell = 64 + dist * 2;
    const grid = new Map();
    list.forEach((b, i) => {
      const cx0 = Math.floor((b.x - dist) / cell), cx1 = Math.floor((b.x + b.w + dist) / cell);
      const cy0 = Math.floor((b.y - dist) / cell), cy1 = Math.floor((b.y + b.h + dist) / cell);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = `${cx},${cy}`;
          const bucket = grid.get(key);
          if (bucket) bucket.push(i);
          else grid.set(key, [i]);
        }
      }
    });

    let unions = 0;
    for (const bucket of grid.values()) {
      for (let a = 0; a < bucket.length; a++) {
        for (let b = a + 1; b < bucket.length; b++) {
          const ra = find(bucket[a]), rb = find(bucket[b]);
          if (ra === rb || !near(list[bucket[a]], list[bucket[b]], dist)) continue;
          parent[rb] = ra;
          unions++;
        }
      }
    }
    if (!unions) break;

    const groups = new Map();
    list.forEach((b, i) => {
      const r = find(i);
      const g = groups.get(r);
      if (!g) {
        groups.set(r, { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
      } else {
        g.x0 = Math.min(g.x0, b.x);
        g.y0 = Math.min(g.y0, b.y);
        g.x1 = Math.max(g.x1, b.x + b.w);
        g.y1 = Math.max(g.y1, b.y + b.h);
      }
    });
    list = [...groups.values()].map((g) => ({ x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 }));
  }
  return list;
}

/** 阅读顺序：与某行纵向重叠达到较矮者高度一半的框归入该行，行从上到下、行内从左到右（原地排序并返回） */
export function sortReading(boxes) {
  const byTop = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const b of byTop) {
    const bottom = b.y + b.h;
    const row = rows.find((r) => {
      const overlap = Math.min(r.bottom, bottom) - Math.max(r.top, b.y);
      return overlap > 0 && overlap >= Math.min(b.h, r.bottom - r.top) / 2;
    });
    if (row) {
      row.items.push(b);
      row.top = Math.min(row.top, b.y);
      row.bottom = Math.max(row.bottom, bottom);
    } else {
      rows.push({ top: b.y, bottom, items: [b] });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  const ordered = rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
  boxes.splice(0, boxes.length, ...ordered);
  return boxes;
}

/** 把框收紧到框内前景像素的外接矩形；框内没有前景时返回 null */
export function tightBox(mask, width, box) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = box.y; y < box.y + box.h; y++) {
    const row = y * width;
    for (let x = box.x; x < box.x + box.w; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * @param {Uint8ClampedArray} data RGBA
 * @param {{ mode: 'auto'|'alpha'|'color', colors: number[][], tolerance: number, merge: number, minSize: number, pad: number }} opts
 */
export function detectSprites(data, width, height, opts) {
  const colors = opts.mode === 'auto' ? estimateBackground(data, width, height)
    : opts.mode === 'color' ? opts.colors : [];
  const mask = buildMask(data, width, height, colors, opts.tolerance);
  const components = findComponents(mask, width, height);
  if (!components) return { error: 'too-many', mask, colors };
  const merged = mergeBoxes(components, opts.merge);
  // 宽高都小于最小尺寸的视为噪点
  const kept = merged.filter((b) => b.w >= opts.minSize || b.h >= opts.minSize);
  const boxes = kept.map((b) => {
    const x = Math.max(0, b.x - opts.pad);
    const y = Math.max(0, b.y - opts.pad);
    return {
      x,
      y,
      w: Math.min(width, b.x + b.w + opts.pad) - x,
      h: Math.min(height, b.y + b.h + opts.pad) - y,
    };
  });
  sortReading(boxes);
  return { boxes, mask, colors, components: components.length, filtered: merged.length - kept.length };
}
