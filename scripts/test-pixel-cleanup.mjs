// 纯数据回归检查：无需浏览器，覆盖网格识别、透明度、颜色整理与任务取消。
import assert from 'node:assert/strict';
import { analyzeGrid, cleanupPixels, gridBoundary, processPixelBatch } from '../public/js/lib/pixel-cleanup.js';
import { writeFiles } from '../public/js/lib/save.js';

const hooks = { yield: async () => {} };
const palette = [[220, 40, 50, 255], [30, 170, 80, 255], [40, 70, 210, 255], [230, 210, 40, 255], [50, 20, 80, 255]];
function fixture(k, ox = 0, oy = 0) {
  const cols = 24, rows = 20, width = cols * k, height = rows * k;
  const data = new Uint8ClampedArray(width * height * 4);
  const native = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) native.set(palette[(x * 7 + y * 13) % palette.length], (y * cols + x) * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cx = Math.max(0, Math.min(cols - 1, Math.floor((x - ox) / k)));
    const cy = Math.max(0, Math.min(rows - 1, Math.floor((y - oy) / k)));
    data.set(native.subarray((cy * cols + cx) * 4, (cy * cols + cx) * 4 + 4), (y * width + x) * 4);
  }
  return { data, native, width, height, cols, rows };
}

function blur(data, width, height) {
  const result = data.slice();
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) result[i + c] = Math.round((data[i + c] * 4 + data[i - 4 + c] + data[i + 4 + c] + data[i - width * 4 + c] + data[i + width * 4 + c]) / 8);
  }
  return result;
}

for (const k of [2, 3, 4, 8, 12, 16]) {
  const f = fixture(k);
  const grid = await analyzeGrid(f.data, f.width, f.height, hooks);
  assert.equal(grid.reliable, true);
  assert.equal(grid.cols, f.cols);
  assert.equal(grid.rows, f.rows);
  const result = await cleanupPixels(f.data, f.width, f.height, { cols: f.cols, rows: f.rows, colors: 0 }, hooks);
  assert.deepEqual(result.data, f.native);
}
console.log('OK 2 / 3 / 4 / 8 / 12 / 16 倍网格识别与无损重建');

const shifted = fixture(8, 2, -2);
const shiftedGrid = await analyzeGrid(shifted.data, shifted.width, shifted.height, hooks);
assert.equal(shiftedGrid.cols, shifted.cols);
assert.equal(shiftedGrid.rows, shifted.rows);
assert.equal(shiftedGrid.offsetX, 2);
assert.equal(shiftedGrid.offsetY, -2);
const aligned = await cleanupPixels(shifted.data, shifted.width, shifted.height, { cols: shifted.cols, rows: shifted.rows, offsetX: 2, offsetY: -2, colors: 0 }, hooks);
assert.deepEqual(aligned.data, shifted.native);
assert.equal(gridBoundary(0, 24, 192, 2), 0);
assert.equal(gridBoundary(24, 24, 192, 2), 192);
console.log('OK 网格偏移与边缘保留');

const f = fixture(8);
const blurred = blur(f.data, f.width, f.height);
const blurredGrid = await analyzeGrid(blurred, f.width, f.height, hooks);
assert.equal(blurredGrid.reliable, true);
assert.equal(blurredGrid.cols, f.cols);
const recovered = await cleanupPixels(blurred, f.width, f.height, { cols: f.cols, rows: f.rows, colors: 0 }, hooks);
assert.deepEqual(recovered.data, f.native);
console.log('OK 模糊边缘网格识别与主体颜色恢复');

const flat = new Uint8ClampedArray(96 * 64 * 4).fill(255);
assert.equal((await analyzeGrid(flat, 96, 64, hooks)).reliable, false);
let seed = 23;
const noise = new Uint8ClampedArray(128 * 128 * 4);
for (let i = 0; i < noise.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise[i] = i % 4 === 3 ? 255 : seed >>> 24; }
assert.equal((await analyzeGrid(noise, 128, 128, hooks)).reliable, false);
console.log('OK 纯色与随机噪声不误报稳定网格');

