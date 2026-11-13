// 素材识别 Worker：在后台线程运行 detectSprites，避免大图识别时卡住页面

import { detectSprites } from '../lib/sprite-detect.js';

self.onmessage = (e) => {
  const { token, buffer, width, height, options } = e.data;
  try {
    const result = detectSprites(new Uint8ClampedArray(buffer), width, height, options);
    self.postMessage({ token, ...result }, [result.mask.buffer]);
  } catch (err) {
    self.postMessage({ token, error: err.message || String(err) });
  }
};
