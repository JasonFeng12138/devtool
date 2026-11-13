// 补帧：AI 方式用 RIFE 模型 + onnxruntime-web 在浏览器本地推理（优先 WebGPU，不支持时用 WASM），
// 像素风方式见 pixel-tween.js。AI 依赖较大（约 50MB），首次使用 AI 方式时才加载，加载后在本页面内缓存

import { detectPixelGrid, fromNative, pixelate, scaleUp, shiftTween, toNative } from './pixel-tween.js';

const ORT_DIR = new URL('../vendor/onnxruntime-web/', import.meta.url).href;
const MODEL_URL = new URL('../vendor/rife/RIFE_fp32_timestep.onnx', import.meta.url).href;

let ortPromise = null;
let modelPromise = null;

function loadOrt() {
  ortPromise ??= import(`${ORT_DIR}ort.webgpu.min.mjs`)
    .then((ort) => {
      ort.env.wasm.wasmPaths = ORT_DIR;
      // 多线程需要跨源隔离（server.js 已设置 COOP / COEP）
      ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      return ort;
    })
    .catch((err) => {
      ortPromise = null;
      throw new Error(`推理引擎加载失败：${err.message}`);
    });
  return ortPromise;
}

function loadModel() {
  modelPromise ??= fetch(MODEL_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => new Uint8Array(buf))
    .catch((err) => {
      modelPromise = null;
      throw new Error(`补帧模型加载失败：${err.message}`);
    });
  return modelPromise;
}

async function hasWebGpu() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

