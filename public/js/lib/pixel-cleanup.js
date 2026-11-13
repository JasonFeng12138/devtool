// 像素规整：分析边缘周期、按网格取代表色、整理调色板。仅处理 RGBA 数据，可在 Node 中验证。

export const MAX_SOURCE_PIXELS = 16_000_000;
export const MAX_OUTPUT_PIXELS = 16_000_000;
export const MAX_SIDE = 8192;
export const MAX_LOGICAL_SIDE = 512;

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function checkpoint(hooks, done, total, title) {
  hooks.progress?.(done, total, title);
  await (hooks.yield || nextTick)();
  hooks.check?.();
}

function validate(data, w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_SOURCE_PIXELS || data.length !== w * h * 4) {
    throw new Error('图片尺寸无效或过大（最长边 8192，最多 1600 万像素）');
  }
}

function difference(d, a, b) {
  const aa = d[a + 3] / 255, ba = d[b + 3] / 255;
  return Math.abs(d[a] * aa - d[b] * ba) + Math.abs(d[a + 1] * aa - d[b + 1] * ba) + Math.abs(d[a + 2] * aa - d[b + 2] * ba) + Math.abs(d[a + 3] - d[b + 3]);
}

function peaks(projection) {
  const mean = projection.reduce((sum, n) => sum + n, 0) / projection.length;
  const found = [];
  for (let i = 1; i < projection.length - 1; i++) {
    if (projection[i] <= Math.max(1, mean * 1.4) || projection[i] < projection[i - 1] || projection[i] <= projection[i + 1]) continue;
    found.push({ x: i, weight: projection[i] });
  }
  return found.sort((a, b) => b.weight - a.weight).slice(0, 512);
}

function fitPeriod(points, period) {
  if (points.length < 3) return { score: 0, offset: 0 };
  const total = points.reduce((sum, p) => sum + p.weight, 0);
  const tolerance = Math.max(0.8, Math.min(2, period * 0.12));
  let best = { score: 0, offset: 0 };
  for (let phase = 0; phase < period; phase++) {
    let hit = 0;
    for (const p of points) {
      const rem = ((p.x - phase) % period + period) % period;
      const distance = Math.min(rem, period - rem);
      hit += p.weight * Math.max(0, 1 - distance / tolerance);
    }
    // 扣除随机边缘的期望命中率，避免把任意图片都判为细网格。
    const baseline = Math.min(0.8, tolerance / period);
    const score = Math.max(0, (hit / total - baseline) / (1 - baseline));
    if (score > best.score) best = { score, offset: phase > period / 2 ? phase - period : phase };
  }
  return best;
}

/** 自动建议统一的正方形网格；无明显周期时返回低可信度的 128 像素长边建议。 */
export async function analyzeGrid(data, w, h, hooks = {}) {
  validate(data, w, h);
  const horizontal = new Float64Array(w), vertical = new Float64Array(h);
  const ys = Math.max(1, Math.ceil(h / 128)), xs = Math.max(1, Math.ceil(w / 128));
  for (let y = 0; y < h; y += ys) {
    for (let x = 1; x < w; x++) horizontal[x] += difference(data, (y * w + x) * 4, (y * w + x - 1) * 4);
    if (Math.floor(y / ys) % 16 === 0) {
      await checkpoint(hooks, y, h * 2, '分析横向边缘');
      hooks.check?.();
    }
  }
  for (let x = 0; x < w; x += xs) {
    for (let y = 1; y < h; y++) vertical[y] += difference(data, (y * w + x) * 4, ((y - 1) * w + x) * 4);
    if (Math.floor(x / xs) % 16 === 0) {
      await checkpoint(hooks, h + x / w * h, h * 2, '分析纵向边缘');
      hooks.check?.();
    }
  }
  const px = peaks(horizontal), py = peaks(vertical);
  let best = { score: 0, k: 1, ox: 0, oy: 0 };
  const max = Math.min(128, Math.floor(Math.min(w, h) / 3));
  for (let k = 2; k <= max; k++) {
    const a = fitPeriod(px, k), b = fitPeriod(py, k);
    const score = px.length >= 3 && py.length >= 3 ? Math.min(a.score, b.score) : Math.max(a.score, b.score) * 0.65;
    // 相同得分时选择较大的周期，减少将一个美术像素拆成多个小格。
    if (score > best.score + 0.015 || (score >= best.score - 0.015 && score > 0.5 && k > best.k)) best = { score, k, ox: a.offset, oy: b.offset };
    if (k % 8 === 0) {
      await checkpoint(hooks, k, max, '匹配像素网格');
      hooks.check?.();
    }
  }
  const reliable = best.score >= 0.55 && w / best.k <= MAX_LOGICAL_SIDE && h / best.k <= MAX_LOGICAL_SIDE;
  const step = reliable ? best.k : Math.max(1, Math.max(w, h) / 128);
  const cols = Math.min(MAX_LOGICAL_SIDE, w, Math.max(1, Math.round(w / step)));
  const rows = Math.min(MAX_LOGICAL_SIDE, h, Math.max(1, Math.round(h / step)));
  const fx = reliable ? fitPeriod(px, w / cols) : { offset: 0 };
  const fy = reliable ? fitPeriod(py, h / rows) : { offset: 0 };
  return { cols, rows, offsetX: Math.round(fx.offset), offsetY: Math.round(fy.offset), confidence: best.score, reliable };
}