const rgba = new Uint8ClampedArray([255, 0, 0, 0, 180, 30, 50, 127, 20, 40, 200, 128, 60, 70, 80, 255]);
const preserved = await cleanupPixels(rgba, 4, 1, { cols: 4, rows: 1, colors: 0 }, hooks);
assert.deepEqual([...preserved.data], [0, 0, 0, 0, ...rgba.slice(4)]);
const hard = await cleanupPixels(rgba, 4, 1, { cols: 4, rows: 1, colors: 16, hardAlpha: true }, hooks);
assert.deepEqual([hard.data[3], hard.data[7], hard.data[11], hard.data[15]], [0, 0, 255, 255]);
const transparent = await cleanupPixels(new Uint8ClampedArray(64), 4, 4, { cols: 4, rows: 4, colors: 32 }, hooks);
assert.equal(transparent.colorCount, 0);
console.log('OK 透明底、半透明保留与硬边透明阈值');

for (const colors of [16, 32, 64, 128]) {
  const result = await cleanupPixels(noise, 128, 128, { cols: 128, rows: 128, colors }, hooks);
  assert.ok(result.colorCount <= colors);
  const originalColors = new Set();
  for (let i = 0; i < noise.length; i += 4) originalColors.add(`${noise[i]},${noise[i + 1]},${noise[i + 2]}`);
  for (let i = 0; i < result.data.length; i += 4) assert.ok(originalColors.has(`${result.data[i]},${result.data[i + 1]},${result.data[i + 2]}`));
}
console.log('OK 调色板数量上限与原有颜色保留');

const dot = new Uint8ClampedArray(5 * 5 * 4);
dot.set([250, 250, 200, 255], (2 * 5 + 2) * 4);
assert.equal((await cleanupPixels(dot, 5, 5, { cols: 5, rows: 5, colors: 0 }, hooks)).data[(2 * 5 + 2) * 4 + 3], 255);
assert.equal((await cleanupPixels(dot, 5, 5, { cols: 5, rows: 5, colors: 0, removeNoise: true }, hooks)).colorCount, 0);
console.log('OK 默认保留孤立细节、可选删除孤立点');

await assert.rejects(cleanupPixels(f.data, f.width, f.height, { cols: 0, rows: 20 }, hooks));
await assert.rejects(cleanupPixels(f.data, f.width, f.height, { cols: 24, rows: 20, offsetX: 99 }, hooks));
let cancelled = false, yields = 0;
await assert.rejects(cleanupPixels(f.data, f.width, f.height, { cols: 24, rows: 20 }, {
  yield: async () => { yields++; cancelled = true; },
  check: () => { if (cancelled) throw new Error('测试取消'); },
}), /测试取消/);
assert.equal(yields, 1);
console.log('OK 非法参数拒绝与异步任务及时取消');

const file = { name: 'pixel.png', blob: new Blob(['png']) };
for (const cancelAt of ['handle', 'stream', 'write']) {
  let cancelled = false, committed = false, aborted = false;
  const stream = { write: async () => { if (cancelAt === 'write') cancelled = true; }, close: async () => { committed = true; }, abort: async () => { aborted = true; } };
  const dir = { getFileHandle: async () => { if (cancelAt === 'handle') cancelled = true; return { createWritable: async () => { if (cancelAt === 'stream') cancelled = true; return stream; } }; } };
  await assert.rejects(writeFiles([file], { dir, task: {}, check: () => { if (cancelled) throw new Error('保存取消'); } }), /保存取消/);
  assert.equal(committed, false);
  assert.equal(aborted, cancelAt !== 'handle');
}
let zipCancelled = false;
await assert.rejects(writeFiles([{ name: 'cancel.png', blob: { arrayBuffer: async () => { zipCancelled = true; return new ArrayBuffer(0); } } }], { task: { update() {} }, check: () => { if (zipCancelled) throw new Error('打包取消'); } }), /打包取消/);
console.log('OK 文件夹写入中止与 ZIP 下载前取消');

