import { createZoomView } from '../lib/zoom.js';
import { collectRefs, downloadBlob, toast } from '../lib/ui.js';
import { isSvg, rasterizeSvg, readSvg, resolveScale } from '../lib/vector.js';

// 常见屏幕：w × h 为物理分辨率（电脑横屏、平板 / 手机竖屏），dpr 为设备像素比（逻辑像素 = 物理 / dpr）
const PRESETS = [
  { group: '电脑', items: [
    { id: 'fhd', name: '1080p 全高清', w: 1920, h: 1080, dpr: 1 },
    { id: 'qhd', name: '2K QHD', w: 2560, h: 1440, dpr: 1 },
    { id: 'uhd', name: '4K UHD', w: 3840, h: 2160, dpr: 1 },
    { id: 'hd-laptop', name: '笔记本 1366×768', w: 1366, h: 768, dpr: 1 },
    { id: 'wxga', name: '笔记本 1440×900', w: 1440, h: 900, dpr: 1 },
    { id: 'win-125', name: 'Windows 笔记本 1080p（125% 缩放）', w: 1920, h: 1080, dpr: 1.25 },
    { id: 'mba13', name: 'MacBook Air 13"', w: 2560, h: 1664, dpr: 2 },
    { id: 'mbp14', name: 'MacBook Pro 14"', w: 3024, h: 1964, dpr: 2 },
    { id: 'ultrawide', name: '带鱼屏 3440×1440', w: 3440, h: 1440, dpr: 1 },
  ] },
  { group: '平板', items: [
    { id: 'ipad', name: 'iPad 10.9"', w: 1640, h: 2360, dpr: 2 },
    { id: 'ipad-mini', name: 'iPad mini', w: 1488, h: 2266, dpr: 2 },
    { id: 'ipad-pro11', name: 'iPad Pro 11"', w: 1668, h: 2388, dpr: 2 },
    { id: 'ipad-pro13', name: 'iPad Pro 12.9"', w: 2048, h: 2732, dpr: 2 },
    { id: 'tab-s9', name: 'Galaxy Tab S9', w: 1600, h: 2560, dpr: 2 },
  ] },
  { group: '手机', items: [
    { id: 'iphone15', name: 'iPhone 15 / 15 Pro', w: 1179, h: 2556, dpr: 3 },
    { id: 'iphone15max', name: 'iPhone 15 Pro Max', w: 1290, h: 2796, dpr: 3 },
    { id: 'iphone13mini', name: 'iPhone 13 mini', w: 1080, h: 2340, dpr: 2.88 }, // 逻辑 375×812，渲染后缩小显示
    { id: 'iphone-se', name: 'iPhone SE', w: 750, h: 1334, dpr: 2 },
    { id: 'galaxy-s24', name: 'Galaxy S24', w: 1080, h: 2340, dpr: 3 },
    { id: 'pixel8', name: 'Pixel 8', w: 1080, h: 2400, dpr: 2.625 },
    { id: 'android-fhd', name: '常见安卓 1080×1920', w: 1080, h: 1920, dpr: 3 },
  ] },
  { group: '其他', items: [
    { id: 'hd', name: '720p', w: 1280, h: 720, dpr: 1 },
    { id: 'square', name: '正方形 1080×1080', w: 1080, h: 1080, dpr: 1 },
    { id: 'story', name: '竖版视频 1080×1920', w: 1080, h: 1920, dpr: 1 },
  ] },
];
const PRESET_MAP = new Map(PRESETS.flatMap((g) => g.items.map((p) => [p.id, p])));
const DEFAULT_PRESET = 'fhd';
const STORAGE_KEY = 'devtool-screen-preview';
const MAX_SCREEN = 8192;
const SVG_RENDER_SCALE = 4; // SVG 素材按 4 倍渲染，放大摆放时依然清晰
const COVER_MAX = 480; // 计算覆盖率时的采样画布长边
const HISTORY_LIMIT = 100;
const HANDLE_SCREEN = 9;
const SNAP_SCREEN = 6; // 吸附距离（屏幕像素）
const DRAG_THRESHOLD = 3;
const HANDLE_CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