/** 首尾格覆盖到原图边缘，偏移只移动内部网格线，不丢弃画布边缘。 */
export function gridBoundary(index, count, size, offset = 0) {
  if (index === 0) return 0;
  if (index === count) return size;
  return Math.max(0, Math.min(size, Math.round(index * size / count + offset)));
}

/** 顺序处理图片，单张失败继续后续图片；取消检查抛出时立即结束队列。 */
export async function processPixelBatch(items, process, hooks = {}) {
  let completed = 0, failed = 0;
  for (let i = 0; i < items.length; i++) {
    hooks.check?.();
    hooks.onStart?.(items[i], i, items.length);
    try {
      const result = await process(items[i], i);
      hooks.check?.();
      hooks.onResult?.(items[i], result);
      completed++;
    } catch (err) {
      hooks.check?.();
      if (err.name === 'AbortError') throw err;
      hooks.onError?.(items[i], err);
      failed++;
    }
    await (hooks.yield || nextTick)();
    hooks.check?.();
  }
  return { completed, failed };
}

function colorKey(r, g, b) { return (r << 16) | (g << 8) | b; }

// 格子中心 70% 区域内做粗颜色投票，输出来自原图的一个实际样本，避免平均出灰边。
function cellColor(data, w, x0, y0, x1, y1, hardAlpha) {
  const counts = new Map();
  const sx = x0 + (x1 - x0) * 0.15, sy = y0 + (y1 - y0) * 0.15;
  const sw = Math.max(1, (x1 - x0) * 0.7), sh = Math.max(1, (y1 - y0) * 0.7);
  const nx = Math.min(9, x1 - x0), ny = Math.min(9, y1 - y0);
  let best = null;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const xx = Math.min(x1 - 1, Math.floor(sx + (x + 0.5) * sw / nx));
      const yy = Math.min(y1 - 1, Math.floor(sy + (y + 0.5) * sh / ny));
      const i = (yy * w + xx) * 4;
      const a = data[i + 3];
      const alpha = hardAlpha ? (a >= 128 ? 255 : 0) : a;
      const key = !alpha ? -1 : ((data[i] >> 4) << 12) | ((data[i + 1] >> 4) << 8) | ((data[i + 2] >> 4) << 4) | (alpha >> 4);
      let group = counts.get(key);
      if (!group) {
        group = { n: 0, i, alpha, distance: Infinity };
        counts.set(key, group);
      }
      group.n++;
      const distance = (xx - (x0 + x1 - 1) / 2) ** 2 + (yy - (y0 + y1 - 1) / 2) ** 2;
      if (distance < group.distance) Object.assign(group, { i, alpha, distance });
      if (!best || group.n > best.n || (group.n === best.n && group.distance < best.distance)) best = group;
    }
  }
  if (!best?.alpha) return [0, 0, 0, 0];
  return [data[best.i], data[best.i + 1], data[best.i + 2], best.alpha];
}

