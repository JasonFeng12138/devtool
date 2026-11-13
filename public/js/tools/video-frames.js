import { GifEncoder } from '../lib/gif.js';
import { createGifRenderer, gifFrameAt, parseGif } from '../lib/gif-decode.js';
import { INTERP_METHOD_KEY, INTERP_METHOD_OPTIONS, createInterpolator, isAiMethod } from '../lib/interpolate.js';
import { createZoomView } from '../lib/zoom.js';
import { hexToRgb, removeBackground, rgbToHex } from '../lib/color-key.js';
import { pickFolder, writeFiles } from '../lib/save.js';
import { ICON_UPLOAD, collectRefs, downloadBlob, formatBytes, startProgress, toast } from '../lib/ui.js';

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;
const GIF_EXT = /\.gif$/i;
const MAX_FRAMES_WITHOUT_CONFIRM = 600;
const MAX_DIMENSION = 8192;
const THUMB_MAX = 240;
const ANIM_MAX_W = 640;
const ANIM_MAX_H = 480;
const GIF_MAX_FPS = 50; // GIF 帧间隔最小 2/100 秒
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
const ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>';

const TEMPLATE = `
<section class="panel">
  <div class="panel-header">
    <h2 class="section-title">1. 导入与抽帧</h2>
  </div>
  <div class="tool-split">
    <div class="stage scroll-area" data-ref="stage">
      <label class="dropzone" data-ref="dropzone">
        <input type="file" accept="video/*,image/gif" aria-label="选择视频或 GIF" data-ref="file">
        ${ICON_UPLOAD}
        <span class="dropzone-title">选择视频或 GIF</span>
        <span class="dropzone-hint">拖拽文件到这里 · MP4 / WebM / MOV / GIF</span>
      </label>
      <video class="vf-video" data-ref="video" controls muted playsinline preload="auto" hidden></video>
      <img class="vf-video checker" data-ref="gifImg" alt="" hidden>
    </div>

    <div class="controls">
      <div class="dims" data-ref="meta" hidden>
        <div class="dim"><span class="dim-label">分辨率</span><span class="dim-value"><b data-ref="vRes">-</b></span></div>
        <div class="dim"><span class="dim-label">时长</span><span class="dim-value"><b data-ref="vDur">-</b> 秒</span></div>
        <div class="dim"><span class="dim-label">原始帧率</span><span class="dim-value"><b data-ref="vFps">-</b> fps</span></div>
        <div class="file-meta" data-ref="fileMeta"></div>
      </div>

      <div class="control-group">
        <div class="field-row">
          <label class="field">开始时间 (秒)<input type="number" min="0" step="0.01" data-ref="start"></label>
          <label class="field">结束时间 (秒)<input type="number" min="0" step="0.01" data-ref="end"></label>
        </div>
        <label class="check" data-ref="allFramesRow" hidden><input type="checkbox" data-ref="allFrames" checked>抽取每一个原始帧</label>
        <label class="field">抽帧帧率 (fps)<input type="number" min="0.1" max="240" step="any" data-ref="fps"></label>
      </div>
      <div class="control-group">
        <div class="field-row">
          <label class="field">输出宽度 (px)<input type="number" min="1" max="${MAX_DIMENSION}" step="1" data-ref="outW"></label>
          <label class="field">输出高度 (px)<input type="number" min="1" max="${MAX_DIMENSION}" step="1" data-ref="outH"></label>
        </div>
        <div class="vf-size-tools">
          <label class="check"><input type="checkbox" data-ref="lockRatio" checked>锁定宽高比</label>
          <div class="segmented" role="group" aria-label="快捷尺寸">
            <button type="button" class="segmented-item" data-size="1">原始</button>
            <button type="button" class="segmented-item" data-size="0.5">50%</button>
            <button type="button" class="segmented-item" data-size="0.25">25%</button>
          </div>
        </div>
      </div>

      <div class="plan" data-ref="plan" hidden></div>

      <div class="actions actions-stack">
        <button class="btn btn-primary" data-ref="extract" disabled>开始抽帧</button>
        <button class="btn" data-ref="change" disabled>更换文件</button>
      </div>
    </div>
  </div>
</section>

<section class="panel" data-ref="bgPanel" hidden>
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">2. 去除背景</h2>
      <span class="badge" data-ref="bgStatus"></span>
    </div>
    <div class="segmented" role="group" aria-label="预览内容">
      <button class="segmented-item" data-ref="viewResult" aria-pressed="true">去背景效果</button>
      <button class="segmented-item" data-ref="viewOriginal" aria-pressed="false">原图</button>
    </div>
  </div>
  <div class="tool-split">
    <div class="stage zoom-stage" data-ref="bgStage" title="滚轮缩放，拖拽平移；放大后可查看单个像素">
      <canvas class="stage-canvas checker" data-ref="bgCanvas"></canvas>
    </div>

    <div class="controls">
      <div class="control-group">
        <label class="check"><input type="checkbox" data-ref="bgEnabled" checked>启用去除背景</label>

        <div class="field">
          <span>背景颜色</span>
          <div class="color-list" data-ref="colors"></div>
          <div class="picker-row">
            <button class="btn" data-ref="picker" title="点击画布添加背景色；Shift 连续取色，Esc 取消">吸管取色</button>
            <input type="color" class="color-input" data-ref="manualColor" value="#00ff00" title="手动选择颜色并添加">
          </div>
          <span class="pick-hover" data-ref="hover" hidden><i class="swatch" data-ref="hoverSwatch"></i><code data-ref="hoverHex"></code><span class="pick-hover-pos" data-ref="hoverPos"></span></span>
        </div>
      </div>

      <div class="control-group">
        <label class="field">
          <span class="field-label">容差<output data-ref="tolOut">15</output></span>
          <input type="range" min="0" max="100" step="1" value="15" data-ref="tolerance">
        </label>
        <label class="field" title="羽化让背景边缘平滑过渡">
          <span class="field-label">边缘羽化<output data-ref="featherOut">5</output></span>
          <input type="range" min="0" max="50" step="1" value="5" data-ref="feather">
        </label>
        <label class="field">
          <span class="field-label">预览帧<output data-ref="refOut"></output></span>
          <input type="range" min="0" max="0" step="1" value="0" data-ref="refFrame">
        </label>
      </div>

      <div class="actions actions-stack">
        <button class="btn btn-primary" data-ref="apply" disabled>应用到全部帧</button>
      </div>
    </div>
  </div>
</section>

<section class="panel" data-ref="framesPanel" hidden>
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">3. 选择帧</h2>
      <span class="badge" data-ref="count"></span>
    </div>
    <div class="actions">
      <div class="segmented" role="group" aria-label="选择">
        <button class="segmented-item" data-ref="selAll">全选</button>
        <button class="segmented-item" data-ref="selNone">全不选</button>
        <button class="segmented-item" data-ref="selInvert">反选</button>
      </div>
      <button class="btn" data-ref="zip">打包 ZIP 下载</button>
      <button class="btn btn-primary" data-ref="save">保存选中到本地</button>
    </div>
  </div>
  <div class="interp-bar">
    <label class="inline-field">补帧方式
      <select data-ref="interpMethod">${INTERP_METHOD_OPTIONS}</select>
    </label>
    <label class="inline-field" title="在每两张相邻的选中帧之间插入的帧数">插帧数
      <select data-ref="interpCount">
        <option value="1">1 帧 · 2 倍</option>
        <option value="2">2 帧 · 3 倍</option>
        <option value="3">3 帧 · 4 倍</option>
      </select>
    </label>
    <label class="check" title="循环动画在最后一帧和第一帧之间也补帧"><input type="checkbox" data-ref="interpLoop">首尾衔接</label>
    <button class="btn" data-ref="interp" disabled>补帧</button>
    <button class="btn" data-ref="interpClear" disabled>移除补帧</button>
  </div>
  <div class="tiles tiles-scroll scroll-area" data-ref="tiles" title="点击勾选，Shift 点击选择区间；悬停可预览或下载"></div>
</section>

<dialog class="lightbox glass" data-ref="lightbox" aria-label="帧预览">
  <div class="lightbox-header">
    <div class="panel-heading">
      <h3 class="section-title" data-ref="lbTitle"></h3>
      <span class="badge" data-ref="lbMeta"></span>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-ref="lbSelect"></button>
      <button type="button" class="btn" data-ref="lbDownload">下载此帧</button>
      <button type="button" class="btn" data-ref="lbClose">关闭</button>
    </div>
  </div>
  <div class="lightbox-body">
    <div class="stage lightbox-stage" data-ref="lbStage" title="滚轮缩放，拖拽平移；← → 切换帧，空格勾选，Esc 关闭">
      <img class="checker" alt="" data-ref="lbImg">
    </div>
    <button type="button" class="lightbox-nav lightbox-prev" data-ref="lbPrev" aria-label="上一帧">‹</button>
    <button type="button" class="lightbox-nav lightbox-next" data-ref="lbNext" aria-label="下一帧">›</button>
  </div>
</dialog>

<section class="panel" data-ref="animPanel" hidden>
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">4. 动画预览与导出 GIF</h2>
      <span class="badge" data-ref="animOut"></span>
    </div>
  </div>
  <div class="tool-split">
    <div class="stage scroll-area">
      <canvas class="stage-canvas checker" data-ref="animCanvas"></canvas>
      <span class="stage-empty" data-ref="animEmpty" hidden>请在上方至少选择一帧</span>
    </div>

    <div class="controls">
      <div class="control-group">
        <label class="field" title="最高 ${GIF_MAX_FPS} fps">动画帧率 (fps)<input type="number" min="1" max="${GIF_MAX_FPS}" step="any" data-ref="animFps"></label>
        <div class="segmented vf-player" role="group" aria-label="播放控制">
          <button class="segmented-item" data-ref="prev" title="上一帧">上一帧</button>
          <button class="segmented-item" data-ref="play" aria-pressed="true">暂停</button>
          <button class="segmented-item" data-ref="next" title="下一帧">下一帧</button>
        </div>
      </div>

      <div class="control-group">
        <div class="field-row">
          <label class="field">GIF 宽度 (px)<input type="number" min="1" max="4096" step="1" data-ref="gifW"></label>
          <label class="field">循环
            <select data-ref="gifLoop">
              <option value="0">无限循环</option>
              <option value="-1">播放一次</option>
            </select>
          </label>
        </div>
        <div class="field-row">
          <label class="field" title="GIF 仅支持全透明或不透明像素，边缘羽化建议配合纯色填充">GIF 背景
            <select data-ref="gifBg">
              <option value="transparent">透明</option>
              <option value="color">纯色填充</option>
            </select>
          </label>
          <label class="field">填充颜色<input type="color" value="#ffffff" data-ref="gifMatte" disabled></label>
        </div>
      </div>

      <div class="plan" data-ref="gifPlan"></div>

      <div class="actions actions-stack">
        <button class="btn btn-primary" data-ref="gif" disabled>导出 GIF</button>
      </div>
    </div>
  </div>
</section>
`;

