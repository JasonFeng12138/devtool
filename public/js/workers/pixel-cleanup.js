// 每项任务使用独立 Worker；替换参数或切换工具时由页面 terminate，及时停止旧任务。
import { analyzeGrid, cleanupPixels } from '../lib/pixel-cleanup.js';

let activeToken = 0;
self.onmessage = async ({ data: request }) => {
  const { token, kind, buffer, width, height, options } = request;
  activeToken = token;
  try {
    const hooks = { check: () => { if (token !== activeToken) throw new Error('任务已取消'); }, progress: (done, total, title) => self.postMessage({ token, progress: { done, total, title } }) };
    const data = new Uint8ClampedArray(buffer);
    const result = kind === 'analyze'
      ? await analyzeGrid(data, width, height, hooks)
      : await cleanupPixels(data, width, height, options, hooks);
    if (token !== activeToken) return;
    self.postMessage({ token, result }, result.data ? [result.data.buffer] : []);
  } catch (err) {
    if (token !== activeToken) return;
    self.postMessage({ token, error: err.message || String(err) });
  }
};