const batch = [fixture(4), fixture(8), fixture(12)];
const order = [], results = [];
let active = 0, maxActive = 0;
const batchSummary = await processPixelBatch(batch, async (item, i) => {
  active++; maxActive = Math.max(maxActive, active); order.push(i);
  const grid = await analyzeGrid(item.data, item.width, item.height, hooks);
  const result = await cleanupPixels(item.data, item.width, item.height, { ...grid, colors: 0 }, hooks);
  active--;
  return result;
}, { ...hooks, onResult: (item, result) => { assert.deepEqual(result.data, item.native); results.push(result); } });
assert.deepEqual(batchSummary, { completed: 3, failed: 0 });
assert.deepEqual(order, [0, 1, 2]);
assert.equal(maxActive, 1);
assert.equal(new Set(results.map((result) => result.data.buffer)).size, 3);
console.log('OK 批量混合尺寸逐张识别、顺序处理与结果独立缓存');

const sharedOptions = { cols: 12, rows: 10, offsetX: 1, offsetY: -1, colors: 16, hardAlpha: true, removeNoise: false };
const unifiedResults = [];
const unifiedSummary = await processPixelBatch([fixture(4), fixture(8)], async (item) => cleanupPixels(item.data, item.width, item.height, { ...sharedOptions }, hooks), {
  ...hooks,
  onResult: (item, result) => unifiedResults.push(result),
});
assert.deepEqual(unifiedSummary, { completed: 2, failed: 0 });
for (const result of unifiedResults) {
  assert.equal(result.width, sharedOptions.cols);
  assert.equal(result.height, sharedOptions.rows);
  assert.ok(result.colorCount <= sharedOptions.colors);
  for (let i = 3; i < result.data.length; i += 4) assert.ok(result.data[i] === 0 || result.data[i] === 255);
}
console.log('OK 不同原图使用统一逻辑尺寸、偏移、颜色与透明设定');

const failedItems = [], successItems = [];
const failureSummary = await processPixelBatch([1, 2, 3], async (item) => {
  if (item === 2) throw new Error('测试损坏图片');
  return item * 10;
}, { ...hooks, onResult: (item, result) => successItems.push([item, result]), onError: (item, err) => failedItems.push([item, err.message]) });
assert.deepEqual(failureSummary, { completed: 2, failed: 1 });
assert.deepEqual(successItems, [[1, 10], [3, 30]]);
assert.deepEqual(failedItems, [[2, '测试损坏图片']]);
console.log('OK 单张处理失败后继续剩余图片');

let batchCancelled = false;
const startedItems = [], committedItems = [];
await assert.rejects(processPixelBatch([1, 2, 3], async (item) => {
  if (item === 2) batchCancelled = true;
  return item;
}, {
  ...hooks,
  check: () => { if (batchCancelled) throw new DOMException('批量已取消', 'AbortError'); },
  onStart: (item) => startedItems.push(item),
  onResult: (item) => committedItems.push(item),
}), { name: 'AbortError' });
assert.deepEqual(startedItems, [1, 2]);
assert.deepEqual(committedItems, [1]);
let preCancelledStarted = false;
await assert.rejects(processPixelBatch([1], async () => { preCancelledStarted = true; }, {
  check: () => { throw new DOMException('批量已取消', 'AbortError'); },
}), { name: 'AbortError' });
assert.equal(preCancelledStarted, false);
assert.deepEqual(await processPixelBatch([], async () => {}, hooks), { completed: 0, failed: 0 });
console.log('OK 批量取消丢弃过期结果、停止后续图片并保留已完成结果');
