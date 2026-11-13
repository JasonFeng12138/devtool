import { createZoomView } from '../lib/zoom.js';
import { hexToRgb, removeBackground, rgbToHex } from '../lib/color-key.js';
import { detectSprites, sortReading, tightBox } from '../lib/sprite-detect.js';
import { handoff } from '../lib/handoff.js';
import { pickFolder, writeFiles } from '../lib/save.js';
import { ICON_UPLOAD, collectRefs, downloadBlob, formatBytes, startProgress, toast } from '../lib/ui.js';
import { SVG_SCALE_OPTIONS, cropSvg, isSvg, rasterSize, rasterizeSvg, readSvg, resolveScale } from '../lib/vector.js';

const THUMB_MAX = 150;
const THUMB_MAX_UPSCALE = 4;
const MAX_PIXELS_WITHOUT_CONFIRM = 40e6;
const DETECT_DELAY = 250;
const HISTORY_LIMIT = 100;
const HANDLE_SCREEN = 8; // 手柄边长（屏幕像素）
const HIT_SCREEN = 5; // 命中容差（屏幕像素）
const LABEL_MIN_SCREEN = 16; // 框在屏幕上小于此尺寸时不显示序号
const DRAG_THRESHOLD = 3;
const HANDLE_CURSOR = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};
const FORMATS = {
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
  svg: { mime: 'image/svg+xml', ext: 'svg' },
};

const ICON_LOCATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
const ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const SLIDERS = [
  { ref: 'tolerance', label: '容差', min: 0, max: 100, value: 10, unit: '' },
  { ref: 'merge', label: '合并距离', min: 0, max: 64, value: 4, unit: 'px' },
  { ref: 'minSize', label: '最小尺寸', title: '宽高都小于此值的素材视为噪点', min: 1, max: 128, value: 8, unit: 'px' },
  { ref: 'pad', label: '外扩', min: 0, max: 32, value: 0, unit: 'px' },
];

const TEMPLATE = `
<section class="panel" data-ref="detectPanel">
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">1. 识别素材</h2>
      <span class="badge" data-ref="boxCount" hidden></span>
    </div>
  </div>
  <div class="tool-toolbar" data-ref="toolbar" hidden>
    <div class="segmented" role="group" aria-label="编辑模式">
      <button class="segmented-item" data-ref="modeSelect" aria-pressed="true" title="选择、移动、调整大小（V）">选择</button>
      <button class="segmented-item" data-ref="modeDraw" aria-pressed="false" title="拖拽新建框（R）">画框</button>
    </div>
    <div class="segmented" role="group" aria-label="编辑操作">
      <button class="segmented-item" data-ref="mergeSelected" title="把选中的框合并为一个（M）">合并</button>
      <button class="segmented-item" data-ref="fit" title="把选中的框收紧到框内素材边缘（F）">贴合</button>
      <button class="segmented-item" data-ref="del" title="删除选中的框（Delete）">删除</button>
    </div>
    <div class="segmented" role="group" aria-label="历史">
      <button class="segmented-item" data-ref="undo" title="撤销（Ctrl+Z）">撤销</button>
      <button class="segmented-item" data-ref="redo" title="重做（Ctrl+Y）">重做</button>
    </div>
  </div>
  <div class="tool-split">
    <div class="stage" data-ref="dropStage">
      <label class="dropzone">
        <input type="file" accept="image/*,.svg" aria-label="选择图片" data-ref="file">
        ${ICON_UPLOAD}
        <span class="dropzone-title">选择图片</span>
        <span class="dropzone-hint">拖拽或 Ctrl+V 粘贴 · 支持 SVG</span>
      </label>
    </div>
    <div class="stage zoom-stage ss-stage" data-ref="stage" tabindex="0" aria-label="素材画布" title="Shift 多选或框选；方向键微调，Shift 加速；滚轮缩放，空格或中键拖拽平移" hidden>
      <div class="ss-wrap checker" data-ref="wrap">
        <canvas data-ref="canvas"></canvas>
        <svg class="ss-overlay" data-ref="overlay" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>

    <div class="controls">
      <div class="dims" data-ref="meta" hidden>
        <div class="dim"><span class="dim-label">原图宽度</span><span class="dim-value"><b data-ref="imgW">0</b> px</span></div>
        <div class="dim"><span class="dim-label">原图高度</span><span class="dim-value"><b data-ref="imgH">0</b> px</span></div>
        <div class="file-meta" data-ref="fileMeta"></div>
      </div>

      <label class="field" data-ref="svgField" hidden>矢量图渲染倍数
        <select data-ref="svgScale">${SVG_SCALE_OPTIONS}</select>
        <span class="plan-note" data-ref="svgNote"></span>
      </label>

      <div class="control-group">
        <div class="field">
          <span>背景</span>
          <div class="segmented ss-bg-mode" role="group" aria-label="背景模式">
            <button class="segmented-item" data-bg-mode="auto" aria-pressed="true" title="根据图片最外一圈像素自动判断">自动</button>
            <button class="segmented-item" data-bg-mode="alpha" aria-pressed="false" title="透明像素为背景">透明</button>
            <button class="segmented-item" data-bg-mode="color" aria-pressed="false" title="用吸管指定背景颜色">指定颜色</button>
          </div>
          <span class="ss-bg-info" data-ref="bgInfo"></span>
        </div>

        <div class="field" data-ref="colorField" hidden>
          <span>背景颜色</span>
          <div class="color-list" data-ref="colors"></div>
          <div class="picker-row">
            <button class="btn" data-ref="picker" title="点击画布添加背景色；Shift 连续取色，Esc 取消">吸管取色</button>
            <input type="color" class="color-input" data-ref="manualColor" value="#ffffff" title="手动选择颜色并添加">
          </div>
          <span class="pick-hover" data-ref="hover" hidden><i class="swatch" data-ref="hoverSwatch"></i><code data-ref="hoverHex"></code><span class="pick-hover-pos" data-ref="hoverPos"></span></span>
        </div>
      </div>

      <div class="control-group">
        <div class="field-row">
          ${SLIDERS.map((s) => `
          <label class="field" title="${s.title || s.label}">
            <span class="field-label">${s.label}<output data-ref="${s.ref}Out">${s.value}${s.unit}</output></span>
            <input type="range" min="${s.min}" max="${s.max}" step="1" value="${s.value}" data-ref="${s.ref}">
          </label>`).join('')}
        </div>
      </div>

      <div class="plan" data-ref="plan" hidden></div>

      <div class="field" data-ref="boxFields" hidden>
        <span>选中框</span>
        <div class="box-fields">
          <label>X<input type="number" min="0" step="1" data-ref="bx"></label>
          <label>Y<input type="number" min="0" step="1" data-ref="by"></label>
          <label>宽<input type="number" min="1" step="1" data-ref="bw"></label>
          <label>高<input type="number" min="1" step="1" data-ref="bh"></label>
        </div>
      </div>

      <div class="actions actions-stack">
        <button class="btn btn-primary" data-ref="redetect" disabled>重新识别</button>
        <button class="btn" data-ref="change" disabled>更换图片</button>
      </div>
    </div>
  </div>
</section>

<section class="panel" data-ref="resultPanel" hidden>
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">2. 裁切结果</h2>
      <span class="badge" data-ref="count"></span>
    </div>
    <div class="segmented" role="group" aria-label="选择">
      <button class="segmented-item" data-ref="selAll">全选</button>
      <button class="segmented-item" data-ref="selNone">全不选</button>
      <button class="segmented-item" data-ref="selInvert">反选</button>
    </div>
  </div>
  <div class="tiles tiles-scroll scroll-area ss-tiles" data-ref="tiles" title="点击勾选输出，Shift 点击选择区间；悬停素材可定位、预览或下载"></div>
  <p class="empty-text" data-ref="tilesEmpty" hidden>未识别到素材，请调整识别参数或手动画框。</p>
</section>

<section class="panel" data-ref="outputPanel" hidden>
  <div class="panel-header">
    <h2 class="section-title">3. 输出与保存</h2>
  </div>
  <div class="export-grid">
    <label class="field">格式
      <select data-ref="format">
        <option value="png">PNG（无损）</option>
        <option value="webp">WebP</option>
        <option value="svg">SVG（保留矢量，仅限 SVG 原图）</option>
      </select>
    </label>
    <label class="field">背景
      <select data-ref="outBg">
        <option value="keep">保留原样</option>
        <option value="transparent">背景透明</option>
      </select>
    </label>
    <label class="field">统一尺寸
      <select data-ref="uniform">
        <option value="none">不统一（按素材大小）</option>
        <option value="center">统一 · 居中对齐</option>
        <option value="bottom">统一 · 底部居中</option>
      </select>
    </label>
    <label class="field">
      <span class="field-label">边缘羽化<output data-ref="featherOut">3</output></span>
      <input type="range" min="0" max="50" step="1" value="3" data-ref="feather" disabled>
    </label>
    <label class="check ss-json" title="包含各素材在原图中的位置，可用作精灵图数据"><input type="checkbox" data-ref="json">导出坐标 JSON</label>
  </div>
  <div class="plan" data-ref="outPlan"></div>
  <div class="actions export-actions">
    <button class="btn" data-ref="toBatch">发送到图片批处理</button>
    <button class="btn" data-ref="zip">打包 ZIP 下载</button>
    <button class="btn btn-primary" data-ref="save">保存选中到本地</button>
  </div>
</section>

<dialog class="lightbox glass" data-ref="lightbox" aria-label="素材预览">
  <div class="lightbox-header">
    <div class="panel-heading">
      <h3 class="section-title" data-ref="lbTitle"></h3>
      <span class="badge" data-ref="lbMeta"></span>
      <span class="lightbox-name" data-ref="lbName"></span>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-ref="lbSelect"></button>
      <button type="button" class="btn" data-ref="lbDownload">下载此图</button>
      <button type="button" class="btn" data-ref="lbClose">关闭</button>
    </div>
  </div>
  <div class="lightbox-body">
    <div class="stage lightbox-stage" data-ref="lbStage" title="按当前输出设置预览；滚轮缩放，拖拽平移；← → 切换，空格勾选，Esc 关闭">
      <img class="checker" alt="" data-ref="lbImg">
    </div>
    <button type="button" class="lightbox-nav lightbox-prev" data-ref="lbPrev" aria-label="上一个">‹</button>
    <button type="button" class="lightbox-nav lightbox-next" data-ref="lbNext" aria-label="下一个">›</button>
  </div>
</dialog>
`;