function sameData(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isOpaque(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/**
 * RIFE 补帧器。返回 { backend, run(a, b, w, h, times), dispose() }。
 * run 的 a、b 为同尺寸 RGBA 数据，times 为 0~1 之间的插值位置，返回对应的 RGBA 数组。
 * 带透明的帧：颜色按预乘 alpha 补帧，alpha 通道作为灰度图单独补帧，再还原为非预乘颜色。
 */
async function createRife() {
  const [ort, model] = await Promise.all([loadOrt(), loadModel()]);
  let backend = (await hasWebGpu()) ? 'webgpu' : 'wasm';
  const sessions = new Map(); // `${w}x${h}` → Promise<InferenceSession>

  async function createSession(w, h) {
    // 固定输入尺寸，WebGPU 下整个计算图才能都在 GPU 上运行
    const options = {
      graphOptimizationLevel: 'all',
      freeDimensionOverrides: { dynamic_dim_0: 1, dynamic_dim_1: 6, dynamic_dim_2: h, dynamic_dim_3: w },
    };
    if (backend === 'webgpu') {
      try {
        return await ort.InferenceSession.create(model.slice(), { ...options, executionProviders: ['webgpu', 'wasm'] });
      } catch {
        backend = 'wasm';
      }
    }
    return ort.InferenceSession.create(model.slice(), { ...options, executionProviders: ['wasm'] });
  }

  function session(w, h) {
    const key = `${w}x${h}`;
    if (!sessions.has(key)) sessions.set(key, createSession(w, h));
    return sessions.get(key);
  }

  async function infer(sess, input, w, h, t) {
    const out = await sess.run({
      input: new ort.Tensor('float32', input, [1, 6, h, w]),
      timestep: new ort.Tensor('float32', new Float32Array([t]), []),
    });
    return out.output.data;
  }

  async function run(a, b, w, h, times) {
    // 两帧完全相同（如停顿帧）时直接复制，保持时间节奏
    if (sameData(a, b)) return times.map(() => new Uint8ClampedArray(a));
    const sess = await session(w, h);
    const n = w * h;
    const withAlpha = !isOpaque(a) || !isOpaque(b);
    const color = new Float32Array(6 * n);
    const alpha = withAlpha ? new Float32Array(6 * n) : null;
    [a, b].forEach((src, f) => {
      const base = f * 3 * n;
      for (let i = 0; i < n; i++) {
        const al = src[i * 4 + 3] / 255;
        const k = al / 255;
        color[base + i] = src[i * 4] * k;
        color[base + n + i] = src[i * 4 + 1] * k;
        color[base + 2 * n + i] = src[i * 4 + 2] * k;
        if (alpha) alpha[base + i] = alpha[base + n + i] = alpha[base + 2 * n + i] = al;
      }
    });

    const results = [];
    for (const t of times) {
      const c = await infer(sess, color, w, h, t);
      const al = alpha ? await infer(sess, alpha, w, h, t) : null;
      const out = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        const A = al ? Math.min(1, Math.max(0, (al[i] + al[n + i] + al[2 * n + i]) / 3)) : 1;
        const a8 = Math.round(A * 255);
        if (!a8) continue;
        const s = 255 / A;
        out[i * 4] = c[i] * s;
        out[i * 4 + 1] = c[n + i] * s;
        out[i * 4 + 2] = c[2 * n + i] * s;
        out[i * 4 + 3] = a8;
      }
      results.push(out);
    }
    return results;
  }

  function dispose() {
    for (const p of sessions.values()) p.then((s) => s.release()).catch(() => {});
    sessions.clear();
  }

  return {
    get backend() {
      return backend;
    },
    run,
    dispose,
  };
}

const PIXEL_WORK_SIZE = 256; // 像素画送入 AI 前放大到的大致长边，太小时 RIFE 估计不准

// AI + 像素化修正：缩回原生像素 → 放大到适合 AI 的尺寸补帧 → 吸附调色板、按方块取色缩回 → 放大回原尺寸
async function pixelAi(rife, a, b, w, h, times) {
  if (sameData(a, b)) return times.map(() => new Uint8ClampedArray(a));
  const grid = detectPixelGrid([a, b], w, h);
  const na = toNative(a, w, h, grid);
  const nb = toNative(b, w, h, grid);
  const s = Math.min(8, Math.max(1, Math.round(PIXEL_WORK_SIZE / Math.max(na.w, na.h))));
  const ua = scaleUp(na, s);
  const ub = scaleUp(nb, s);
  const outs = await rife.run(ua.data, ub.data, ua.w, ua.h, times);
  return outs.map((o) => fromNative(pixelate(o, ua.w, ua.h, s, [na, nb]), grid, w, h));
}

export const INTERP_METHODS = [
  { value: 'ai-pixel', label: 'AI + 像素化修正', title: 'AI 估算动作，结果吸附回源帧的颜色并对齐像素网格，适合像素画的造型变化' },
  { value: 'shift', label: '像素位移', title: '物体按整像素从起点移向终点，前半段用前一帧造型、后半段用后一帧造型，不产生新颜色' },
  { value: 'hold', label: '帧保持', title: '不生成新画面，重复前一帧，只调整节奏' },
  { value: 'ai', label: 'AI 平滑', title: 'AI 直接生成过渡画面，适合高清、非像素风的素材' },
];

export const INTERP_METHOD_OPTIONS = INTERP_METHODS.map((m) => `<option value="${m.value}" title="${m.title}">${m.label}</option>`).join('');
export const INTERP_METHOD_KEY = 'devtool-interp-method'; // 两个工具共用上次选择的补帧方式
export const isAiMethod = (method) => method === 'ai' || method === 'ai-pixel';

/**
 * 创建补帧器，method 取 INTERP_METHODS 中的值。返回 { backend, run(a, b, w, h, times), dispose() }，
 * backend 为 'webgpu' / 'wasm'（AI 方式）或 null（不用模型的方式）。
 */
export async function createInterpolator(method) {
  if (method === 'hold') {
    return { backend: null, run: async (a, b, w, h, times) => times.map(() => new Uint8ClampedArray(a)), dispose() {} };
  }
  if (method === 'shift') {
    return { backend: null, run: async (a, b, w, h, times) => shiftTween(a, b, w, h, times), dispose() {} };
  }
  const rife = await createRife();
  if (method === 'ai') return rife;
  return {
    get backend() {
      return rife.backend;
    },
    run: (a, b, w, h, times) => pixelAi(rife, a, b, w, h, times),
    dispose: rife.dispose,
  };
}