// ---------- 工具函数 ----------
function baseName(filename) {
  const name = filename.replace(/\.[^.]+$/, '') || 'video';
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, mime = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), mime, quality);
  });
}

function readNumber(input) {
  return input.value.trim() === '' ? NaN : Number(input.value);
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitEvent(el, type, timeout) {
  return new Promise((resolve, reject) => {
    const onOk = () => done();
    const onError = () => done(new Error('视频解码失败'));
    const timer = setTimeout(() => done(new Error('等待视频响应超时')), timeout);
    function done(err) {
      clearTimeout(timer);
      el.removeEventListener(type, onOk);
      el.removeEventListener('error', onError);
      if (err) reject(err);
      else resolve();
    }
    el.addEventListener(type, onOk);
    el.addEventListener('error', onError);
  });
}

function seek(video, time) {
  const done = waitEvent(video, 'seeked', 10000);
  video.currentTime = time;
  return done;
}

// MediaRecorder 录制的 WebM 时长常为 Infinity，跳到末尾可让浏览器算出真实时长
async function resolveDuration(video) {
  if (Number.isFinite(video.duration)) return video.duration;
  const changed = waitEvent(video, 'durationchange', 5000).catch(() => {});
  video.currentTime = 1e101;
  await changed;
  const duration = video.duration;
  await seek(video, 0).catch(() => {});
  return Number.isFinite(duration) ? duration : NaN;
}

function snapFps(fps) {
  const common = COMMON_FPS.find((c) => Math.abs(c - fps) / c < 0.015);
  return common ?? Math.round(fps * 100) / 100;
}

// 播放几帧，用相邻帧的媒体时间差估算帧率（取最小间隔以排除掉帧影响）
async function detectFps(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const times = [];
  try {
    await video.play();
  } catch {
    return null;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 16) {
        clearTimeout(timer);
        resolve();
      } else {
        video.requestVideoFrameCallback(onFrame);
      }
    };
    video.requestVideoFrameCallback(onFrame);
  });
  video.pause();
  const diffs = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 1 / 241) diffs.push(d);
  }
  if (diffs.length < 3) return null;
  return snapFps(1 / Math.min(...diffs));
}

function makeThumb(source, w, h) {
  const s = Math.min(1, THUMB_MAX / Math.max(w, h));
  const c = createCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/webp', 0.85);
}

function decodeScaled(blob, w, h) {
  return createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    .catch(() => createImageBitmap(blob));
}