const TEMPLATE = `
<section class="panel">
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">1. 选择屏幕</h2>
      <span class="badge" data-ref="screenBadge"></span>
    </div>
  </div>
  <div class="export-grid sp-screen-fields">
    <label class="field sp-device-field">设备 / 分辨率
      <select data-ref="preset">
        ${PRESETS.map((g) => `<optgroup label="${g.group}">${g.items.map((p) => `<option value="${p.id}">${p.name}（${p.w}×${p.h}）</option>`).join('')}</optgroup>`).join('')}
        <option value="custom">自定义…</option>
      </select>
    </label>
    <label class="field">方向
      <select data-ref="orient">
        <option value="landscape">横屏</option>
        <option value="portrait">竖屏</option>
      </select>
    </label>
    <label class="field">屏幕宽度 (px)<input type="number" min="1" max="${MAX_SCREEN}" step="1" data-ref="screenW"></label>
    <label class="field">屏幕高度 (px)<input type="number" min="1" max="${MAX_SCREEN}" step="1" data-ref="screenH"></label>
    <label class="field sp-wide-field" title="物理像素按设备分辨率计算；逻辑像素按 CSS 像素计算">像素基准
      <select data-ref="basis">
        <option value="physical">物理像素（设备分辨率）</option>
        <option value="logical">逻辑像素（CSS 像素）</option>
      </select>
    </label>
    <label class="field sp-wide-field">切换屏幕时素材
      <select data-ref="adapt">
        <option value="keep">保持像素尺寸</option>
        <option value="scale">随屏幕等比缩放</option>
      </select>
    </label>
    <label class="field">屏幕背景
      <select data-ref="bg">
        <option value="checker">透明（棋盘格）</option>
        <option value="#ffffff">白色</option>
        <option value="#000000">黑色</option>
        <option value="custom">自定义颜色</option>
      </select>
    </label>
    <label class="field">背景颜色<input type="color" value="#1e293b" data-ref="bgColor" disabled></label>
  </div>
  <p class="plan-note" data-ref="screenNote"></p>
</section>

<section class="panel">
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">2. 摆放素材</h2>
      <span class="badge" data-ref="assetCount"></span>
    </div>
    <div class="actions">
      <button class="btn" data-ref="add">添加素材</button>
      <button class="btn" data-ref="clear">清空</button>
      <button class="btn btn-primary" data-ref="preview" title="预览按屏幕边界裁切后的合成效果">预览画布</button>
    </div>
  </div>
  <div class="tool-toolbar">
    <div class="segmented" role="group" aria-label="画布模式">
      <button class="segmented-item" data-ref="modeMove" aria-pressed="true" title="只能拖动素材位置，不会改变大小（V）">移动</button>
      <button class="segmented-item" data-ref="modeEdit" aria-pressed="false" title="显示四角手柄，可调整素材大小（E）">编辑</button>
    </div>
    <div class="segmented" role="group" aria-label="历史">
      <button class="segmented-item" data-ref="undo" title="撤销（Ctrl+Z）">撤销</button>
      <button class="segmented-item" data-ref="redo" title="重做（Ctrl+Y）">重做</button>
    </div>
  </div>
  <input type="file" accept="image/*,.svg" multiple hidden data-ref="file">
  <div class="tool-split">
    <div class="stage zoom-stage sp-stage" data-ref="stage" tabindex="0" aria-label="屏幕画布" title="滚轮缩放，空格或中键拖拽平移；Alt 关闭吸附，方向键微调，Delete 删除；屏幕外内容会被裁掉">
      <div class="sp-wrap" data-ref="wrap">
        <div class="sp-screen" data-ref="screen"></div>
        <div class="sp-assets" data-ref="assets"></div>
        <svg class="sp-overlay" data-ref="overlay" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
      <span class="stage-caption glass sp-empty" data-ref="emptyHint">添加素材或拖入图片</span>
    </div>

    <div class="controls">
      <div class="plan" data-ref="summary"></div>

      <div class="field">
        <span title="上方的图层显示在最前面">图层</span>
        <div class="sp-layers scroll-area" data-ref="layers"></div>
      </div>

      <div class="field" data-ref="propField" hidden>
        <span class="field-label">选中素材<output class="sp-prop-name" data-ref="propName"></output></span>
        <div class="dims">
          <div class="dim"><span class="dim-label">宽度占屏幕</span><span class="dim-value"><b data-ref="ratioW">0</b>%</span></div>
          <div class="dim"><span class="dim-label">高度占屏幕</span><span class="dim-value"><b data-ref="ratioH">0</b>%</span></div>
          <div class="dim"><span class="dim-label">面积占屏幕</span><span class="dim-value"><b data-ref="ratioA">0</b>%</span></div>
          <div class="dim"><span class="dim-label">缩放</span><span class="dim-value"><b data-ref="ratioS">100</b>%</span></div>
          <div class="file-meta" data-ref="propNote"></div>
        </div>
        <div class="box-fields">
          <label>X<input type="number" step="1" data-ref="px"></label>
          <label>Y<input type="number" step="1" data-ref="py"></label>
          <label>宽<input type="number" min="1" step="1" data-ref="pw"></label>
          <label>高<input type="number" min="1" step="1" data-ref="ph"></label>
        </div>
        <label class="check"><input type="checkbox" data-ref="lockRatio" checked>锁定宽高比</label>
        <div class="segmented sp-seg" role="group" aria-label="位置与尺寸">
          <button class="segmented-item" data-ref="natural" title="恢复素材的原始像素尺寸">原始尺寸</button>
          <button class="segmented-item" data-ref="centerH" title="水平居中">水平居中</button>
          <button class="segmented-item" data-ref="centerV" title="垂直居中">垂直居中</button>
        </div>
        <div class="segmented sp-seg" role="group" aria-label="图层">
          <button class="segmented-item" data-ref="raise" title="上移一层">上移一层</button>
          <button class="segmented-item" data-ref="lower" title="下移一层">下移一层</button>
          <button class="segmented-item" data-ref="remove" title="删除（Delete）">删除</button>
        </div>
      </div>
    </div>
  </div>
</section>

<dialog class="lightbox glass" data-ref="lightbox" aria-label="画布预览">
  <div class="lightbox-header">
    <div class="panel-heading">
      <h3 class="section-title">画布预览</h3>
      <span class="badge" data-ref="lbMeta"></span>
      <span class="lightbox-name" data-ref="lbName"></span>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-ref="lbExport">导出 PNG</button>
      <button type="button" class="btn" data-ref="lbClose">关闭</button>
    </div>
  </div>
  <div class="lightbox-body">
    <div class="stage lightbox-stage" data-ref="lbStage" title="滚轮缩放，拖拽平移；100% 为实际像素大小，Esc 关闭">
      <img alt="画布预览" data-ref="lbImg">
    </div>
  </div>
</dialog>
`;