// ---------- 工具函数 ----------
function baseName(filename) {
  const name = filename.replace(/\.[^.]+$/, '') || 'image';
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

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function handlePoints(b) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = b.x + b.w, btm = b.y + b.h;
  return { nw: [b.x, b.y], n: [cx, b.y], ne: [r, b.y], e: [r, cy], se: [r, btm], s: [cx, btm], sw: [b.x, btm], w: [b.x, cy] };
}

export default {
  id: 'smart-slicer',
  name: '智能切图',
  description: '识别素材、调整裁切框并批量导出',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="11" width="4" height="6"/></svg>',

  mount(root) {
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);

    const state = {
      image: null, // { name, size, width, height }
      imageData: null,
      mask: null, // 最近一次识别的前景掩码，用于「贴合」
      bgMode: 'auto',
      bgColors: [], // 最近一次识别实际使用的背景色
      pickColors: [], // 「指定颜色」模式下的取色 '#rrggbb'
      boxes: [], // { id, x, y, w, h }，始终按阅读顺序
      nextId: 1,
      selected: new Set(), // 画布中选中的框（编辑用）
      unchecked: new Set(), // 不输出的框
      hoverId: null,
      edited: false, // 识别后是否手动修改过；修改过则参数变化不再自动覆盖
      pendingResult: false,
      forceApply: false,
      detecting: false,
      detectToken: 0,
      detectTimer: 0,
      stats: null, // { components, filtered } | { error }
      undo: [],
      redo: [],
      coalesce: null,
      mode: 'select',
      picking: false,
      drag: null,
      suppressClick: false,
      spaceDown: false,
      stageHover: false,
      lastChecked: -1,
      busy: false,
      overlayQueued: false,
      cards: new Map(), // id → { card, check, canvas, seqEl, sizeEl, posEl, key }
      lightbox: { id: null, url: null, token: 0, needsFit: false },
      loadToken: 0,
    };

    const zoom = createZoomView($.stage, $.wrap, {
      size: () => (state.image ? { w: state.image.width, h: state.image.height } : { w: 0, h: 0 }),
      shouldPan,
      onChange: () => scheduleOverlay(),
    });
    const lbZoom = createZoomView($.lbStage, $.lbImg);

    const findBox = (id) => state.boxes.find((b) => b.id === id);
    const selectedBoxes = () => state.boxes.filter((b) => state.selected.has(b.id));
    const snapshot = () => state.boxes.map((b) => ({ ...b }));
    const num = (input) => Number(input.value);

    // ---------- 识别（优先在 Worker 中运行，失败时退回主线程） ----------
    let worker = null;
    try {
      worker = new Worker(new URL('../workers/sprite-detect.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => onDetectResult(e.data);
      worker.onerror = (e) => {
        e.preventDefault?.();
        worker?.terminate();
        worker = null;
        if (state.detecting) runDetect();
      };
    } catch {
      worker = null;
    }

    function detectOptions() {
      return {
        mode: state.bgMode,
        colors: state.pickColors.map(hexToRgb),
        tolerance: num($.tolerance),
        merge: num($.merge),
        minSize: num($.minSize),
        pad: num($.pad),
      };
    }

    function scheduleDetect(delay = DETECT_DELAY) {
      clearTimeout(state.detectTimer);
      if (!state.imageData) return;
      state.detectTimer = setTimeout(runDetect, delay);
    }

    function runDetect() {
      clearTimeout(state.detectTimer);
      if (!state.imageData) return;
      const opts = detectOptions();
      const token = ++state.detectToken;
      if (opts.mode === 'color' && !opts.colors.length) {
        state.detecting = false;
        state.stats = { error: 'no-color' };
        refreshAll();
        return;
      }
      state.detecting = true;
      updatePlan();
      const { data, width, height } = state.imageData;
      if (worker) {
        const copy = data.slice();
        worker.postMessage({ token, buffer: copy.buffer, width, height, options: opts }, [copy.buffer]);
        return;
      }
      setTimeout(() => {
        if (token !== state.detectToken) return;
        let result;
        try {
          result = detectSprites(data, width, height, opts);
        } catch (err) {
          result = { error: err.message };
        }
        onDetectResult({ token, ...result });
      }, 30);
    }

    function onDetectResult(res) {
      if (res.token !== state.detectToken) return;
      state.detecting = false;
      if (res.mask) state.mask = res.mask;
      if (res.colors) state.bgColors = res.colors;
      if (res.error) {
        state.stats = { error: res.error };
        state.forceApply = false;
        refreshAll();
        return;
      }
      state.stats = { components: res.components, filtered: res.filtered, found: res.boxes.length };
      const apply = state.forceApply || !state.edited;
      state.forceApply = false;
      state.pendingResult = !apply;
      if (apply) {
        if (state.boxes.length) pushHistory(snapshot());
        state.boxes = res.boxes.map((b) => ({ id: state.nextId++, ...b }));
        state.selected.clear();
        state.unchecked.clear();
        state.lastChecked = -1;
        state.edited = false;
      }
      refreshAll();
    }

    // ---------- 加载图片 ----------
    // SVG 先按倍数渲染为位图用于显示和识别；选择 SVG 输出格式时从原始矢量内容裁切
    async function decodeFile(file) {
      if (!isSvg(file)) return { bmp: await createImageBitmap(file), vector: null };
      const info = await readSvg(file);
      const scale = resolveScale($.svgScale.value, info);
      return { bmp: await createImageBitmap(await rasterizeSvg(info, scale, file.name)), vector: { info, scale } };
    }

    function drawSource(bmp) {
      const { width, height } = bmp;
      $.canvas.width = width;
      $.canvas.height = height;
      const ctx = $.canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      state.imageData = ctx.getImageData(0, 0, width, height);
      $.wrap.style.width = `${width}px`;
      $.wrap.style.height = `${height}px`;
      $.imgW.textContent = width;
      $.imgH.textContent = height;
    }

    async function loadFile(file) {
      if (!file || !(file.type.startsWith('image/') || isSvg(file))) {
        toast('请选择图片文件');
        return;
      }
      if (state.edited && !confirm('更换图片会丢弃当前的框和手动修改，确定继续？')) return;
      const token = ++state.loadToken;
      let decoded;
      try {
        decoded = await decodeFile(file);
      } catch (err) {
        if (token === state.loadToken) toast(isSvg(file) ? `无法读取该矢量图：${err.message}` : '无法读取该图片');
        return;
      }
      const { bmp, vector } = decoded;
      if (token !== state.loadToken) {
        bmp.close();
        return;
      }
      const { width, height } = bmp;
      if (width * height > MAX_PIXELS_WITHOUT_CONFIRM
        && !confirm(`图片约 ${Math.round((width * height) / 1e6)} 百万像素，识别会占用较多内存和时间，确定继续？`)) {
        bmp.close();
        return;
      }
      drawSource(bmp);
      state.image = { name: file.name || 'image.png', size: file.size, width, height, vector };

      cancelDrag();
      setPicking(false);
      state.boxes = [];
      state.mask = null;
      state.selected.clear();
      state.unchecked.clear();
      state.undo = [];
      state.redo = [];
      state.edited = false;
      state.pendingResult = false;
      state.stats = null;
      for (const c of state.cards.values()) c.card.remove();
      state.cards.clear();

      $.fileMeta.textContent = `${state.image.name} · ${formatBytes(file.size)}${vector ? ' · SVG 矢量图' : ''}`;
      for (const el of [$.meta, $.toolbar, $.boxCount, $.stage, $.resultPanel, $.outputPanel]) el.hidden = false;
      $.dropStage.hidden = true;
      $.redetect.disabled = false;
      $.change.disabled = false;
      updateVectorUi();
      zoom.fit();
      refreshAll();
      state.forceApply = true;
      runDetect();
    }

    function updateVectorUi() {
      const v = state.image?.vector;
      $.svgField.hidden = !v;
      $.format.querySelector('option[value="svg"]').disabled = !v;
      if (!v && $.format.value === 'svg') $.format.value = 'png';
      if (v) {
        const { w, h } = rasterSize(v.info, v.scale);
        $.svgNote.textContent = `固有尺寸 ${Math.round(v.info.width)}×${Math.round(v.info.height)}，渲染为 ${w}×${h} 像素用于识别；框的坐标、合并距离等参数都按渲染后的像素计算`;
      }
      updateOutputPlan();
    }

    // 改变倍数：从原始 SVG 重新渲染，已有的框按比例换算保留；撤销历史基于旧分辨率，清空
    $.svgScale.addEventListener('change', async () => {
      const img = state.image;
      const v = img?.vector;
      if (!v) return;
      const scale = resolveScale($.svgScale.value, v.info);
      if (scale === v.scale) return;
      const token = ++state.loadToken;
      let bmp;
      try {
        bmp = await createImageBitmap(await rasterizeSvg(v.info, scale, img.name));
      } catch (err) {
        if (token === state.loadToken) toast(`矢量图渲染失败：${err.message}`);
        return;
      }
      if (token !== state.loadToken) {
        bmp.close();
        return;
      }
      cancelDrag();
      const { width, height } = bmp;
      const k = scale / v.scale;
      drawSource(bmp);
      for (const b of state.boxes) {
        const x = clamp(Math.round(b.x * k), 0, width - 1);
        const y = clamp(Math.round(b.y * k), 0, height - 1);
        b.w = clamp(Math.round((b.x + b.w) * k), x + 1, width) - x;
        b.h = clamp(Math.round((b.y + b.h) * k), y + 1, height) - y;
        b.x = x;
        b.y = y;
      }
      state.image = { ...img, width, height, vector: { info: v.info, scale } };
      state.mask = null;
      state.undo = [];
      state.redo = [];
      for (const c of state.cards.values()) c.key = ''; // 强制重绘缩略图
      updateVectorUi();
      zoom.fit();
      refreshAll();
      runDetect();
    });

    $.file.addEventListener('change', () => {
      loadFile($.file.files[0]);
      $.file.value = '';
    });
    $.change.addEventListener('click', () => $.file.click());

    for (const el of [$.dropStage, $.stage]) {
      el.addEventListener('dragover', (e) => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        el.classList.add('dragging');
      });
      el.addEventListener('dragleave', () => el.classList.remove('dragging'));
      el.addEventListener('drop', (e) => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        el.classList.remove('dragging');
        loadFile(e.dataTransfer.files[0]);
      });
    }

    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      if (item) loadFile(item.getAsFile());
    };
    document.addEventListener('paste', onPaste);

    // ---------- 背景与参数 ----------
    function setBgMode(mode) {
      state.bgMode = mode;
      for (const btn of root.querySelectorAll('[data-bg-mode]')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.bgMode === mode));
      }
      $.colorField.hidden = mode !== 'color';
      $.tolerance.disabled = mode === 'alpha';
      if (mode !== 'color') setPicking(false);
      scheduleDetect(0);
      updateBgInfo();
    }
    for (const btn of root.querySelectorAll('[data-bg-mode]')) {
      btn.addEventListener('click', () => setBgMode(btn.dataset.bgMode));
    }

    function updateBgInfo() {
      const info = $.bgInfo;
      info.replaceChildren();
      if (!state.image) return;
      if (state.bgMode === 'alpha') {
        info.textContent = '按透明度区分：透明像素为背景';
      } else if (state.bgMode === 'auto' && !state.detecting && state.stats) {
        if (!state.bgColors.length) {
          info.textContent = '自动识别为：透明背景';
        } else {
          const hex = rgbToHex(...state.bgColors[0]);
          const swatch = document.createElement('i');
          swatch.className = 'swatch';
          swatch.style.background = hex;
          const code = document.createElement('code');
          code.textContent = hex;
          info.append('自动识别为：', swatch, code);
        }
      }
    }

    for (const s of SLIDERS) {
      $[s.ref].addEventListener('input', () => {
        $[`${s.ref}Out`].textContent = `${$[s.ref].value}${s.unit}`;
        scheduleDetect();
        if (s.ref === 'tolerance') renderCards(); // 输出背景透明时缩略图依赖容差
      });
    }

    $.redetect.addEventListener('click', () => {
      state.forceApply = true;
      runDetect();
    });

    function renderColors() {
      if (!state.pickColors.length) {
        const empty = document.createElement('span');
        empty.className = 'empty-text';
        empty.textContent = '尚未选择背景颜色';
        $.colors.replaceChildren(empty);
        return;
      }
      $.colors.replaceChildren(...state.pickColors.map((hex) => {
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
          state.pickColors = state.pickColors.filter((c) => c !== hex);
          renderColors();
          scheduleDetect(0);
        });
        chip.append(swatch, code, remove);
        return chip;
      }));
    }

    function addColor(hex) {
      const value = hex.toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value)) return;
      if (state.pickColors.includes(value)) {
        toast(`颜色 ${value} 已添加`);
        return;
      }
      state.pickColors.push(value);
      renderColors();
      scheduleDetect(0);
    }

    function setPicking(on) {
      state.picking = on;
      $.picker.classList.toggle('is-active', on);
      $.picker.textContent = on ? '点击画布取色' : '吸管取色';
      $.hover.hidden = !on;
      if (on) setMode('select');
    }

    function sampleAt(p) {
      const { width, height, data } = state.imageData;
      const x = clamp(Math.floor(p.x), 0, width - 1);
      const y = clamp(Math.floor(p.y), 0, height - 1);
      const i = (y * width + x) * 4;
      return { hex: rgbToHex(data[i], data[i + 1], data[i + 2]), x, y };
    }

    $.picker.addEventListener('click', () => setPicking(!state.picking));
    $.manualColor.addEventListener('change', () => addColor($.manualColor.value));

    function updatePlan() {
      const plan = $.plan;
      plan.hidden = !state.image;
      const notes = [];
      if (!state.image) {
        plan.textContent = '请先上传图片';
      } else if (state.detecting) {
        plan.textContent = '识别中…';
      } else if (state.stats?.error === 'no-color') {
        plan.textContent = '请用吸管或取色器指定背景颜色';
      } else if (state.stats?.error === 'too-many') {
        plan.textContent = '前景区域过于零碎（超过 5 万块），可能没有正确识别背景';
        notes.push('请切换背景模式、指定背景颜色或调大容差');
      } else if (state.stats?.error) {
        plan.textContent = `识别失败：${state.stats.error}`;
      } else {
        plan.innerHTML = `当前 <b>${state.boxes.length}</b> 个框`;
        if (state.stats) notes.push(`本次识别出 ${state.stats.found} 个素材，过滤了 ${state.stats.filtered} 个噪点`);
        if (state.pendingResult) notes.push('已有手动修改，参数变化不会覆盖；点击「重新识别」应用新的识别结果（可撤销）');
      }
      for (const text of notes) {
        const span = document.createElement('span');
        span.className = 'plan-note';
        span.textContent = text;
        plan.append(span);
      }
      updateBgInfo();
    }

    // ---------- 撤销 / 重做 ----------
    function pushHistory(before, coalesceKey) {
      const now = performance.now();
      // 连续的同类操作（如方向键微调）合并为一步
      if (coalesceKey && state.coalesce?.key === coalesceKey && now - state.coalesce.at < 800) {
        state.coalesce.at = now;
        return;
      }
      state.coalesce = coalesceKey ? { key: coalesceKey, at: now } : null;
      state.undo.push(before);
      if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
      state.redo = [];
    }

    function commit(before, coalesceKey) {
      pushHistory(before, coalesceKey);
      state.edited = true;
      sortReading(state.boxes);
      refreshAll();
    }

    function restore(from, to) {
      if (!from.length) return;
      to.push(snapshot());
      state.boxes = from.pop();
      state.coalesce = null;
      state.edited = true;
      const ids = new Set(state.boxes.map((b) => b.id));
      for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
      refreshAll();
    }
    const undo = () => restore(state.undo, state.redo);
    const redo = () => restore(state.redo, state.undo);

    // ---------- 编辑操作 ----------
    function setMode(mode) {
      state.mode = mode;
      $.modeSelect.setAttribute('aria-pressed', String(mode === 'select'));
      $.modeDraw.setAttribute('aria-pressed', String(mode === 'draw'));
      if (mode === 'draw' && state.picking) setPicking(false);
      $.stage.style.cursor = mode === 'draw' ? 'crosshair' : '';
      scheduleOverlay();
    }

    function deleteSelected() {
      if (!state.selected.size) return;
      const before = snapshot();
      const n = state.selected.size;
      state.boxes = state.boxes.filter((b) => !state.selected.has(b.id));
      state.selected.clear();
      commit(before);
      toast(`已删除 ${n} 个框`);
    }

    function mergeSelected() {
      const sel = selectedBoxes();
      if (sel.length < 2) return;
      const before = snapshot();
      const x0 = Math.min(...sel.map((b) => b.x));
      const y0 = Math.min(...sel.map((b) => b.y));
      const x1 = Math.max(...sel.map((b) => b.x + b.w));
      const y1 = Math.max(...sel.map((b) => b.y + b.h));
      state.boxes = state.boxes.filter((b) => !state.selected.has(b.id));
      const merged = { id: state.nextId++, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      state.boxes.push(merged);
      state.selected = new Set([merged.id]);
      commit(before);
      toast(`已合并 ${sel.length} 个框`);
    }

    function fitSelected() {
      const sel = selectedBoxes();
      if (!sel.length) return;
      if (!state.mask) {
        toast('识别完成后才能贴合内容');
        return;
      }
      const before = snapshot();
      let changed = 0;
      let empty = 0;
      for (const b of sel) {
        const t = tightBox(state.mask, state.image.width, b);
        if (!t) empty++;
        else if (t.x !== b.x || t.y !== b.y || t.w !== b.w || t.h !== b.h) {
          Object.assign(b, t);
          changed++;
        }
      }
      if (changed) commit(before);
      toast(empty ? `已贴合 ${changed} 个框，${empty} 个框内没有素材像素` : changed ? `已贴合 ${changed} 个框` : '选中的框已经贴合素材边缘');
    }

    function nudge(dx, dy) {
      const sel = selectedBoxes();
      if (!sel.length) return;
      const before = snapshot();
      const { width, height } = state.image;
      dx = clamp(dx, -Math.min(...sel.map((b) => b.x)), width - Math.max(...sel.map((b) => b.x + b.w)));
      dy = clamp(dy, -Math.min(...sel.map((b) => b.y)), height - Math.max(...sel.map((b) => b.y + b.h)));
      if (!dx && !dy) return;
      for (const b of sel) {
        b.x += dx;
        b.y += dy;
      }
      commit(before, 'nudge');
    }

    function selectOnly(ids) {
      state.selected = new Set(ids);
      refreshSelection();
    }

    $.modeSelect.addEventListener('click', () => setMode('select'));
    $.modeDraw.addEventListener('click', () => setMode('draw'));
    $.mergeSelected.addEventListener('click', mergeSelected);
    $.fit.addEventListener('click', fitSelected);
    $.del.addEventListener('click', deleteSelected);
    $.undo.addEventListener('click', undo);
    $.redo.addEventListener('click', redo);

    // 选中框的精确数值
    function updateBoxFields() {
      const sel = selectedBoxes();
      $.boxFields.hidden = sel.length !== 1;
      if (sel.length !== 1) return;
      const b = sel[0];
      for (const [ref, v] of [['bx', b.x], ['by', b.y], ['bw', b.w], ['bh', b.h]]) {
        if (document.activeElement !== $[ref]) $[ref].value = v;
      }
    }

    for (const ref of ['bx', 'by', 'bw', 'bh']) {
      $[ref].addEventListener('change', () => {
        const b = selectedBoxes()[0];
        if (!b) return;
        const { width, height } = state.image;
        const before = snapshot();
        const x = clamp(Math.round(num($.bx)) || 0, 0, width - 1);
        const y = clamp(Math.round(num($.by)) || 0, 0, height - 1);
        const w = clamp(Math.round(num($.bw)) || 1, 1, width - x);
        const h = clamp(Math.round(num($.bh)) || 1, 1, height - y);
        if (x === b.x && y === b.y && w === b.w && h === b.h) {
          updateBoxFields();
          return;
        }
        Object.assign(b, { x, y, w, h });
        $[ref].blur();
        commit(before);
      });
    }

    // ---------- 画布交互 ----------
    function toImage(e) {
      const r = $.wrap.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) * state.image.width) / r.width,
        y: ((e.clientY - r.top) * state.image.height) / r.height,
      };
    }

    function clampPoint(p) {
      return { x: clamp(Math.round(p.x), 0, state.image.width), y: clamp(Math.round(p.y), 0, state.image.height) };
    }

    function rectFrom(a, b) {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, w: Math.max(a.x, b.x) - x, h: Math.max(a.y, b.y) - y };
    }

    // 命中的框：取包含该点的面积最小的框，便于选中嵌套 / 重叠中的小框
    function hitBox(p) {
      const tol = HIT_SCREEN / zoom.getScale();
      let best = null;
      for (const b of state.boxes) {
        if (p.x < b.x - tol || p.x > b.x + b.w + tol || p.y < b.y - tol || p.y > b.y + b.h + tol) continue;
        if (!best || b.w * b.h < best.w * best.h) best = b;
      }
      return best;
    }

    function hitHandle(p) {
      if (state.mode !== 'select' || state.selected.size !== 1) return null;
      const b = selectedBoxes()[0];
      if (!b) return null;
      const r = (HANDLE_SCREEN / 2 + 2) / zoom.getScale();
      for (const [name, [hx, hy]] of Object.entries(handlePoints(b))) {
        if (Math.abs(p.x - hx) <= r && Math.abs(p.y - hy) <= r) return name;
      }
      return null;
    }

    // 交给 zoom.js 平移的情况：中键、空格、取色中，或选择模式下按在空白处（未按 Shift）
    function shouldPan(e) {
      if (!state.image) return false;
      if (e.button === 1 || state.spaceDown || state.picking) return true;
      if (state.mode === 'draw' || e.shiftKey) return false;
      const p = toImage(e);
      return !hitHandle(p) && !hitBox(p);
    }

    function startDrag(drag, e) {
      state.suppressClick = true;
      state.drag = { ...drag, before: snapshot(), moved: false, sx: e.clientX, sy: e.clientY };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragEnd);
    }

    function stopDragListeners() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragEnd);
    }

    function cancelDrag() {
      const d = state.drag;
      if (!d) return;
      state.drag = null;
      stopDragListeners();
      state.boxes = d.before;
      refreshAll();
    }

    $.stage.addEventListener('pointerdown', (e) => {
      if (e.button === 0) state.suppressClick = false;
      if (!state.image || e.button !== 0 || state.spaceDown || state.picking || e.target.closest('button')) return;
      $.stage.focus({ preventScroll: true });
      const p = toImage(e);
      if (state.mode === 'draw') {
        startDrag({ type: 'draw', start: clampPoint(p) }, e);
        return;
      }
      const handle = hitHandle(p);
      if (handle) {
        const b = selectedBoxes()[0];
        startDrag({ type: 'resize', handle, id: b.id, orig: { ...b } }, e);
        return;
      }
      const box = hitBox(p);
      if (box) {
        state.suppressClick = true;
        if (e.shiftKey) {
          if (state.selected.has(box.id)) state.selected.delete(box.id);
          else state.selected.add(box.id);
          refreshSelection();
          if (!state.selected.has(box.id)) return;
        } else if (!state.selected.has(box.id)) {
          selectOnly([box.id]);
        }
        const orig = new Map(selectedBoxes().map((b) => [b.id, { ...b }]));
        startDrag({ type: 'move', start: p, clickedId: box.id, shift: e.shiftKey, orig }, e);
        return;
      }
      if (e.shiftKey) startDrag({ type: 'marquee', start: clampPoint(p) }, e);
    });

    function onDragMove(e) {
      const d = state.drag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      const { width, height } = state.image;
      const p = toImage(e);
      if (d.type === 'move') {
        const orig = [...d.orig.values()];
        const dx = clamp(Math.round(p.x - d.start.x), -Math.min(...orig.map((o) => o.x)), width - Math.max(...orig.map((o) => o.x + o.w)));
        const dy = clamp(Math.round(p.y - d.start.y), -Math.min(...orig.map((o) => o.y)), height - Math.max(...orig.map((o) => o.y + o.h)));
        for (const b of state.boxes) {
          const o = d.orig.get(b.id);
          if (o) {
            b.x = o.x + dx;
            b.y = o.y + dy;
          }
        }
      } else if (d.type === 'resize') {
        const b = findBox(d.id);
        const o = d.orig;
        let l = o.x, t = o.y, r = o.x + o.w, btm = o.y + o.h;
        const px = Math.round(p.x), py = Math.round(p.y);
        if (d.handle.includes('w')) l = clamp(px, 0, r - 1);
        if (d.handle.includes('e')) r = clamp(px, l + 1, width);
        if (d.handle.includes('n')) t = clamp(py, 0, btm - 1);
        if (d.handle.includes('s')) btm = clamp(py, t + 1, height);
        Object.assign(b, { x: l, y: t, w: r - l, h: btm - t });
      } else {
        d.rect = rectFrom(d.start, clampPoint(p));
      }
      scheduleOverlay();
      updateBoxFields();
    }

    function onDragEnd() {
      const d = state.drag;
      if (!d) return;
      state.drag = null;
      stopDragListeners();
      // 点选已按按下时命中的框处理，不能再由 click 按重排后的坐标取消选中。
      state.suppressClick = true;
      if (d.type === 'move' || d.type === 'resize') {
        if (d.moved) {
          commit(d.before);
        } else if (d.type === 'move' && !d.shift) {
          // 单击框（未拖动）：只选中它，并在结果列表中定位对应卡片
          selectOnly([d.clickedId]);
          revealCard(d.clickedId);
        }
      } else if (d.type === 'draw') {
        if (d.rect && d.rect.w >= 2 && d.rect.h >= 2) {
          const b = { id: state.nextId++, ...d.rect };
          state.boxes.push(b);
          state.selected = new Set([b.id]);
          commit(d.before);
          revealCard(b.id);
        } else {
          scheduleOverlay();
        }
      } else if (d.type === 'marquee') {
        if (d.rect) for (const b of state.boxes) if (intersects(b, d.rect)) state.selected.add(b.id);
        refreshSelection();
      }
    }

    $.stage.addEventListener('click', (e) => {
      if (!state.image || e.target.closest('button')) return;
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      const p = toImage(e);
      if (state.picking) {
        addColor(sampleAt(p).hex);
        if (!e.shiftKey) setPicking(false); // 按住 Shift 可连续取色
        return;
      }
      if (state.mode === 'select' && !e.shiftKey && state.selected.size && !hitBox(p) && !hitHandle(p)) {
        selectOnly([]);
      }
    });

    $.stage.addEventListener('pointermove', (e) => {
      if (!state.image || state.drag) return;
      if ($.stage.classList.contains('panning')) {
        $.stage.style.cursor = '';
        return;
      }
      const p = toImage(e);
      let cursor = '';
      let hover = null;
      if (state.spaceDown) {
        cursor = 'grab';
      } else if (state.picking) {
        cursor = 'crosshair';
        const s = sampleAt(p);
        $.hoverSwatch.style.background = s.hex;
        $.hoverHex.textContent = s.hex;
        $.hoverPos.textContent = `(${s.x}, ${s.y})`;
      } else if (state.mode === 'draw') {
        cursor = 'crosshair';
      } else {
        const handle = hitHandle(p);
        if (handle) {
          cursor = HANDLE_CURSOR[handle];
        } else {
          const b = hitBox(p);
          if (b) {
            cursor = 'move';
            hover = b.id;
          }
        }
      }
      $.stage.style.cursor = cursor;
      setHover(hover);
    });
    $.stage.addEventListener('pointerenter', () => (state.stageHover = true));
    $.stage.addEventListener('pointerleave', () => {
      state.stageHover = false;
      setHover(null);
    });

    function setHover(id) {
      if (state.hoverId === id) return;
      state.cards.get(state.hoverId)?.card.classList.remove('ss-hover');
      state.hoverId = id;
      state.cards.get(id)?.card.classList.add('ss-hover');
      scheduleOverlay();
    }

    // ---------- 叠加层（SVG，坐标为原图像素；线宽、手柄、序号按缩放反算保持屏幕尺寸不变） ----------
    function scheduleOverlay() {
      if (state.overlayQueued) return;
      state.overlayQueued = true;
      requestAnimationFrame(renderOverlay);
    }

    function renderOverlay() {
      state.overlayQueued = false;
      if (!state.image) {
        $.overlay.innerHTML = '';
        return;
      }
      const s = zoom.getScale();
      const { width, height } = state.image;
      $.overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const parts = [];
      state.boxes.forEach((b, i) => {
        const cls = ['ss-box'];
        if (state.selected.has(b.id)) cls.push('is-selected');
        if (state.hoverId === b.id) cls.push('is-hover');
        if (state.unchecked.has(b.id)) cls.push('is-excluded');
        const geo = `x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"`;
        parts.push(`<g class="${cls.join(' ')}"><rect class="ss-box-back" ${geo}/><rect class="ss-box-line" ${geo}/>`);
        if (Math.min(b.w, b.h) * s >= LABEL_MIN_SCREEN) {
          parts.push(`<text class="ss-label" x="${b.x + 3 / s}" y="${b.y + 3 / s}" font-size="${11 / s}" stroke-width="${3 / s}">${i + 1}</text>`);
        }
        parts.push('</g>');
      });
      const moving = state.drag?.type === 'move' && state.drag.moved;
      if (state.mode === 'select' && state.selected.size === 1 && !moving) {
        const b = selectedBoxes()[0];
        const hs = HANDLE_SCREEN / s;
        if (b) {
          for (const [hx, hy] of Object.values(handlePoints(b))) {
            parts.push(`<rect class="ss-handle" x="${hx - hs / 2}" y="${hy - hs / 2}" width="${hs}" height="${hs}"/>`);
          }
        }
      }
      const r = state.drag?.rect;
      if (r) parts.push(`<rect class="ss-draft" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
      $.overlay.innerHTML = parts.join('');
    }

    // ---------- 快捷键 ----------
    const onKeydown = (e) => {
      if (!state.image || $.lightbox.open) return;
      const inField = e.target.closest?.('input, select, textarea');
      if (e.key === ' ' && state.stageHover && !inField) {
        e.preventDefault(); // 空格 + 拖拽平移，阻止页面滚动
        if (!state.spaceDown) {
          state.spaceDown = true;
          $.stage.style.cursor = 'grab';
        }
        return;
      }
      if (inField) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && key === 'a' && (state.stageHover || document.activeElement === $.stage)) {
        e.preventDefault();
        selectOnly(state.boxes.map((b) => b.id));
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') {
        if (state.drag) cancelDrag();
        else if (state.picking) setPicking(false);
        else if (state.mode === 'draw') setMode('select');
        else if (state.selected.size) selectOnly([]);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selected.size) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (e.key.startsWith('Arrow') && state.selected.size && !state.drag) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        nudge(dx, dy);
        return;
      }
      if (key === 'v') setMode('select');
      else if (key === 'r') setMode('draw');
      else if (key === 'm') mergeSelected();
      else if (key === 'f') fitSelected();
    };
    const onKeyup = (e) => {
      if (e.key === ' ' && state.spaceDown) {
        state.spaceDown = false;
        $.stage.style.cursor = state.mode === 'draw' ? 'crosshair' : '';
      }
    };
    const onBlur = () => {
      state.spaceDown = false;
    };
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    window.addEventListener('blur', onBlur);

    // ---------- 界面刷新 ----------
    function refreshSelection() {
      scheduleOverlay();
      updateToolbar();
      updateBoxFields();
      for (const [id, c] of state.cards) c.card.classList.toggle('ss-active', state.selected.has(id));
    }

    function updateToolbar() {
      const n = state.selected.size;
      $.boxCount.textContent = `${state.boxes.length} 个框${n ? ` · 选中 ${n} 个` : ''}`;
      $.mergeSelected.disabled = n < 2;
      $.fit.disabled = !n;
      $.del.disabled = !n;
      $.undo.disabled = !state.undo.length;
      $.redo.disabled = !state.redo.length;
    }

    function refreshAll() {
      updatePlan();
      renderCards();
      refreshSelection();
    }

    // ---------- 结果卡片 ----------
    function outputBoxes() {
      return state.boxes.filter((b) => !state.unchecked.has(b.id));
    }

    // 背景透明输出时的去背景参数；alpha 模式或透明背景无需处理时返回 null
    function transparentParams() {
      if ($.format.value === 'svg' || $.outBg.value !== 'transparent' || !state.bgColors.length) return null;
      return { colors: state.bgColors, tolerance: num($.tolerance), feather: num($.feather) };
    }

    function transKey() {
      const t = transparentParams();
      return t ? `${t.colors.join(';')}|${t.tolerance}|${t.feather}` : '';
    }

    function drawThumb(canvas, b, params) {
      const s = Math.min(THUMB_MAX_UPSCALE, THUMB_MAX / Math.max(b.w, b.h));
      canvas.width = Math.max(1, Math.round(b.w * s));
      canvas.height = Math.max(1, Math.round(b.h * s));
      const ctx = canvas.getContext('2d', { willReadFrequently: Boolean(params) });
      ctx.imageSmoothingEnabled = s < 1; // 小素材放大时保持像素清晰
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage($.canvas, b.x, b.y, b.w, b.h, 0, 0, canvas.width, canvas.height);
      if (params) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        removeBackground(img.data, params);
        ctx.putImageData(img, 0, 0);
      }
    }

    function createCard(b) {
      const card = document.createElement('div');
      card.className = 'tile selected';
      card.dataset.id = b.id;
      card.innerHTML = `
        <input type="checkbox" class="tile-check" checked>
        <div class="tile-actions">
          <button type="button" class="tile-action" data-action="locate" title="在画布中定位" aria-label="在画布中定位">${ICON_LOCATE}</button>
          <button type="button" class="tile-action" data-action="zoom" title="放大预览" aria-label="放大预览">${ICON_ZOOM}</button>
          <button type="button" class="tile-action" data-action="download" title="下载此图" aria-label="下载此图">${ICON_DOWNLOAD}</button>
          <button type="button" class="tile-action" data-action="remove" title="删除此框" aria-label="删除此框">${ICON_REMOVE}</button>
        </div>
        <div class="tile-thumb"><canvas></canvas></div>
        <div class="tile-meta">
          <span class="badge" data-role="seq"></span>
          <span class="tile-pos" data-role="size"></span>
          <span class="tile-size" data-role="pos"></span>
        </div>`;
      card.addEventListener('mouseenter', () => setHover(b.id));
      card.addEventListener('mouseleave', () => setHover(null));
      const c = {
        card,
        check: card.querySelector('.tile-check'),
        canvas: card.querySelector('canvas'),
        seqEl: card.querySelector('[data-role="seq"]'),
        sizeEl: card.querySelector('[data-role="size"]'),
        posEl: card.querySelector('[data-role="pos"]'),
        key: '',
      };
      state.cards.set(b.id, c);
      return c;
    }

    // 复用已有卡片，只在框的位置尺寸或透明参数变化时重绘缩略图
    function renderCards() {
      const live = new Set();
      const params = transparentParams();
      const tkey = transKey();
      state.boxes.forEach((b, i) => {
        live.add(b.id);
        const c = state.cards.get(b.id) || createCard(b);
        const checked = !state.unchecked.has(b.id);
        c.seqEl.textContent = `#${i + 1}`;
        c.sizeEl.textContent = `${b.w} × ${b.h}`;
        c.posEl.textContent = `(${b.x}, ${b.y})`;
        c.check.checked = checked;
        c.check.setAttribute('aria-label', `输出第 ${i + 1} 个素材`);
        c.card.classList.toggle('selected', checked);
        c.card.classList.toggle('ss-active', state.selected.has(b.id));
        c.card.classList.toggle('ss-hover', state.hoverId === b.id);
        const key = `${b.x},${b.y},${b.w},${b.h}|${tkey}`;
        if (c.key !== key) {
          drawThumb(c.canvas, b, params);
          c.key = key;
        }
      });
      for (const [id, c] of state.cards) {
        if (!live.has(id)) {
          c.card.remove();
          state.cards.delete(id);
        }
      }
      $.tiles.append(...state.boxes.map((b) => state.cards.get(b.id).card));
      $.tilesEmpty.hidden = state.boxes.length > 0 || !state.image;
      const n = outputBoxes().length;
      $.count.textContent = `共 ${state.boxes.length} 个 · 已选 ${n} 个`;
      updateOutputPlan();
      scheduleOverlay();
    }

    // 只在结果网格内部滚动到卡片并闪烁，不滚动整个页面
    function revealCard(id) {
      const c = state.cards.get(id);
      if (!c) return;
      const tr = $.tiles.getBoundingClientRect();
      const cr = c.card.getBoundingClientRect();
      if (cr.top < tr.top || cr.bottom > tr.bottom) {
        $.tiles.scrollBy({ top: cr.top - tr.top - tr.height / 2 + cr.height / 2, behavior: 'smooth' });
      }
      c.card.classList.remove('ss-flash');
      void c.card.offsetWidth;
      c.card.classList.add('ss-flash');
    }

    function locate(b) {
      setMode('select');
      selectOnly([b.id]);
      zoom.showRect(b);
      $.detectPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function removeBox(b) {
      const before = snapshot();
      state.boxes = state.boxes.filter((x) => x.id !== b.id);
      state.selected.delete(b.id);
      commit(before);
    }

    $.tiles.addEventListener('click', (e) => {
      const card = e.target.closest('.tile');
      if (!card) return;
      const id = Number(card.dataset.id);
      const index = state.boxes.findIndex((b) => b.id === id);
      const b = state.boxes[index];
      if (!b) return;
      const action = e.target.closest('.tile-action')?.dataset.action;
      if (action === 'locate') return locate(b);
      if (action === 'zoom') return openLightbox(index);
      if (action === 'download') return downloadBox(b);
      if (action === 'remove') return removeBox(b);
      // 直接点复选框时其状态已被浏览器切换
      const c = state.cards.get(id);
      const value = e.target === c.check ? c.check.checked : state.unchecked.has(id);
      const setChecked = (box) => (value ? state.unchecked.delete(box.id) : state.unchecked.add(box.id));
      if (e.shiftKey && state.lastChecked >= 0 && state.lastChecked !== index && state.lastChecked < state.boxes.length) {
        const from = Math.min(state.lastChecked, index);
        const to = Math.max(state.lastChecked, index);
        for (let i = from; i <= to; i++) setChecked(state.boxes[i]);
      } else {
        setChecked(b);
      }
      state.lastChecked = index;
      renderCards();
    });

    function setAllChecked(fn) {
      for (const b of state.boxes) {
        if (fn(b)) state.unchecked.delete(b.id);
        else state.unchecked.add(b.id);
      }
      renderCards();
    }
    $.selAll.addEventListener('click', () => setAllChecked(() => true));
    $.selNone.addEventListener('click', () => setAllChecked(() => false));
    $.selInvert.addEventListener('click', () => setAllChecked((b) => state.unchecked.has(b.id)));

    // ---------- 输出 ----------
    function frameSize(list) {
      if ($.uniform.value === 'none' || !list.length) return null;
      return { w: Math.max(...list.map((b) => b.w)), h: Math.max(...list.map((b) => b.h)) };
    }

    async function renderOutput(b, frame, params) {
      let dx = 0;
      let dy = 0;
      if (frame) {
        dx = Math.floor((frame.w - b.w) / 2);
        dy = $.uniform.value === 'bottom' ? frame.h - b.h : Math.floor((frame.h - b.h) / 2);
      }
      if ($.format.value === 'svg') {
        const v = state.image.vector;
        return { blob: cropSvg(v.info, v.scale, b, frame ? { ...frame, dx, dy } : null), dx, dy };
      }
      const crop = createCanvas(b.w, b.h);
      const ctx = crop.getContext('2d', { willReadFrequently: Boolean(params) });
      ctx.drawImage($.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      if (params) {
        const img = ctx.getImageData(0, 0, b.w, b.h);
        removeBackground(img.data, params);
        ctx.putImageData(img, 0, 0);
      }
      let out = crop;
      if (frame) {
        out = createCanvas(frame.w, frame.h);
        out.getContext('2d').drawImage(crop, dx, dy);
      }
      const blob = await canvasToBlob(out, FORMATS[$.format.value].mime, 0.92);
      return { blob, dx, dy };
    }

    function outputName(b, seq, digits) {
      return `${baseName(state.image.name)}_${String(seq).padStart(digits, '0')}_${b.w}x${b.h}.${FORMATS[$.format.value].ext}`;
    }

    // 按输出列表中的位置编号；未勾选的单张下载按全部框中的位置编号
    function seqOf(b) {
      const list = outputBoxes();
      const i = list.indexOf(b);
      return i >= 0
        ? { seq: i + 1, digits: Math.max(2, String(list.length).length) }
        : { seq: state.boxes.indexOf(b) + 1, digits: Math.max(2, String(state.boxes.length).length) };
    }

    async function buildOutputs(list, button, task) {
      const frame = frameSize(list);
      const params = transparentParams();
      const digits = Math.max(2, String(list.length).length);
      const files = [];
      const sprites = [];
      const label = button.textContent;
      try {
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          const out = await renderOutput(b, frame, params);
          const name = outputName(b, i + 1, digits);
          files.push({ name, blob: out.blob });
          sprites.push({ name, x: b.x, y: b.y, w: b.w, h: b.h, ...(frame ? { offsetX: out.dx, offsetY: out.dy } : {}) });
          button.textContent = `生成中 ${i + 1}/${list.length}`;
          task.update(i + 1, list.length, '正在生成图片');
          if (i % 8 === 7) await nextTick();
        }
      } finally {
        button.textContent = label;
      }
      return { files, sprites, frame };
    }

    function jsonFile(result) {
      const data = {
        image: state.image.name,
        width: state.image.width,
        height: state.image.height,
        frameSize: result.frame,
        sprites: result.sprites,
      };
      return {
        name: `${baseName(state.image.name)}_sprites.json`,
        blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      };
    }

    function updateOutputPlan() {
      const list = outputBoxes();
      const n = list.length;
      const frame = frameSize(list);
      const svgOut = $.format.value === 'svg';
      $.outBg.disabled = svgOut;
      $.feather.disabled = svgOut || $.outBg.value !== 'transparent';
      if (!state.image || !n) {
        $.outPlan.textContent = '请在上方勾选需要输出的素材';
      } else {
        $.outPlan.innerHTML = `已选 <b>${n}</b> 个素材，按阅读顺序编号`
          + (frame ? ` · 统一尺寸 <b>${frame.w}×${frame.h}</b> px` : '');
        const notes = [];
        if (svgOut) {
          notes.push('输出保留矢量的 SVG：每个文件包含完整的原图内容，通过 viewBox 只显示素材区域；「背景透明」不适用，原图中的背景元素会保留');
        } else if ($.outBg.value === 'transparent') {
          notes.push(state.bgColors.length
            ? `将去除背景色 ${state.bgColors.map((c) => rgbToHex(...c)).join('、')}（容差与识别一致）`
            : '背景本身已是透明，无需额外处理');
        }
        if ($.json.checked) notes.push(`另附坐标文件 ${baseName(state.image.name)}_sprites.json`);
        for (const text of notes) {
          const span = document.createElement('span');
          span.className = 'plan-note';
          span.textContent = text;
          $.outPlan.append(span);
        }
      }
      for (const btn of [$.save, $.zip, $.toBatch]) btn.disabled = !n || state.busy;
      $.save.textContent = `保存选中到本地 (${n})`;
    }

    for (const el of [$.uniform, $.json]) el.addEventListener('change', updateOutputPlan);
    $.format.addEventListener('change', renderCards); // SVG 输出不做背景透明，缩略图随之变化
    $.outBg.addEventListener('change', renderCards);
    $.feather.addEventListener('input', () => {
      $.featherOut.textContent = $.feather.value;
      renderCards();
    });

    function setBusy(on) {
      state.busy = on;
      updateOutputPlan();
    }

    async function downloadBox(b) {
      try {
        const list = outputBoxes();
        const out = await renderOutput(b, frameSize(list.includes(b) ? list : [b]), transparentParams());
        const { seq, digits } = seqOf(b);
        downloadBlob(out.blob, outputName(b, seq, digits));
      } catch (err) {
        toast(`保存失败：${err.message}`);
      }
    }

    async function saveSelected(asZip) {
      const list = outputBoxes();
      if (!list.length || state.busy) return;
      const dir = asZip ? null : await pickFolder('smart-slicer');
      if (dir === undefined) return;
      const button = asZip ? $.zip : $.save;
      setBusy(true);
      const task = startProgress('正在生成图片', list.length);
      try {
        const result = await buildOutputs(list, button, task);
        const files = $.json.checked ? [...result.files, jsonFile(result)] : result.files;
        await writeFiles(files, {
          dir,
          zipName: `${baseName(state.image.name)}_sprites.zip`,
          task,
          summary: `${result.files.length} 个素材${$.json.checked ? '和坐标 JSON' : ''}`,
        });
      } catch (err) {
        task.fail(`保存失败：${err.message}`);
      } finally {
        setBusy(false);
      }
    }

    $.save.addEventListener('click', () => saveSelected(false));
    $.zip.addEventListener('click', () => saveSelected(true));

    $.toBatch.addEventListener('click', async () => {
      const list = outputBoxes();
      if (!list.length || state.busy) return;
      setBusy(true);
      const task = startProgress('正在生成图片', list.length);
      let result;
      try {
        result = await buildOutputs(list, $.toBatch, task);
      } catch (err) {
        task.fail(`生成失败：${err.message}`);
        setBusy(false);
        return;
      }
      setBusy(false);
      task.finish(`已发送 ${result.files.length} 个素材到图片批处理`);
      // 切换工具会卸载本工具，图片批处理在挂载时取走这些文件
      handoff('image-batch', result.files.map((f) => new File([f.blob], f.name, { type: f.blob.type })));
    });

    // ---------- 放大预览 ----------
    function updateLightboxHeader() {
      const index = state.boxes.findIndex((b) => b.id === state.lightbox.id);
      const b = state.boxes[index];
      if (!b) return;
      const checked = !state.unchecked.has(b.id);
      $.lbTitle.textContent = `第 ${index + 1} / ${state.boxes.length} 个`;
      $.lbMeta.textContent = `${b.w}×${b.h}`;
      $.lbName.textContent = `原图位置 (${b.x}, ${b.y})`;
      $.lbPrev.disabled = index === 0;
      $.lbNext.disabled = index === state.boxes.length - 1;
      $.lbSelect.textContent = checked ? '✓ 已勾选输出' : '勾选输出';
      $.lbSelect.classList.toggle('btn-primary', checked);
    }

    async function showLightboxBox(index) {
      const b = state.boxes[index];
      if (!b) return;
      const lb = state.lightbox;
      lb.id = b.id;
      const token = ++lb.token;
      updateLightboxHeader();
      let out;
      try {
        const list = outputBoxes();
        out = await renderOutput(b, frameSize(list.includes(b) ? list : [b]), transparentParams());
      } catch (err) {
        toast(`预览失败：${err.message}`);
        return;
      }
      if (token !== lb.token || !$.lightbox.open) return;
      const url = URL.createObjectURL(out.blob);
      $.lbImg.src = url;
      if (lb.url) URL.revokeObjectURL(lb.url);
      lb.url = url;
    }

    function openLightbox(index) {
      if (!$.lightbox.open) {
        state.lightbox.needsFit = true;
        $.lightbox.showModal();
      }
      showLightboxBox(index);
    }

    function stepLightbox(delta) {
      const next = state.boxes.findIndex((b) => b.id === state.lightbox.id) + delta;
      if (next >= 0 && next < state.boxes.length) showLightboxBox(next);
    }

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
      const b = findBox(state.lightbox.id);
      if (b) downloadBox(b);
    });
    $.lbSelect.addEventListener('click', () => {
      const b = findBox(state.lightbox.id);
      if (!b) return;
      if (state.unchecked.has(b.id)) state.unchecked.delete(b.id);
      else state.unchecked.add(b.id);
      renderCards();
      updateLightboxHeader();
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
      lb.id = null;
      $.lbImg.removeAttribute('src');
      if (lb.url) URL.revokeObjectURL(lb.url);
      lb.url = null;
    });

    renderColors();
    updatePlan();
    updateVectorUi();

    // ---------- 卸载 ----------
    return () => {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('keyup', onKeyup);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('blur', onBlur);
      stopDragListeners();
      clearTimeout(state.detectTimer);
      state.detectToken++;
      state.loadToken++;
      worker?.terminate();
      zoom.destroy();
      lbZoom.destroy();
      if ($.lightbox.open) $.lightbox.close();
    };
  },
};