export default {
  id: 'video-frames',
  name: '视频抽帧',
  description: '抽取画面、去除背景并导出动画',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/></svg>',

  mount(root) {
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);
    const animCtx = $.animCanvas.getContext('2d');
    const bgZoom = createZoomView($.bgStage, $.bgCanvas);
    const lbZoom = createZoomView($.lbStage, $.lbImg);

    const state = {
      video: null, // { name, size, width, height, duration, fps }
      videoUrl: null,
      gif: null, // GIF 源：parseGif 的结果 + renderer
      loadToken: 0,
      detecting: false,
      frames: [], // { index, time, name, blob, origThumbUrl, procBlob, procThumbUrl, appliedKey, version, selected, generated, card, check, img, posEl, anim }
      frameW: 0,
      frameH: 0,
      extracting: false,
      stopRequested: false,
      extractToken: 0,
      colors: [], // '#rrggbb'
      view: 'result',
      picking: false,
      ref: null, // { index, frame, original: ImageData }
      refToken: 0,
      renderQueued: false,
      bgToken: 0,
      applyPromise: null,
      applyProgress: '',
      lastClicked: -1,
      busy: false,
      interp: { running: false, stop: false, token: 0 },
      progressTask: null, // 保存 / 导出 GIF 时的进度卡片任务，去背景进度也会写入
      anim: { list: [], playing: true, start: 0, index: 0, raf: 0, drawn: null, w: 0, h: 0 },
      lightbox: { index: -1, url: null, token: 0, needsFit: false },
    };

    // ---------- 加载视频 / GIF ----------
    function resetSource() {
      $.video.pause();
      $.video.removeAttribute('src');
      $.video.load();
      $.video.hidden = true;
      $.gifImg.removeAttribute('src');
      $.gifImg.hidden = true;
      if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
      state.videoUrl = null;
      state.video = null;
      state.gif = null;
    }

    function showMeta(info) {
      state.video = info;
      $.vRes.textContent = `${info.width}×${info.height}`;
      $.vDur.textContent = info.duration.toFixed(2);
      $.fileMeta.textContent = `${info.name} · ${formatBytes(info.size)}`;
      $.meta.hidden = false;
      $.start.value = 0;
      $.end.value = Number(info.duration.toFixed(3));
      setOutputSize(1);
    }

    async function loadFile(file) {
      if (!file) return;
      const isGif = file.type === 'image/gif' || GIF_EXT.test(file.name);
      if (!isGif && !file.type.startsWith('video/') && !VIDEO_EXT.test(file.name)) {
        toast('请选择视频或 GIF 文件');
        return;
      }
      cancelExtraction();
      clearFrames();
      const token = ++state.loadToken;
      resetSource();
      const url = URL.createObjectURL(file);
      state.videoUrl = url;
      state.detecting = true;
      $.dropzone.hidden = true;
      $.meta.hidden = true;
      $.allFramesRow.hidden = !isGif;
      $.change.disabled = true;
      updatePlan();

      try {
        if (isGif) await loadGif(file, url, token);
        else await loadVideo(file, url, token);
      } catch (err) {
        if (token !== state.loadToken) return;
        resetSource();
        $.dropzone.hidden = false;
        $.meta.hidden = true;
        $.allFramesRow.hidden = true;
        toast(`${isGif ? 'GIF' : '视频'}加载失败：${err.message}`);
      } finally {
        if (token === state.loadToken) {
          state.detecting = false;
          $.change.disabled = false;
          updatePlan();
        }
      }
    }

    async function loadGif(file, url, token) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (token !== state.loadToken) return;
      const gif = parseGif(bytes);
      gif.renderer = createGifRenderer(gif);
      state.gif = gif;
      $.gifImg.src = url;
      $.gifImg.hidden = false;
      // 帧间隔都相同时才有确定的原始帧率
      const delay = gif.frames[0].delay;
      const uniform = gif.frames.every((f) => Math.abs(f.delay - delay) < 1e-6);
      const fps = uniform ? Math.round(100 / delay) / 100 : null;
      showMeta({ name: file.name || 'animation.gif', size: file.size, width: gif.width, height: gif.height, duration: gif.duration, fps });
      $.vFps.textContent = fps ?? '不固定';
      $.fps.value = fps ?? Math.round((gif.frames.length / gif.duration) * 100) / 100;
    }

    async function loadVideo(file, url, token) {
      const video = $.video;
      video.muted = true;
      video.hidden = false;
      const loaded = waitEvent(video, 'loadedmetadata', 15000);
      video.src = url;
      await loaded;
      if (token !== state.loadToken) return;
      if (!video.videoWidth || !video.videoHeight) throw new Error('无法解码视频画面，可能是浏览器不支持的编码');
      const duration = await resolveDuration(video);
      if (token !== state.loadToken) return;
      if (!(duration > 0)) throw new Error('无法获取视频时长');

      showMeta({ name: file.name || 'video', size: file.size, width: video.videoWidth, height: video.videoHeight, duration, fps: null });
      $.vFps.textContent = '检测中';

      const fps = await detectFps(video);
      if (token !== state.loadToken) return;
      state.video.fps = fps;
      $.vFps.textContent = fps ?? '未知';
      $.fps.value = fps ?? 30;
      await seek(video, 0).catch(() => {});
    }

    $.file.addEventListener('change', () => {
      loadFile($.file.files[0]);
      $.file.value = '';
    });
    $.change.addEventListener('click', () => $.file.click());

    $.stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      $.stage.classList.add('dragging');
    });
    $.stage.addEventListener('dragleave', () => $.stage.classList.remove('dragging'));
    $.stage.addEventListener('drop', (e) => {
      e.preventDefault();
      $.stage.classList.remove('dragging');
      if (state.extracting) {
        toast('正在抽帧，请先停止');
        return;
      }
      loadFile(e.dataTransfer.files[0]);
    });

    // ---------- 输出尺寸 ----------
    function readDimension(input) {
      const v = readNumber(input);
      return Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION ? v : NaN;
    }

    function setOutputSize(scale) {
      const v = state.video;
      if (!v) return;
      $.outW.value = Math.max(1, Math.round(v.width * scale));
      $.outH.value = Math.max(1, Math.round(v.height * scale));
      updatePlan();
    }

    function syncRatio(changed) {
      const v = state.video;
      if (!v || !$.lockRatio.checked) return;
      if (changed === 'w') {
        const w = readDimension($.outW);
        if (w) $.outH.value = Math.min(MAX_DIMENSION, Math.max(1, Math.round((w * v.height) / v.width)));
      } else {
        const h = readDimension($.outH);
        if (h) $.outW.value = Math.min(MAX_DIMENSION, Math.max(1, Math.round((h * v.width) / v.height)));
      }
    }

    $.outW.addEventListener('input', () => {
      syncRatio('w');
      updatePlan();
    });
    $.outH.addEventListener('input', () => {
      syncRatio('h');
      updatePlan();
    });
    $.lockRatio.addEventListener('change', () => {
      syncRatio('w');
      updatePlan();
    });
    root.querySelectorAll('[data-size]').forEach((btn) => {
      btn.addEventListener('click', () => setOutputSize(Number(btn.dataset.size)));
    });

    // ---------- 抽帧方案 ----------
    function gifAllFrames() {
      return !!state.gif && $.allFrames.checked;
    }

    function currentPlan() {
      const v = state.video;
      if (!v) return null;
      const start = Math.max(0, readNumber($.start) || 0);
      const endRaw = readNumber($.end);
      const end = Number.isFinite(endRaw) ? Math.min(endRaw, v.duration) : v.duration;
      const fps = readNumber($.fps);
      const w = readDimension($.outW);
      const h = readDimension($.outH);
      if (!(end > start) || !w || !h) return null;
      // GIF 逐帧：取显示时段与时间范围有交集的每一帧，time 为该帧的起始时间
      if (gifAllFrames()) {
        const times = state.gif.frames.filter((f) => f.time < end && f.time + f.delay > start).map((f) => f.time);
        return times.length ? { start, end, fps: null, times, count: times.length, w, h } : null;
      }
      if (!(fps > 0) || fps > 240) return null;
      return {
        start,
        end,
        fps,
        count: Math.max(1, Math.round((end - start) * fps)),
        w,
        h,
      };
    }

    function updatePlan() {
      const plan = currentPlan();
      $.plan.hidden = !state.video && !state.detecting;
      if (!state.video) {
        $.plan.textContent = state.detecting ? '正在读取文件…' : '请先上传视频或 GIF';
      } else if (!plan) {
        $.plan.textContent = `请填写有效的时间范围、帧率和输出尺寸（宽高 1 ~ ${MAX_DIMENSION} 的整数）`;
      } else {
        const native = state.video.fps;
        const notes = [];
        if (plan.times) {
          // GIF 逐帧，不需要帧率说明
        } else if (state.detecting) notes.push('正在检测原始帧率…');
        else if (native && Math.abs(plan.fps - native) < 0.01) notes.push('与原始帧率一致，即抽取每一帧');
        else if (native) notes.push(`原始帧率 ${native} fps，填写该值可抽取每一帧`);
        else if (state.gif) notes.push('GIF 帧间隔不固定，按帧率抽取可能重复或漏掉部分帧');
        else notes.push('未能检测到原始帧率，请按需填写');
        const ratioDiff = Math.abs(plan.w / plan.h - state.video.width / state.video.height) / (state.video.width / state.video.height);
        if (ratioDiff > 0.01) notes.push('宽高比与原画面不同，画面会被拉伸');
        $.plan.innerHTML = `将抽取 <b>${plan.count}</b> 帧，尺寸 <b>${plan.w}×${plan.h}</b>`;
        for (const text of notes) {
          const span = document.createElement('span');
          span.className = 'plan-note';
          span.textContent = text;
          $.plan.append(span);
        }
      }
      $.extract.disabled = state.extracting ? false : !plan || state.detecting || state.busy;
      if (!state.extracting) $.extract.textContent = '开始抽帧';
      for (const el of [$.start, $.end, $.fps, $.allFrames, $.outW, $.outH, $.lockRatio, ...root.querySelectorAll('[data-size]')]) {
        el.disabled = state.extracting || !state.video;
      }
      if (gifAllFrames()) $.fps.disabled = true;
      $.change.disabled = state.extracting || state.detecting;
      updateBgStatus();
      updateSelection();
    }

    for (const el of [$.start, $.end, $.fps]) el.addEventListener('input', updatePlan);
    $.allFrames.addEventListener('change', updatePlan);

    // ---------- 抽帧 ----------
    function cancelExtraction() {
      state.extractToken++;
      state.extracting = false;
      state.stopRequested = false;
    }

    async function extract() {
      if (state.extracting) {
        state.stopRequested = true;
        return;
      }
      const plan = currentPlan();
      if (!plan || state.detecting || state.busy) return;
      if (plan.count > MAX_FRAMES_WITHOUT_CONFIRM
        && !confirm(`将抽取 ${plan.count} 帧，占用内存较多且耗时较长，确定继续？`)) return;

      clearFrames();
      const token = ++state.extractToken;
      state.extracting = true;
      state.stopRequested = false;
      state.frameW = plan.w;
      state.frameH = plan.h;
      const video = $.video;
      video.pause();
      $.extract.textContent = '停止抽帧';
      updatePlan();

      const canvas = createCanvas(plan.w, plan.h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const base = baseName(state.video.name);
      const digits = String(plan.count).length;
      const lastTime = state.video.duration - 0.001;
      const gif = state.gif;
      // GIF 先合成到原尺寸画布，再缩放绘制到输出画布
      const gifCanvas = gif ? createCanvas(gif.width, gif.height) : null;
      const gifCtx = gifCanvas?.getContext('2d');

      try {
        for (let i = 0; i < plan.count; i++) {
          if (state.stopRequested || token !== state.extractToken) break;
          // 取每个采样区间的中点，避免落在帧边界上取到前一帧
          const time = plan.times ? plan.times[i] : Math.min(plan.start + (i + 0.5) / plan.fps, lastTime);
          ctx.clearRect(0, 0, plan.w, plan.h);
          if (gif) {
            const rgba = gif.renderer.render(gifFrameAt(gif, time));
            gifCtx.putImageData(new ImageData(rgba, gif.width, gif.height), 0, 0);
            ctx.drawImage(gifCanvas, 0, 0, plan.w, plan.h);
          } else {
            await seek(video, time);
            if (token !== state.extractToken) return;
            ctx.drawImage(video, 0, 0, plan.w, plan.h);
          }
          const blob = await canvasToBlob(canvas);
          const thumb = await makeThumb(canvas, plan.w, plan.h);
          if (token !== state.extractToken) return;
          addFrame({ time, blob, thumb, name: `${base}_${String(i + 1).padStart(digits, '0')}.png` });
          $.extract.textContent = `停止抽帧（${i + 1}/${plan.count}）`;
        }
      } catch (err) {
        if (token === state.extractToken) toast(`抽帧中断：${err.message}`);
      } finally {
        if (token === state.extractToken) {
          state.extracting = false;
          updatePlan();
          if (state.frames.length) toast(`抽帧完成，共 ${state.frames.length} 帧`);
        }
      }
    }

    $.extract.addEventListener('click', extract);

    // ---------- 帧管理 ----------
    function createFrame({ time, blob, thumb, name, generated = false }) {
      const f = {
        index: -1,
        time,
        name,
        blob,
        origThumbUrl: URL.createObjectURL(thumb),
        procBlob: null,
        procThumbUrl: null,
        appliedKey: '',
        version: 0,
        selected: true,
        generated,
        anim: null,
      };
      const card = document.createElement('div');
      card.className = 'tile selected';
      card.title = `${name}\n时间 ${time.toFixed(3)} 秒${generated ? '（补帧）' : ''}`;
      card.innerHTML = `
        <input type="checkbox" class="tile-check" checked>
        <div class="tile-actions">
          <button type="button" class="tile-action" data-action="zoom" title="放大预览" aria-label="放大预览">${ICON_ZOOM}</button>
          <button type="button" class="tile-action" data-action="download" title="下载此帧" aria-label="下载此帧">${ICON_DOWNLOAD}</button>
        </div>
        <div class="tile-thumb"><img alt="" loading="lazy"></div>
        <div class="tile-meta">
          <span class="tile-pos"></span>
          ${generated ? '<span class="badge badge-success">补帧</span>' : ''}
          <span class="badge">${time.toFixed(2)}s</span>
        </div>`;
      f.card = card;
      f.check = card.querySelector('input');
      f.img = card.querySelector('img');
      f.posEl = card.querySelector('.tile-pos');
      f.img.src = f.origThumbUrl;
      return f;
    }

    function setFrameIndex(f, index) {
      f.index = index;
      f.card.dataset.index = index;
      f.posEl.textContent = `第 ${index + 1} 帧`;
      f.check.setAttribute('aria-label', `选择第 ${index + 1} 帧`);
    }

    // 插入或移除帧后重新编号，并让预览帧滑块继续指向原来的帧
    function reindexFrames() {
      state.frames.forEach(setFrameIndex);
      state.lastClicked = -1;
      $.refFrame.max = Math.max(0, state.frames.length - 1);
      const ref = state.ref;
      if (ref && ref.frame.index >= 0) {
        ref.index = ref.frame.index;
        $.refFrame.value = ref.index;
        $.refOut.textContent = `#${ref.index + 1} · ${ref.frame.time.toFixed(2)}s`;
      } else if (state.frames.length) {
        setRefFrame(0);
      }
    }

    function insertFrames(after, list) {
      state.frames.splice(after.index + 1, 0, ...list);
      after.card.after(...list.map((f) => f.card));
      reindexFrames();
      updateBgStatus();
      updateSelection();
    }

    function removeFrames(list) {
      if ($.lightbox.open) $.lightbox.close();
      const set = new Set(list);
      for (const f of list) {
        f.card.remove();
        URL.revokeObjectURL(f.origThumbUrl);
        if (f.procThumbUrl) URL.revokeObjectURL(f.procThumbUrl);
        releaseAnim(f);
        f.index = -1;
      }
      state.frames = state.frames.filter((f) => !set.has(f));
      reindexFrames();
      updateBgStatus();
      updateSelection();
    }

    function addFrame(opts) {
      const f = createFrame(opts);
      setFrameIndex(f, state.frames.length);
      state.frames.push(f);
      $.tiles.append(f.card);

      $.refFrame.max = state.frames.length - 1;
      if (f.index === 0) onFirstFrame();
      updateBgStatus();
      updateSelection();
    }

    function onFirstFrame() {
      $.bgPanel.hidden = false;
      $.framesPanel.hidden = false;
      $.animPanel.hidden = false;
      const s = Math.min(1, ANIM_MAX_W / state.frameW, ANIM_MAX_H / state.frameH);
      state.anim.w = Math.max(1, Math.round(state.frameW * s));
      state.anim.h = Math.max(1, Math.round(state.frameH * s));
      $.animCanvas.width = state.anim.w;
      $.animCanvas.height = state.anim.h;
      if (!readNumber($.animFps)) $.animFps.value = Math.min(GIF_MAX_FPS, Math.round(readNumber($.fps)) || 10);
      $.gifW.value = Math.min(state.frameW, 480);
      setRefFrame(0);
      if (!state.anim.raf) state.anim.raf = requestAnimationFrame(animLoop);
    }

    function clearFrames() {
      cancelInterp();
      state.bgToken++;
      state.refToken++;
      for (const f of state.frames) {
        URL.revokeObjectURL(f.origThumbUrl);
        if (f.procThumbUrl) URL.revokeObjectURL(f.procThumbUrl);
        releaseAnim(f);
      }
      state.frames = [];
      state.ref = null;
      state.lastClicked = -1;
      state.anim.list = [];
      state.anim.index = 0;
      state.anim.drawn = null;
      setPicking(false);
      if ($.lightbox.open) $.lightbox.close();
      $.tiles.replaceChildren();
      $.bgPanel.hidden = true;
      $.framesPanel.hidden = true;
      $.animPanel.hidden = true;
    }

    function outputBlob(f) {
      return f.appliedKey ? f.procBlob : f.blob;
    }

    function setFrameOutput(f, key, procBlob, procThumb) {
      if (f.procThumbUrl) URL.revokeObjectURL(f.procThumbUrl);
      f.procBlob = procBlob;
      f.procThumbUrl = procThumb ? URL.createObjectURL(procThumb) : null;
      f.appliedKey = key;
      f.version++;
      f.img.src = f.procThumbUrl || f.origThumbUrl;
    }

    // ---------- 去除背景 ----------
    function bgParams() {
      return {
        colors: state.colors.map(hexToRgb),
        tolerance: Number($.tolerance.value),
        feather: Number($.feather.value),
      };
    }

    function bgKey() {
      if (!$.bgEnabled.checked || !state.colors.length) return '';
      return `${state.colors.join(',')}|${$.tolerance.value}|${$.feather.value}`;
    }

    async function processFrame(f, params, canvas) {
      const bmp = await createImageBitmap(f.blob);
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      removeBackground(img.data, params);
      ctx.putImageData(img, 0, 0);
      const blob = await canvasToBlob(canvas);
      const thumb = await makeThumb(canvas, canvas.width, canvas.height);
      return { blob, thumb };
    }

    async function runApply() {
      const token = state.bgToken;
      const canvas = createCanvas(1, 1);
      // 处理期间若参数又被修改，继续处理直到所有帧与最新参数一致
      for (;;) {
        const key = bgKey();
        const params = bgParams();
        const dirty = state.frames.filter((f) => f.appliedKey !== key);
        if (!dirty.length) return true;
        for (let n = 0; n < dirty.length; n++) {
          if (token !== state.bgToken) return false;
          const f = dirty[n];
          if (key) {
            const out = await processFrame(f, params, canvas);
            if (token !== state.bgToken) return false;
            setFrameOutput(f, key, out.blob, out.thumb);
          } else {
            setFrameOutput(f, '', null, null);
          }
          state.applyProgress = `${n + 1}/${dirty.length}`;
          updateBgStatus();
          state.progressTask?.update(n + 1, dirty.length, '正在去除背景');
          if (!key && n % 50 === 0) await nextTick();
        }
      }
    }

    function applyBackground() {
      if (!state.applyPromise) {
        const p = runApply()
          .catch((err) => {
            toast(`去除背景失败：${err.message}`);
            return false;
          })
          .finally(() => {
            if (state.applyPromise === p) state.applyPromise = null;
            state.applyProgress = '';
            updateBgStatus();
          });
        state.applyPromise = p;
        updateBgStatus();
      }
      return state.applyPromise;
    }

    function updateBgStatus() {
      const key = bgKey();
      const dirty = state.frames.filter((f) => f.appliedKey !== key).length;
      const applying = Boolean(state.applyPromise);
      if (applying) $.bgStatus.textContent = `处理中 ${state.applyProgress}`;
      else if (dirty) $.bgStatus.textContent = `${dirty} 帧待应用`;
      else if (!key) $.bgStatus.textContent = '未去除背景';
      else $.bgStatus.textContent = '已应用到全部帧';
      $.apply.disabled = applying || !dirty || state.extracting;
      $.apply.textContent = applying ? `处理中（${state.applyProgress || '准备中'}）` : '应用到全部帧';
    }

    $.apply.addEventListener('click', () => applyBackground());

    async function setRefFrame(index) {
      const f = state.frames[index];
      if (!f) return;
      $.refFrame.value = index;
      $.refOut.textContent = `#${index + 1} · ${f.time.toFixed(2)}s`;
      const token = ++state.refToken;
      let bmp;
      try {
        bmp = await createImageBitmap(f.blob);
      } catch {
        return;
      }
      if (token !== state.refToken) {
        bmp.close();
        return;
      }
      const c = createCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      state.ref = { index, frame: f, original: ctx.getImageData(0, 0, c.width, c.height) };
      $.bgCanvas.width = c.width;
      $.bgCanvas.height = c.height;
      renderRef();
      bgZoom.refresh();
    }

    function renderRef() {
      const ref = state.ref;
      if (!ref) return;
      const { width, height, data } = ref.original;
      const img = new ImageData(new Uint8ClampedArray(data), width, height);
      if (state.view === 'result' && bgKey()) removeBackground(img.data, bgParams());
      $.bgCanvas.getContext('2d').putImageData(img, 0, 0);
    }

    function scheduleRender() {
      if (state.renderQueued) return;
      state.renderQueued = true;
      requestAnimationFrame(() => {
        state.renderQueued = false;
        renderRef();
      });
    }

    function onBgParamsChange() {
      $.tolOut.textContent = $.tolerance.value;
      $.featherOut.textContent = $.feather.value;
      scheduleRender();
      updateBgStatus();
    }

    $.tolerance.addEventListener('input', onBgParamsChange);
    $.feather.addEventListener('input', onBgParamsChange);
    $.bgEnabled.addEventListener('change', onBgParamsChange);
    $.refFrame.addEventListener('input', () => setRefFrame(Number($.refFrame.value)));

    function setView(view) {
      state.view = view;
      $.viewResult.setAttribute('aria-pressed', String(view === 'result'));
      $.viewOriginal.setAttribute('aria-pressed', String(view === 'original'));
      scheduleRender();
    }
    $.viewResult.addEventListener('click', () => setView('result'));
    $.viewOriginal.addEventListener('click', () => setView('original'));

    function renderColors() {
      if (!state.colors.length) {
        const empty = document.createElement('span');
        empty.className = 'empty-text';
        empty.textContent = '尚未选择背景颜色';
        $.colors.replaceChildren(empty);
        return;
      }
      $.colors.replaceChildren(...state.colors.map((hex) => {
        const chip = document.createElement('span');
        chip.className = 'color-chip';
        const swatch = document.createElement('i');
        swatch.className = 'swatch';
        swatch.style.background = hex;
        const code = document.createElement('code');
        code.textContent = hex;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = `移除 ${hex}`;
        remove.addEventListener('click', () => {
          state.colors = state.colors.filter((c) => c !== hex);
          renderColors();
          onBgParamsChange();
        });
        chip.append(swatch, code, remove);
        return chip;
      }));
    }

    function addColor(hex) {
      const value = hex.toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value)) return;
      if (state.colors.includes(value)) {
        toast(`颜色 ${value} 已添加`);
        return;
      }
      state.colors.push(value);
      if (!$.bgEnabled.checked) $.bgEnabled.checked = true;
      renderColors();
      onBgParamsChange();
    }

    function setPicking(on) {
      state.picking = on;
      $.picker.classList.toggle('is-active', on);
      $.picker.textContent = on ? '点击画布取色' : '吸管取色';
      $.bgCanvas.classList.toggle('picking', on);
      $.hover.hidden = !on;
    }

    function sampleAt(e) {
      const ref = state.ref;
      if (!ref) return null;
      const rect = $.bgCanvas.getBoundingClientRect();
      const { width, height, data } = ref.original;
      const x = Math.min(width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * width)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * height)));
      const i = (y * width + x) * 4;
      return { hex: rgbToHex(data[i], data[i + 1], data[i + 2]), x, y };
    }

    $.picker.addEventListener('click', () => setPicking(!state.picking));
    $.manualColor.addEventListener('change', () => addColor($.manualColor.value));
    $.bgCanvas.addEventListener('mousemove', (e) => {
      if (!state.picking) return;
      const sample = sampleAt(e);
      if (!sample) return;
      $.hoverSwatch.style.background = sample.hex;
      $.hoverHex.textContent = sample.hex;
      $.hoverPos.textContent = `(${sample.x}, ${sample.y})`;
    });
    $.bgCanvas.addEventListener('click', (e) => {
      if (!state.picking) return;
      const sample = sampleAt(e);
      if (!sample) return;
      addColor(sample.hex);
      if (!e.shiftKey) setPicking(false); // 按住 Shift 可连续取色
    });
    const onKeydown = (e) => {
      if (e.key === 'Escape' && state.picking) setPicking(false);
    };
    document.addEventListener('keydown', onKeydown);

    // ---------- 帧选择 ----------
    function setSelected(f, value) {
      f.selected = value;
      f.check.checked = value;
      f.card.classList.toggle('selected', value);
    }

    function selectedFrames() {
      return state.frames.filter((f) => f.selected);
    }

    function updateSelection() {
      const n = selectedFrames().length;
      $.count.textContent = `共 ${state.frames.length} 帧 · 已选 ${n} 帧`;
      $.save.textContent = `保存选中到本地 (${n})`;
      const blocked = n === 0 || state.busy || state.extracting;
      $.save.disabled = blocked;
      $.zip.disabled = blocked;
      updateInterp();
      refreshAnimList();
      updateGifPlan();
    }

    $.tiles.addEventListener('click', (e) => {
      const card = e.target.closest('.tile');
      if (!card) return;
      const f = state.frames[Number(card.dataset.index)];
      if (!f) return;
      const action = e.target.closest('.tile-action')?.dataset.action;
      if (action === 'zoom') {
        openLightbox(f.index);
        return;
      }
      if (action === 'download') {
        downloadFrame(f);
        return;
      }
      // 直接点复选框时其状态已被浏览器切换
      const value = e.target === f.check ? f.check.checked : !f.selected;
      if (e.shiftKey && state.lastClicked >= 0 && state.lastClicked !== f.index) {
        const from = Math.min(state.lastClicked, f.index);
        const to = Math.max(state.lastClicked, f.index);
        for (let i = from; i <= to; i++) setSelected(state.frames[i], value);
      } else {
        setSelected(f, value);
      }
      state.lastClicked = f.index;
      updateSelection();
    });

    function setSelection(fn) {
      for (const f of state.frames) setSelected(f, fn(f));
      updateSelection();
    }
    $.selAll.addEventListener('click', () => setSelection(() => true));
    $.selNone.addEventListener('click', () => setSelection(() => false));
    $.selInvert.addEventListener('click', () => setSelection((f) => !f.selected));

    // ---------- 补帧 ----------
    $.interpMethod.value = localStorage.getItem(INTERP_METHOD_KEY) || 'ai-pixel';
    if (!$.interpMethod.value) $.interpMethod.value = 'ai-pixel'; // 存储的方式已不存在
    const syncMethodTitle = () => {
      $.interpMethod.title = $.interpMethod.selectedOptions[0]?.title || '';
    };
    syncMethodTitle();
    $.interpMethod.addEventListener('change', () => {
      localStorage.setItem(INTERP_METHOD_KEY, $.interpMethod.value);
      syncMethodTitle();
    });

    function updateInterp() {
      const it = state.interp;
      $.interp.disabled = it.running ? false : selectedFrames().length < 2 || state.busy || state.extracting;
      if (!it.running) $.interp.textContent = '补帧';
      $.interpClear.disabled = state.busy || state.extracting || !state.frames.some((f) => f.generated);
      $.interpMethod.disabled = it.running;
      $.interpCount.disabled = it.running;
      $.interpLoop.disabled = it.running;
    }

    function cancelInterp() {
      const it = state.interp;
      it.token++;
      if (it.running) {
        it.running = false;
        state.busy = false;
      }
    }

    async function frameRgba(f, ctx) {
      const bmp = await createImageBitmap(f.blob);
      ctx.clearRect(0, 0, state.frameW, state.frameH);
      ctx.drawImage(bmp, 0, 0, state.frameW, state.frameH);
      bmp.close();
      return ctx.getImageData(0, 0, state.frameW, state.frameH).data;
    }

    // 在相邻的选中帧之间插入过渡帧（用去背景前的原始帧补帧，之后与其他帧一样去背景）
    async function interpolate() {
      const it = state.interp;
      if (it.running) {
        it.stop = true;
        return;
      }
      const list = selectedFrames();
      if (list.length < 2 || state.busy || state.extracting) return;
      const method = $.interpMethod.value;
      const count = Number($.interpCount.value);
      const pairs = list.slice(0, -1).map((f, i) => [f, list[i + 1]]);
      if ($.interpLoop.checked) pairs.push([list[list.length - 1], list[0]]);
      const total = pairs.length * count;
      const times = Array.from({ length: count }, (_, k) => (k + 1) / (count + 1));
      // 首尾衔接那一段没有时间差，按平均帧间隔推算补帧的时间
      const gap = (list[list.length - 1].time - list[0].time) / (list.length - 1);
      const token = ++it.token;
      it.running = true;
      it.stop = false;
      if ($.lightbox.open) $.lightbox.close();
      setBusy(true);
      $.interp.textContent = '停止补帧';
      const task = startProgress(isAiMethod(method) ? '正在加载 AI 补帧模型' : '正在补帧');
      let settled = false;
      let ai = null;
      let added = 0;
      try {
        ai = await createInterpolator(method);
        if (token !== it.token) return;
        const w = state.frameW;
        const h = state.frameH;
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const label = () => (ai.backend ? `正在补帧（${ai.backend === 'webgpu' ? 'GPU' : 'CPU'}）` : '正在补帧');
        task.update(0, total, label());
        let cached = null; // 上一对的后一帧就是下一对的前一帧，复用解码结果
        for (const [a, b] of pairs) {
          if (it.stop || token !== it.token) break;
          const da = cached?.f === a ? cached.data : await frameRgba(a, ctx);
          const db = await frameRgba(b, ctx);
          cached = { f: b, data: db };
          const outs = await ai.run(da, db, w, h, times);
          if (token !== it.token) return;
          const made = [];
          for (const data of outs) {
            ctx.putImageData(new ImageData(data, w, h), 0, 0);
            made.push({ blob: await canvasToBlob(canvas), thumb: await makeThumb(canvas, w, h) });
          }
          if (token !== it.token) return;
          const span = b.time > a.time ? b.time - a.time : gap;
          const stem = a.name.replace(/\.png$/i, '');
          insertFrames(a, made.map((m, k) => createFrame({
            ...m,
            time: a.time + span * times[k],
            name: `${stem}_interp${k + 1}.png`,
            generated: true,
          })));
          added += made.length;
          $.interp.textContent = `停止补帧（${added}/${total}）`;
          task.update(added, total, label());
        }
        if (token !== it.token) return;
        settled = true;
        if (added < total) {
          task.finish(`已停止补帧，插入了 ${added} 帧`);
          return;
        }
        // 帧数变为约 (count + 1) 倍，动画帧率同步提高以保持原来的播放时长
        const fps = Math.min(GIF_MAX_FPS, Math.round(animFps() * (count + 1) * 100) / 100);
        $.animFps.value = fps;
        $.animFps.dispatchEvent(new Event('input'));
        task.finish(`补帧完成，插入 ${added} 帧，动画帧率调整为 ${fps} fps`);
      } catch (err) {
        settled = true;
        if (token === it.token) task.fail(`补帧失败：${err.message}`);
        else task.fail('补帧已中断');
      } finally {
        ai?.dispose();
        if (!settled) task.fail('补帧已中断');
        if (token === it.token) {
          it.running = false;
          setBusy(false);
        }
      }
    }

    $.interp.addEventListener('click', interpolate);
    $.interpClear.addEventListener('click', () => {
      const list = state.frames.filter((f) => f.generated);
      if (!list.length || state.busy) return;
      removeFrames(list);
      toast(`已移除 ${list.length} 个补帧`);
    });

    // ---------- 动画预览 ----------
    function animFps() {
      const v = readNumber($.animFps);
      return v > 0 ? Math.min(v, GIF_MAX_FPS) : 10;
    }

    function releaseAnim(f) {
      f.anim?.bitmap?.close();
      f.anim?.stale?.close();
      f.anim = null;
    }

    function refreshAnimList() {
      const a = state.anim;
      a.list = selectedFrames();
      for (const f of state.frames) if (!f.selected) releaseAnim(f);
      if (a.index >= a.list.length) a.index = 0;
      a.start = performance.now() - (a.index * 1000) / animFps();
      a.drawn = null;
      const empty = !a.list.length;
      $.animEmpty.hidden = !empty;
      $.animCanvas.hidden = empty;
      if (empty) $.animOut.textContent = '未选择帧';
    }

    // 按需解码缩小的预览位图；新位图就绪前继续显示旧的，避免闪烁
    function animBitmap(f) {
      let entry = f.anim;
      if (!entry || entry.version !== f.version) {
        const stale = entry ? entry.bitmap || entry.stale : null;
        entry = { version: f.version, bitmap: null, stale };
        f.anim = entry;
        decodeScaled(outputBlob(f), state.anim.w, state.anim.h)
          .then((bmp) => {
            if (f.anim !== entry) {
              bmp.close();
              return;
            }
            entry.bitmap = bmp;
            entry.stale?.close();
            entry.stale = null;
          })
          .catch(() => {});
      }
      return entry.bitmap || entry.stale;
    }

    function animLoop(now) {
      const a = state.anim;
      a.raf = requestAnimationFrame(animLoop);
      const n = a.list.length;
      if (!n) return;
      if (a.playing) a.index = Math.floor(((now - a.start) * animFps()) / 1000) % n;
      for (let k = 1; k <= 3 && k < n; k++) animBitmap(a.list[(a.index + k) % n]);
      const bmp = animBitmap(a.list[a.index]);
      if (bmp && bmp !== a.drawn) {
        animCtx.clearRect(0, 0, a.w, a.h);
        animCtx.drawImage(bmp, 0, 0, a.w, a.h);
        a.drawn = bmp;
        $.animOut.textContent = `第 ${a.index + 1} / ${n} 帧`;
      }
    }

    function stepAnim(delta) {
      const a = state.anim;
      const n = a.list.length;
      if (!n) return;
      setPlaying(false);
      a.index = (a.index + delta + n) % n;
      a.drawn = null;
    }

    function setPlaying(on) {
      const a = state.anim;
      a.playing = on;
      if (on) a.start = performance.now() - (a.index * 1000) / animFps();
      $.play.textContent = on ? '暂停' : '播放';
      $.play.setAttribute('aria-pressed', String(on));
    }

    $.play.addEventListener('click', () => setPlaying(!state.anim.playing));
    $.prev.addEventListener('click', () => stepAnim(-1));
    $.next.addEventListener('click', () => stepAnim(1));
    $.animFps.addEventListener('input', () => {
      state.anim.start = performance.now() - (state.anim.index * 1000) / animFps();
      updateGifPlan();
    });

    // ---------- 导出 ----------
    function gifSize() {
      const w = readNumber($.gifW);
      if (!state.frameW || !Number.isInteger(w) || w < 1 || w > 4096) return null;
      return { w, h: Math.max(1, Math.round((w * state.frameH) / state.frameW)) };
    }

    function gifDelays(count, fps) {
      // 按累计时间取整，使整体时长贴近目标帧率
      return Array.from({ length: count }, (_, i) => Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));
    }

    function updateGifPlan() {
      const n = state.anim.list.length;
      const size = gifSize();
      if (!n) $.gifPlan.textContent = '请先选择需要的帧';
      else if (!size) $.gifPlan.textContent = '请输入有效的 GIF 宽度（1 ~ 4096）';
      else {
        const fps = animFps();
        $.gifPlan.innerHTML = `<b>${n}</b> 帧 · <b>${size.w}×${size.h}</b> px · 约 <b>${(n / fps).toFixed(2)}</b> 秒`
          + '<span class="plan-note">导出前自动应用当前去背景参数</span>';
      }
      $.gif.disabled = !n || !size || state.busy || state.extracting;
    }

    $.gifW.addEventListener('input', updateGifPlan);
    $.gifBg.addEventListener('change', () => {
      $.gifMatte.disabled = $.gifBg.value !== 'color';
    });

    function setBusy(on) {
      state.busy = on;
      updatePlan();
    }

    async function exportGif() {
      const list = selectedFrames();
      const size = gifSize();
      if (!list.length || !size || state.busy) return;
      setBusy(true);
      const task = startProgress('准备导出 GIF');
      state.progressTask = task;
      try {
        if (!(await applyBackground())) {
          task.fail('导出已中断');
          return;
        }
        const fps = animFps();
        const delays = gifDelays(list.length, fps);
        const matte = $.gifBg.value === 'color' ? $.gifMatte.value : null;
        const encoder = new GifEncoder(size.w, size.h, { loop: Number($.gifLoop.value) });
        const canvas = createCanvas(size.w, size.h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        for (let i = 0; i < list.length; i++) {
          const bmp = await decodeScaled(outputBlob(list[i]), size.w, size.h);
          ctx.clearRect(0, 0, size.w, size.h);
          if (matte) {
            ctx.fillStyle = matte;
            ctx.fillRect(0, 0, size.w, size.h);
          }
          ctx.drawImage(bmp, 0, 0, size.w, size.h);
          bmp.close();
          encoder.addFrame(ctx.getImageData(0, 0, size.w, size.h).data, delays[i]);
          $.gif.textContent = `编码中 ${i + 1}/${list.length}`;
          task.update(i + 1, list.length, '正在编码 GIF');
          await nextTick();
        }
        const blob = encoder.finish();
        downloadBlob(blob, `${baseName(state.video?.name || 'video')}.gif`);
        task.finish(`GIF 已生成（${list.length} 帧，${formatBytes(blob.size)}），浏览器开始下载`);
      } catch (err) {
        task.fail(`导出 GIF 失败：${err.message}`);
      } finally {
        state.progressTask = null;
        $.gif.textContent = '导出 GIF';
        setBusy(false);
      }
    }

    $.gif.addEventListener('click', exportGif);

    // 取得与当前去背景参数一致的帧图片，必要时单独处理该帧
    async function frameOutput(f) {
      const key = bgKey();
      if (f.appliedKey === key) return outputBlob(f);
      if (!key) return f.blob;
      const out = await processFrame(f, bgParams(), createCanvas(1, 1));
      if (state.frames[f.index] === f && bgKey() === key) setFrameOutput(f, key, out.blob, out.thumb);
      return out.blob;
    }

    async function downloadFrame(f) {
      try {
        downloadBlob(await frameOutput(f), f.name);
      } catch (err) {
        toast(`保存失败：${err.message}`);
      }
    }

    // ---------- 放大预览 ----------
    function updateLightboxSelect() {
      const f = state.frames[state.lightbox.index];
      if (!f) return;
      $.lbSelect.textContent = f.selected ? '✓ 已选中' : '选中此帧';
      $.lbSelect.classList.toggle('btn-primary', f.selected);
    }

    async function showLightboxFrame(index) {
      const f = state.frames[index];
      if (!f) return;
      const lb = state.lightbox;
      lb.index = index;
      const token = ++lb.token;
      $.lbTitle.textContent = `第 ${index + 1} / ${state.frames.length} 帧`;
      $.lbMeta.textContent = `${f.time.toFixed(3)}s · ${state.frameW}×${state.frameH}`;
      $.lbPrev.disabled = index === 0;
      $.lbNext.disabled = index === state.frames.length - 1;
      updateLightboxSelect();
      let blob;
      try {
        blob = await frameOutput(f);
      } catch (err) {
        toast(`加载帧失败：${err.message}`);
        return;
      }
      if (token !== lb.token || !$.lightbox.open) return;
      const url = URL.createObjectURL(blob);
      $.lbImg.src = url;
      if (lb.url) URL.revokeObjectURL(lb.url);
      lb.url = url;
    }

    function openLightbox(index) {
      if (!$.lightbox.open) {
        state.lightbox.needsFit = true;
        $.lightbox.showModal();
      }
      showLightboxFrame(index);
    }

    function stepLightbox(delta) {
      const next = state.lightbox.index + delta;
      if (next >= 0 && next < state.frames.length) showLightboxFrame(next);
    }

    // 切换到同尺寸的帧时保留缩放与位置，方便逐帧对比同一处细节
    $.lbImg.addEventListener('load', () => {
      if (state.lightbox.needsFit) {
        state.lightbox.needsFit = false;
        lbZoom.fit();
      } else {
        lbZoom.refresh();
      }
    });
    $.lbPrev.addEventListener('click', () => stepLightbox(-1));
    $.lbNext.addEventListener('click', () => stepLightbox(1));
    $.lbClose.addEventListener('click', () => $.lightbox.close());
    $.lbDownload.addEventListener('click', () => {
      const f = state.frames[state.lightbox.index];
      if (f) downloadFrame(f);
    });
    $.lbSelect.addEventListener('click', () => {
      const f = state.frames[state.lightbox.index];
      if (!f) return;
      setSelected(f, !f.selected);
      state.lastClicked = f.index;
      updateSelection();
      updateLightboxSelect();
    });
    $.lightbox.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        stepLightbox(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        $.lbSelect.click();
      }
    });
    $.lightbox.addEventListener('close', () => {
      const lb = state.lightbox;
      lb.token++;
      lb.index = -1;
      $.lbImg.removeAttribute('src');
      if (lb.url) URL.revokeObjectURL(lb.url);
      lb.url = null;
    });

    async function saveSelected(asZip) {
      const chosen = selectedFrames();
      if (!chosen.length || state.busy) return;
      const dir = asZip ? null : await pickFolder('video-frames');
      if (dir === undefined) return;
      setBusy(true);
      const task = startProgress('准备保存');
      state.progressTask = task;
      try {
        if (!(await applyBackground())) {
          task.fail('保存已中断');
          return;
        }
        await writeFiles(chosen.map((f) => ({ name: f.name, blob: outputBlob(f) })), {
          dir,
          zipName: `${baseName(state.video?.name || 'video')}_frames.zip`,
          task,
          summary: `${chosen.length} 张图片`,
        });
      } catch (err) {
        task.fail(`保存失败：${err.message}`);
      } finally {
        state.progressTask = null;
        setBusy(false);
      }
    }

    $.save.addEventListener('click', () => saveSelected(false));
    $.zip.addEventListener('click', () => saveSelected(true));

    renderColors();
    updatePlan();

    // ---------- 卸载 ----------
    return () => {
      document.removeEventListener('keydown', onKeydown);
      cancelAnimationFrame(state.anim.raf);
      bgZoom.destroy();
      lbZoom.destroy();
      state.loadToken++;
      cancelExtraction();
      clearFrames();
      resetSource();
    };
  },
};