// ---------- 工具函数 ----------
function baseName(filename) {
  const name = filename.replace(/\.[^.]+$/, '') || 'image';
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

function canvasToBlob(canvas, mime = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), mime);
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));

function cornerPoints(a) {
  return { nw: [a.x, a.y], ne: [a.x + a.w, a.y], se: [a.x + a.w, a.y + a.h], sw: [a.x, a.y + a.h] };
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

export default {
  id: 'screen-preview',
  name: '屏幕占比预览',
  description: '摆放素材，查看屏幕尺寸与覆盖比例',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="5" height="12" rx="1"/></svg>',

  mount(root) {
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);
    const saved = loadSettings();

    const state = {
      screen: {
        preset: PRESET_MAP.has(saved.preset) || saved.preset === 'custom' ? saved.preset : DEFAULT_PRESET,
        orient: saved.orient === 'portrait' ? 'portrait' : 'landscape',
        customW: Number(saved.customW) || 1920,
        customH: Number(saved.customH) || 1080,
        basis: saved.basis === 'logical' ? 'logical' : 'physical',
      },
      items: [], // 当前图层顺序（从底到顶）：{ id, name, url, img, el, natW, natH, vector, x, y, w, h }
      pool: new Map(), // 所有添加过的素材（撤销删除时需要），清空 / 卸载时统一释放
      nextId: 1,
      selected: null,
      hoverId: null,
      undo: [],
      redo: [],
      coalesce: null,
      drag: null,
      suppressClick: false,
      spaceDown: false,
      stageHover: false,
      overlayQueued: false,
      coverTimer: 0,
      coverage: null,
      lbUrl: null,
      adding: false,
      mode: 'move', // move：只能移动；edit：可缩放
      lbBlob: null,
    };
    if (saved.adapt === 'scale') $.adapt.value = 'scale';
    if (saved.bg) $.bg.value = saved.bg;
    if (saved.bgColor) $.bgColor.value = saved.bgColor;

    const zoom = createZoomView($.stage, $.wrap, {
      size: () => {
        const s = screenSize();
        return { w: s.w, h: s.h };
      },
      shouldPan,
      onChange: () => scheduleOverlay(),
    });
    const lbZoom = createZoomView($.lbStage, $.lbImg);

    const findItem = (id) => state.items.find((a) => a.id === id);
    const selectedItem = () => findItem(state.selected);

    // ---------- 屏幕 ----------
    // 当前画布尺寸（按像素基准换算后的屏幕像素）
    function screenSize() {
      const s = state.screen;
      if (s.preset === 'custom') return { w: s.customW, h: s.customH, dpr: 1, preset: null };
      const p = PRESET_MAP.get(s.preset);
      let { w, h } = p;
      if ((s.orient === 'landscape') !== (w >= h)) [w, h] = [h, w];
      const k = s.basis === 'logical' ? p.dpr : 1;
      return { w: Math.round(w / k), h: Math.round(h / k), dpr: p.dpr, preset: p };
    }

    function saveSettings() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...state.screen,
        adapt: $.adapt.value,
        bg: $.bg.value,
        bgColor: $.bgColor.value,
      }));
    }

    // 修改屏幕设置；「随屏幕等比缩放」时素材的中心位置按宽高比例、尺寸按较小的比例换算
    function changeScreen(mutate) {
      const before = snapshot();
      const old = screenSize();
      mutate(state.screen);
      const now = screenSize();
      if (now.w !== old.w || now.h !== old.h) {
        if ($.adapt.value === 'scale' && state.items.length) {
          const sx = now.w / old.w;
          const sy = now.h / old.h;
          const s = Math.min(sx, sy);
          for (const a of state.items) {
            const cx = (a.x + a.w / 2) * sx;
            const cy = (a.y + a.h / 2) * sy;
            a.w = Math.max(1, Math.round(a.w * s));
            a.h = Math.max(1, Math.round(a.h * s));
            a.x = Math.round(cx - a.w / 2);
            a.y = Math.round(cy - a.h / 2);
          }
        }
        pushHistory(before);
      }
      syncScreenUi();
      refreshAll();
      zoom.refresh();
      saveSettings();
    }

    function syncScreenUi() {
      const s = state.screen;
      const size = screenSize();
      $.preset.value = s.preset;
      $.orient.value = size.w >= size.h ? 'landscape' : 'portrait';
      if (document.activeElement !== $.screenW) $.screenW.value = size.w;
      if (document.activeElement !== $.screenH) $.screenH.value = size.h;
      $.basis.value = s.basis;
      $.basis.disabled = s.preset === 'custom';
      $.screenBadge.textContent = `${size.w}×${size.h}`;
      $.wrap.style.width = `${size.w}px`;
      $.wrap.style.height = `${size.h}px`;
      const p = size.preset;
      if (!p) {
        $.screenNote.textContent = '自定义屏幕 · 素材 1 px 对应屏幕 1 px';
      } else {
        const lw = Math.round((size.w * (s.basis === 'logical' ? 1 : 1 / p.dpr)));
        const lh = Math.round((size.h * (s.basis === 'logical' ? 1 : 1 / p.dpr)));
        const pw = Math.round(size.w * (s.basis === 'logical' ? p.dpr : 1));
        const ph = Math.round(size.h * (s.basis === 'logical' ? p.dpr : 1));
        $.screenNote.textContent = s.basis === 'logical'
          ? `逻辑 ${lw}×${lh} · 物理 ${pw}×${ph} · DPR ${p.dpr} · 素材 1 px = 1 CSS px`
          : `物理 ${pw}×${ph} · 逻辑 ${lw}×${lh} · DPR ${p.dpr} · 素材 1 px = 1 屏幕像素`;
      }
      applyBackground();
    }

    function applyBackground() {
      const v = $.bg.value;
      $.bgColor.disabled = v !== 'custom';
      $.screen.classList.toggle('checker', v === 'checker');
      $.screen.style.background = v === 'checker' ? '' : v === 'custom' ? $.bgColor.value : v;
    }

    $.preset.addEventListener('change', () => changeScreen((s) => {
      s.preset = $.preset.value;
      const p = PRESET_MAP.get(s.preset);
      if (p) s.orient = p.w >= p.h ? 'landscape' : 'portrait'; // 选择设备时切换到该设备的常用方向
    }));
    $.orient.addEventListener('change', () => changeScreen((s) => {
      s.orient = $.orient.value;
      if (s.preset === 'custom' && (s.orient === 'landscape') !== (s.customW >= s.customH)) {
        [s.customW, s.customH] = [s.customH, s.customW];
      }
    }));
    for (const input of [$.screenW, $.screenH]) {
      input.addEventListener('change', () => {
        const w = Math.round(Number($.screenW.value));
        const h = Math.round(Number($.screenH.value));
        if (!(w >= 1 && w <= MAX_SCREEN && h >= 1 && h <= MAX_SCREEN)) {
          toast(`屏幕宽高需为 1 ~ ${MAX_SCREEN} 的整数`);
          syncScreenUi();
          return;
        }
        changeScreen((s) => {
          s.preset = 'custom';
          s.customW = w;
          s.customH = h;
          s.orient = w >= h ? 'landscape' : 'portrait';
        });
      });
    }
    $.basis.addEventListener('change', () => changeScreen((s) => {
      s.basis = $.basis.value;
    }));
    $.adapt.addEventListener('change', saveSettings);
    $.bg.addEventListener('change', () => {
      applyBackground();
      saveSettings();
    });
    $.bgColor.addEventListener('input', () => {
      applyBackground();
      saveSettings();
    });

    // ---------- 添加素材 ----------
    async function createAsset(file) {
      let src = file;
      let natW = 0;
      let natH = 0;
      const vector = isSvg(file);
      if (vector) {
        // SVG 的原始尺寸取固有尺寸，按更高倍数渲染以便放大后依然清晰
        const info = await readSvg(file);
        src = await rasterizeSvg(info, resolveScale(SVG_RENDER_SCALE, info), file.name);
        natW = Math.max(1, Math.round(info.width));
        natH = Math.max(1, Math.round(info.height));
      }
      const url = URL.createObjectURL(src);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
      if (!vector) {
        natW = img.naturalWidth;
        natH = img.naturalHeight;
      }
      const el = document.createElement('img');
      el.className = 'sp-asset';
      el.alt = '';
      el.draggable = false;
      el.src = url;
      return { id: state.nextId++, name: file.name || 'image.png', url, img, el, natW, natH, vector, x: 0, y: 0, w: natW, h: natH };
    }

    async function addFiles(fileList) {
      const files = [...fileList].filter((f) => f.type.startsWith('image/') || isSvg(f));
      if (!files.length) {
        toast('请选择图片文件');
        return;
      }
      if (state.adding) {
        toast('正在添加，请稍候');
        return;
      }
      state.adding = true;
      $.add.textContent = '添加中…';
      const before = snapshot();
      const { w: W, h: H } = screenSize();
      let added = 0;
      let failed = 0;
      try {
        for (const file of files) {
          let a;
          try {
            a = await createAsset(file);
          } catch {
            failed++;
            continue;
          }
          // 放在屏幕中央，多个素材依次错开，避免完全重叠
          const offset = (state.items.length % 8) * 24;
          a.x = Math.round((W - a.w) / 2) + offset;
          a.y = Math.round((H - a.h) / 2) + offset;
          state.items.push(a);
          state.pool.set(a.id, a);
          state.selected = a.id;
          added++;
        }
      } finally {
        state.adding = false;
        $.add.textContent = '添加素材';
      }
      if (added) {
        pushHistory(before);
        refreshAll();
      }
      toast(failed ? `已添加 ${added} 个素材，${failed} 个无法读取` : `已添加 ${added} 个素材`);
    }

    $.add.addEventListener('click', () => $.file.click());
    $.file.addEventListener('change', () => {
      addFiles($.file.files);
      $.file.value = '';
    });
    $.stage.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      $.stage.classList.add('dragging');
    });
    $.stage.addEventListener('dragleave', () => $.stage.classList.remove('dragging'));
    $.stage.addEventListener('drop', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      $.stage.classList.remove('dragging');
      addFiles(e.dataTransfer.files);
    });
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.items || [])]
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter(Boolean);
      if (files.length) addFiles(files);
    };
    document.addEventListener('paste', onPaste);

    function releaseAll() {
      for (const a of state.pool.values()) URL.revokeObjectURL(a.url);
      state.pool.clear();
    }

    $.clear.addEventListener('click', () => {
      if (!state.items.length || !confirm(`确定清空全部 ${state.items.length} 个素材？清空后不能撤销。`)) return;
      cancelDrag();
      state.items = [];
      state.selected = null;
      state.undo = [];
      state.redo = [];
      $.assets.replaceChildren();
      releaseAll();
      refreshAll();
    });

    // ---------- 撤销 / 重做（快照包含屏幕设置，等比缩放后撤销能同时恢复屏幕） ----------
    function snapshot() {
      return {
        screen: { ...state.screen },
        items: state.items.map((a) => ({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h })),
      };
    }

    function pushHistory(before, coalesceKey) {
      const now = performance.now();
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
      refreshAll();
    }

    function restore(from, to) {
      if (!from.length) return;
      to.push(snapshot());
      const snap = from.pop();
      const screenChanged = JSON.stringify(snap.screen) !== JSON.stringify(state.screen);
      state.screen = { ...snap.screen };
      state.items = snap.items.map((s) => Object.assign(state.pool.get(s.id), s));
      if (!findItem(state.selected)) state.selected = null;
      state.coalesce = null;
      syncScreenUi();
      refreshAll();
      if (screenChanged) {
        zoom.refresh();
        saveSettings();
      }
    }
    const undo = () => restore(state.undo, state.redo);
    const redo = () => restore(state.redo, state.undo);
    $.undo.addEventListener('click', undo);
    $.redo.addEventListener('click', redo);

    // ---------- 画布交互 ----------
    function toScreen(e) {
      const r = $.wrap.getBoundingClientRect();
      const { w, h } = screenSize();
      return { x: ((e.clientX - r.left) * w) / r.width, y: ((e.clientY - r.top) * h) / r.height };
    }

    // 最上层的命中素材（按外接矩形）
    function hitItem(p) {
      const tol = 3 / zoom.getScale();
      for (let i = state.items.length - 1; i >= 0; i--) {
        const a = state.items[i];
        if (p.x >= a.x - tol && p.x <= a.x + a.w + tol && p.y >= a.y - tol && p.y <= a.y + a.h + tol) return a;
      }
      return null;
    }

    function hitHandle(p) {
      if (state.mode !== 'edit') return null; // 移动模式不显示手柄，不能缩放
      const a = selectedItem();
      if (!a) return null;
      const r = (HANDLE_SCREEN / 2 + 2) / zoom.getScale();
      for (const [name, [hx, hy]] of Object.entries(cornerPoints(a))) {
        if (Math.abs(p.x - hx) <= r && Math.abs(p.y - hy) <= r) return name;
      }
      return null;
    }

    // 交给 zoom.js 平移：中键、空格按住，或按在空白处
    function shouldPan(e) {
      if (e.button === 1 || state.spaceDown) return true;
      const p = toScreen(e);
      return !hitHandle(p) && !hitItem(p);
    }

    // 素材的左 / 中 / 右（上 / 中 / 下）靠近屏幕边缘或中线时吸附
    function snap(r) {
      const { w: W, h: H } = screenSize();
      const tol = SNAP_SCREEN / zoom.getScale();
      const nearest = (edges, lines) => {
        let best = null;
        for (const e of edges) {
          for (const l of lines) {
            const diff = l - e;
            if (Math.abs(diff) <= tol && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, line: l };
          }
        }
        return best;
      };
      const sx = nearest([r.x, r.x + r.w / 2, r.x + r.w], [0, W / 2, W]);
      const sy = nearest([r.y, r.y + r.h / 2, r.y + r.h], [0, H / 2, H]);
      return { dx: sx ? sx.diff : 0, dy: sy ? sy.diff : 0, gx: sx?.line, gy: sy?.line };
    }

    function startDrag(drag, e) {
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
      for (const s of d.before.items) Object.assign(state.pool.get(s.id), s);
      refreshAll();
    }

    $.stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || state.spaceDown || e.target.closest('button')) return;
      $.stage.focus({ preventScroll: true });
      const p = toScreen(e);
      const handle = hitHandle(p);
      if (handle) {
        const a = selectedItem();
        startDrag({ type: 'resize', handle, id: a.id, orig: { x: a.x, y: a.y, w: a.w, h: a.h } }, e);
        return;
      }
      const a = hitItem(p);
      if (!a) return;
      if (state.selected !== a.id) {
        state.selected = a.id;
        refreshAll();
      }
      startDrag({ type: 'move', id: a.id, start: p, orig: { x: a.x, y: a.y } }, e);
    });

    function onDragMove(e) {
      const d = state.drag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      const a = findItem(d.id);
      if (!a) return;
      const p = toScreen(e);
      d.guides = null;
      if (d.type === 'move') {
        a.x = Math.round(d.orig.x + p.x - d.start.x);
        a.y = Math.round(d.orig.y + p.y - d.start.y);
        if (!e.altKey) {
          const s = snap(a);
          a.x = Math.round(a.x + s.dx);
          a.y = Math.round(a.y + s.dy);
          d.guides = s;
        }
      } else {
        // 以对角为锚点缩放；锁定宽高比时取两个方向中较大的比例
        const o = d.orig;
        const ax = d.handle.includes('w') ? o.x + o.w : o.x;
        const ay = d.handle.includes('n') ? o.y + o.h : o.y;
        let w = Math.abs(p.x - ax);
        let h = Math.abs(p.y - ay);
        if ($.lockRatio.checked) {
          const k = Math.max(w / o.w, h / o.h);
          w = o.w * k;
          h = o.h * k;
        }
        a.w = Math.max(1, Math.round(w));
        a.h = Math.max(1, Math.round(h));
        a.x = d.handle.includes('w') ? ax - a.w : ax;
        a.y = d.handle.includes('n') ? ay - a.h : ay;
      }
      renderAssets();
      updateProps();
      scheduleOverlay();
    }

    function onDragEnd() {
      const d = state.drag;
      if (!d) return;
      state.drag = null;
      stopDragListeners();
      state.suppressClick = d.moved;
      if (d.moved) commit(d.before);
      else scheduleOverlay();
    }

    $.stage.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (state.suppressClick) {
        state.suppressClick = false;
        return;
      }
      const p = toScreen(e);
      if (state.selected && !hitItem(p) && !hitHandle(p)) {
        state.selected = null;
        refreshAll();
      }
    });

    $.stage.addEventListener('pointermove', (e) => {
      if (state.drag) return;
      if ($.stage.classList.contains('panning')) {
        $.stage.style.cursor = '';
        return;
      }
      const p = toScreen(e);
      let cursor = '';
      let hover = null;
      if (state.spaceDown) {
        cursor = 'grab';
      } else {
        const handle = hitHandle(p);
        if (handle) {
          cursor = HANDLE_CURSOR[handle];
        } else {
          const a = hitItem(p);
          if (a) {
            cursor = 'move';
            hover = a.id;
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
      state.hoverId = id;
      for (const li of $.layers.children) li.classList.toggle('is-hover', Number(li.dataset.id) === id);
      scheduleOverlay();
    }

    // ---------- 叠加层：屏幕外变暗、屏幕边框、选中框与手柄、吸附参考线 ----------
    function scheduleOverlay() {
      if (state.overlayQueued) return;
      state.overlayQueued = true;
      requestAnimationFrame(renderOverlay);
    }

    function renderOverlay() {
      state.overlayQueued = false;
      const s = zoom.getScale();
      const { w: W, h: H } = screenSize();
      const big = 1e6;
      $.overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
      $.overlay.setAttribute('width', W);
      $.overlay.setAttribute('height', H);
      const parts = [
        `<path class="sp-outside" fill-rule="evenodd" d="M${-big} ${-big}H${big}V${big}H${-big}Z M0 0H${W}V${H}H0Z"/>`,
        `<rect class="sp-frame" x="0" y="0" width="${W}" height="${H}"/>`,
      ];
      const hover = state.hoverId !== state.selected ? findItem(state.hoverId) : null;
      if (hover) parts.push(`<rect class="sp-hover" x="${hover.x}" y="${hover.y}" width="${hover.w}" height="${hover.h}"/>`);
      const a = selectedItem();
      if (a) {
        parts.push(`<rect class="sp-selected" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}"/>`);
        const hs = HANDLE_SCREEN / s;
        if (state.mode === 'edit') {
          for (const [hx, hy] of Object.values(cornerPoints(a))) {
            parts.push(`<rect class="sp-handle" x="${hx - hs / 2}" y="${hy - hs / 2}" width="${hs}" height="${hs}"/>`);
          }
        }
        const area = ((a.w * a.h) / (W * H)) * 100;
        const fs = 12 / s;
        const ly = a.y - 6 / s > fs ? a.y - 6 / s : a.y + a.h + fs + 6 / s;
        parts.push(`<text class="sp-label" x="${a.x}" y="${ly}" font-size="${fs}" stroke-width="${3 / s}">${a.w}×${a.h} · 面积 ${pct(area)}%</text>`);
      }
      const g = state.drag?.guides;
      if (g?.gx !== undefined) parts.push(`<line class="sp-guide" x1="${g.gx}" y1="0" x2="${g.gx}" y2="${H}"/>`);
      if (g?.gy !== undefined) parts.push(`<line class="sp-guide" x1="0" y1="${g.gy}" x2="${W}" y2="${g.gy}"/>`);
      $.overlay.innerHTML = parts.join('');
    }

    // ---------- 画布模式：移动 / 编辑 ----------
    function setMode(mode) {
      if (state.mode === mode) return;
      if (state.drag?.type === 'resize') cancelDrag();
      state.mode = mode;
      $.modeMove.setAttribute('aria-pressed', String(mode === 'move'));
      $.modeEdit.setAttribute('aria-pressed', String(mode === 'edit'));
      $.stage.style.cursor = '';
      updateProps();
      scheduleOverlay();
    }
    $.modeMove.addEventListener('click', () => setMode('move'));
    $.modeEdit.addEventListener('click', () => setMode('edit'));

    // ---------- 快捷键 ----------
    const onKeydown = (e) => {
      if ($.lightbox.open) return;
      const inField = e.target.closest?.('input, select, textarea');
      if (e.key === ' ' && state.stageHover && !inField) {
        e.preventDefault();
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
      if (mod || e.altKey) return;
      if (key === 'v') {
        setMode('move');
        return;
      }
      if (key === 'e') {
        setMode('edit');
        return;
      }
      const a = selectedItem();
      if (e.key === 'Escape') {
        if (state.drag) cancelDrag();
        else if (a) {
          state.selected = null;
          refreshAll();
        }
        return;
      }
      if (!a) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeSelected();
        return;
      }
      if (e.key.startsWith('Arrow') && !state.drag) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const before = snapshot();
        a.x += e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        a.y += e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        commit(before, 'nudge');
      }
    };
    const onKeyup = (e) => {
      if (e.key === ' ' && state.spaceDown) {
        state.spaceDown = false;
        $.stage.style.cursor = '';
      }
    };
    const onBlur = () => {
      state.spaceDown = false;
    };
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    window.addEventListener('blur', onBlur);

    // ---------- 界面刷新 ----------
    function refreshAll() {
      renderAssets();
      renderLayers();
      updateProps();
      updateSummary();
      scheduleOverlay();
      scheduleCoverage();
      $.undo.disabled = !state.undo.length;
      $.redo.disabled = !state.redo.length;
      $.clear.disabled = !state.items.length;
      $.emptyHint.hidden = state.items.length > 0;
      $.assetCount.textContent = `${state.items.length} 个素材`;
    }

    function renderAssets() {
      for (const a of state.items) {
        const st = a.el.style;
        st.left = `${a.x}px`;
        st.top = `${a.y}px`;
        st.width = `${a.w}px`;
        st.height = `${a.h}px`;
      }
      const els = state.items.map((a) => a.el);
      if (els.length !== $.assets.children.length || els.some((el, i) => $.assets.children[i] !== el)) {
        $.assets.replaceChildren(...els);
      }
    }

    function areaRatio(a) {
      const { w: W, h: H } = screenSize();
      return ((a.w * a.h) / (W * H)) * 100;
    }

    function renderLayers() {
      if (!state.items.length) {
        const empty = document.createElement('span');
        empty.className = 'empty-text';
        empty.textContent = '还没有素材';
        $.layers.replaceChildren(empty);
        return;
      }
      $.layers.replaceChildren(...[...state.items].reverse().map((a) => {
        const li = document.createElement('button');
        li.type = 'button';
        li.className = 'sp-layer';
        li.dataset.id = a.id;
        li.classList.toggle('is-selected', a.id === state.selected);
        li.classList.toggle('is-hover', a.id === state.hoverId);
        const thumb = document.createElement('img');
        thumb.className = 'checker';
        thumb.alt = '';
        thumb.src = a.url;
        const name = document.createElement('span');
        name.className = 'sp-layer-name';
        name.textContent = a.name;
        const meta = document.createElement('span');
        meta.className = 'sp-layer-meta';
        meta.textContent = `${a.w}×${a.h} · ${pct(areaRatio(a))}%`;
        li.append(thumb, name, meta);
        return li;
      }));
    }

    $.layers.addEventListener('click', (e) => {
      const li = e.target.closest('.sp-layer');
      if (!li) return;
      state.selected = Number(li.dataset.id);
      refreshAll();
    });
    $.layers.addEventListener('mouseover', (e) => setHover(Number(e.target.closest('.sp-layer')?.dataset.id) || null));
    $.layers.addEventListener('mouseleave', () => setHover(null));

    // ---------- 选中素材的属性 ----------
    function updateProps() {
      const a = selectedItem();
      $.propField.hidden = !a;
      if (!a) return;
      const { w: W, h: H } = screenSize();
      $.propName.textContent = a.name;
      $.ratioW.textContent = pct((a.w / W) * 100);
      $.ratioH.textContent = pct((a.h / H) * 100);
      $.ratioA.textContent = pct(areaRatio(a));
      $.ratioS.textContent = pct((a.w / a.natW) * 100);
      const vw = Math.max(0, Math.min(a.x + a.w, W) - Math.max(a.x, 0));
      const vh = Math.max(0, Math.min(a.y + a.h, H) - Math.max(a.y, 0));
      const inside = vw === a.w && vh === a.h;
      const natural = `原始尺寸 ${a.natW}×${a.natH}${a.vector ? '（SVG 固有尺寸）' : ''}`;
      $.propNote.textContent = inside
        ? `${natural}；完全在屏幕内`
        : `${natural}；部分超出屏幕，屏幕内可见部分约占屏幕 ${pct(((vw * vh) / (W * H)) * 100)}%`;
      $.propNote.classList.toggle('is-warning', !inside);
      for (const [ref, v] of [['px', a.x], ['py', a.y], ['pw', a.w], ['ph', a.h]]) {
        if (document.activeElement !== $[ref]) $[ref].value = v;
      }
      const index = state.items.indexOf(a);
      $.raise.disabled = index === state.items.length - 1;
      // 移动模式下尺寸相关的控件不可用
      const resizable = state.mode === 'edit';
      for (const el of [$.pw, $.ph, $.lockRatio, $.natural]) el.disabled = !resizable;
      $.natural.title = resizable ? '恢复素材的原始像素尺寸' : '切换到「编辑」模式后可调整大小';
      $.lower.disabled = index === 0;
    }

    for (const ref of ['px', 'py', 'pw', 'ph']) {
      $[ref].addEventListener('change', () => {
        const a = selectedItem();
        if (!a) return;
        const v = Math.round(Number($[ref].value));
        if (!Number.isFinite(v) || ((ref === 'pw' || ref === 'ph') && v < 1)) {
          updateProps();
          return;
        }
        const before = snapshot();
        if (ref === 'px') a.x = v;
        else if (ref === 'py') a.y = v;
        else if (ref === 'pw') {
          if ($.lockRatio.checked) a.h = Math.max(1, Math.round((v * a.h) / a.w));
          a.w = v;
        } else {
          if ($.lockRatio.checked) a.w = Math.max(1, Math.round((v * a.w) / a.h));
          a.h = v;
        }
        $[ref].blur();
        commit(before);
      });
    }

    function editSelected(fn) {
      const a = selectedItem();
      if (!a) return;
      const before = snapshot();
      fn(a, screenSize());
      commit(before);
    }

    $.natural.addEventListener('click', () => editSelected((a) => {
      // 以中心为基准恢复原始尺寸
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      a.w = a.natW;
      a.h = a.natH;
      a.x = Math.round(cx - a.w / 2);
      a.y = Math.round(cy - a.h / 2);
    }));
    $.centerH.addEventListener('click', () => editSelected((a, s) => {
      a.x = Math.round((s.w - a.w) / 2);
    }));
    $.centerV.addEventListener('click', () => editSelected((a, s) => {
      a.y = Math.round((s.h - a.h) / 2);
    }));

    function moveLayer(delta) {
      const a = selectedItem();
      if (!a) return;
      const i = state.items.indexOf(a);
      const j = i + delta;
      if (j < 0 || j >= state.items.length) return;
      const before = snapshot();
      state.items.splice(i, 1);
      state.items.splice(j, 0, a);
      commit(before);
    }
    $.raise.addEventListener('click', () => moveLayer(1));
    $.lower.addEventListener('click', () => moveLayer(-1));

    function removeSelected() {
      const a = selectedItem();
      if (!a) return;
      const before = snapshot();
      state.items = state.items.filter((x) => x !== a);
      state.selected = null;
      commit(before);
    }
    $.remove.addEventListener('click', removeSelected);

    // ---------- 占比汇总：按不透明像素统计覆盖率（低分辨率采样，重叠只算一次） ----------
    const coverCanvas = document.createElement('canvas');

    function scheduleCoverage() {
      clearTimeout(state.coverTimer);
      state.coverTimer = setTimeout(() => {
        state.coverage = computeCoverage();
        updateSummary();
      }, 120);
    }

    function computeCoverage() {
      if (!state.items.length) return 0;
      const { w: W, h: H } = screenSize();
      const k = Math.min(1, COVER_MAX / Math.max(W, H));
      const cw = Math.max(1, Math.round(W * k));
      const ch = Math.max(1, Math.round(H * k));
      coverCanvas.width = cw;
      coverCanvas.height = ch;
      const ctx = coverCanvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, cw, ch);
      for (const a of state.items) ctx.drawImage(a.img, a.x * k, a.y * k, a.w * k, a.h * k);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      let covered = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 16) covered++;
      return (covered / (cw * ch)) * 100;
    }

    function updateSummary() {
      const { w: W, h: H } = screenSize();
      const n = state.items.length;
      $.summary.innerHTML = `屏幕 <b>${W}×${H}</b> · 素材 <b>${n}</b> 个`;
      if (!n) return;
      const line = document.createElement('span');
      line.className = 'plan-note';
      const value = document.createElement('b');
      const c = state.coverage ?? 0;
      value.textContent = `${pct(c)}%`;
      // 状态色阈值：≥80% 警告，≥90% 错误
      value.classList.toggle('is-warning', c >= 80 && c < 90);
      value.classList.toggle('is-error', c >= 90);
      line.append('素材不透明像素覆盖屏幕 ', value, '（重叠部分只算一次）');
      $.summary.append(line);
      const outside = state.items.filter((a) => a.x < 0 || a.y < 0 || a.x + a.w > W || a.y + a.h > H).length;
      if (outside) {
        const warn = document.createElement('span');
        warn.className = 'plan-note is-warning';
        warn.textContent = `${outside} 个素材部分或全部超出屏幕`;
        $.summary.append(warn);
      }
    }

    // ---------- 预览与导出 ----------
    async function renderComposite() {
      const { w: W, h: H } = screenSize();
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const bg = $.bg.value;
      if (bg !== 'checker') {
        ctx.fillStyle = bg === 'custom' ? $.bgColor.value : bg;
        ctx.fillRect(0, 0, W, H);
      }
      for (const a of state.items) ctx.drawImage(a.img, a.x, a.y, a.w, a.h);
      return canvasToBlob(canvas);
    }

    function screenLabel() {
      const { w, h, preset } = screenSize();
      return preset ? `${preset.name}（${w}×${h}${state.screen.basis === 'logical' ? '，逻辑像素' : ''}）` : `自定义（${w}×${h}）`;
    }

    $.preview.addEventListener('click', async () => {
      let blob;
      try {
        blob = await renderComposite();
      } catch (err) {
        toast(`生成预览失败：${err.message}`);
        return;
      }
      if (state.lbUrl) URL.revokeObjectURL(state.lbUrl);
      state.lbUrl = URL.createObjectURL(blob);
      state.lbBlob = blob;
      const { w, h } = screenSize();
      $.lbMeta.textContent = `${w}×${h}`;
      $.lbName.textContent = screenLabel();
      if (!$.lightbox.open) $.lightbox.showModal();
      $.lbImg.classList.toggle('checker', $.bg.value === 'checker');
      $.lbImg.src = state.lbUrl;
    });
    $.lbImg.addEventListener('load', () => lbZoom.fit());
    $.lbClose.addEventListener('click', () => $.lightbox.close());
    $.lbExport.addEventListener('click', () => {
      if (!state.lbBlob) return;
      const { w, h, preset } = screenSize();
      downloadBlob(state.lbBlob, `${baseName(preset ? preset.name : '自定义屏幕')}_${w}x${h}.png`);
    });
    $.lightbox.addEventListener('close', () => {
      $.lbImg.removeAttribute('src');
      if (state.lbUrl) URL.revokeObjectURL(state.lbUrl);
      state.lbUrl = null;
      state.lbBlob = null;
    });

    syncScreenUi();
    refreshAll();

    // ---------- 卸载 ----------
    return () => {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('keyup', onKeyup);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('blur', onBlur);
      stopDragListeners();
      clearTimeout(state.coverTimer);
      zoom.destroy();
      lbZoom.destroy();
      if ($.lightbox.open) $.lightbox.close();
      releaseAll();
    };
  },
};