function colorDistance(a, b) {
  return 2 * (a[0] - b[0]) ** 2 + 3 * (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

async function makePalette(data, limit, hooks) {
  // 每个粗颜色桶保留实际样本和累计权重；限制聚类输入，避免噪点色撑满内存。
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const c = [data[i], data[i + 1], data[i + 2]];
    const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    const bin = bins.get(key);
    if (bin) bin.weight += data[i + 3] / 255;
    else bins.set(key, { color: c, weight: data[i + 3] / 255 });
  }
  const points = [...bins.values()].sort((a, b) => b.weight - a.weight);
  if (points.length <= limit) return points.map((p) => p.color);
  const boxes = [points];
  while (boxes.length < limit) {
    let chosen = -1, axis = 0, score = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const min = [255, 255, 255], max = [0, 0, 0];
      let weight = 0;
      for (const p of box) {
        weight += p.weight;
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p.color[a]); max[a] = Math.max(max[a], p.color[a]); }
      }
      for (let a = 0; a < 3; a++) {
        const value = (max[a] - min[a]) ** 2 * Math.sqrt(weight) * [2, 3, 1][a];
        if (value > score) { chosen = i; axis = a; score = value; }
      }
    }
    if (chosen < 0) break;
    const box = boxes[chosen].sort((a, b) => a.color[axis] - b.color[axis]);
    const half = box.reduce((sum, p) => sum + p.weight, 0) / 2;
    let sum = 0, cut = 1;
    for (; cut < box.length; cut++) { sum += box[cut - 1].weight; if (sum >= half) break; }
    cut = Math.min(box.length - 1, cut);
    boxes.splice(chosen, 1, box.slice(0, cut), box.slice(cut));
    if (boxes.length % 8 === 0) {
      await checkpoint(hooks, boxes.length, limit, '提取调色板');
      hooks.check?.();
    }
  }
  return boxes.map((box) => {
    const sum = [0, 0, 0];
    let weight = 0;
    for (const p of box) { weight += p.weight; for (let a = 0; a < 3; a++) sum[a] += p.color[a] * p.weight; }
    const center = sum.map((v) => v / weight);
    return box.reduce((best, p) => colorDistance(p.color, center) < colorDistance(best.color, center) ? p : best).color;
  });
}

/** 每个格子重建为一个像素；返回逻辑尺寸 RGBA，输出放大由导出画布完成。 */
export async function cleanupPixels(data, w, h, options, hooks = {}) {
  validate(data, w, h);
  const { cols, rows, offsetX = 0, offsetY = 0, colors = 32, hardAlpha = false, removeNoise = false } = options;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > Math.min(w, MAX_LOGICAL_SIDE) || rows > Math.min(h, MAX_LOGICAL_SIDE)) throw new Error('逻辑宽高须为 1～512 之间且不大于原图的整数');
  if (![0, 16, 32, 64, 128].includes(colors)) throw new Error('不支持的调色板大小');
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || Math.abs(offsetX) > (w / cols - 1) / 2 || Math.abs(offsetY) > (h / rows - 1) / 2) throw new Error('网格偏移超出范围');
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 0; y < rows; y++) {
    const y0 = gridBoundary(y, rows, h, offsetY), y1 = gridBoundary(y + 1, rows, h, offsetY);
    for (let x = 0; x < cols; x++) {
      const x0 = gridBoundary(x, cols, w, offsetX), x1 = gridBoundary(x + 1, cols, w, offsetX);
      out.set(cellColor(data, w, x0, y0, x1, y1, hardAlpha), (y * cols + x) * 4);
    }
    if (y % 8 === 0) {
      await checkpoint(hooks, y, rows, '重建像素');
      hooks.check?.();
    }
  }
  if (colors) {
    const palette = await makePalette(out, colors, hooks);
    hooks.check?.();
    const cache = new Map();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        if (!out[i + 3]) continue;
        const key = colorKey(out[i], out[i + 1], out[i + 2]);
        let c = cache.get(key);
        if (!c) {
          const source = [out[i], out[i + 1], out[i + 2]];
          c = palette.reduce((best, p) => colorDistance(p, source) < colorDistance(best, source) ? p : best);
          cache.set(key, c);
        }
        out.set(c, i);
      }
      if (y % 16 === 0) {
        await checkpoint(hooks, y, rows, '归并相近颜色');
        hooks.check?.();
      }
    }
  }
  if (removeNoise) {
    const before = out.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        if (!before[i + 3]) continue;
        let neighbor = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= cols || y + dy < 0 || y + dy >= rows) continue;
          if (before[((y + dy) * cols + x + dx) * 4 + 3]) neighbor = true;
        }
        if (!neighbor) out.fill(0, i, i + 4);
      }
      if (y % 32 === 0) {
        await checkpoint(hooks, y, rows, '清理孤立像素');
        hooks.check?.();
      }
    }
  }
  const palette = new Set();
  for (let i = 0; i < out.length; i += 4) if (out[i + 3]) palette.add(colorKey(out[i], out[i + 1], out[i + 2]));
  return { data: out, width: cols, height: rows, colorCount: palette.size };
}
