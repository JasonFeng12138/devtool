import { GifEncoder } from '../lib/gif.js';
import { createZoomView } from '../lib/zoom.js';
import { hexToRgb, removeBackground, rgbToHex } from '../lib/color-key.js';
import { takeHandoff } from '../lib/handoff.js';
import { INTERP_METHOD_KEY, INTERP_METHOD_OPTIONS, createInterpolator, isAiMethod } from '../lib/interpolate.js';
import { pickFolder, writeFiles } from '../lib/save.js';
import { ICON_UPLOAD, collectRefs, downloadBlob, formatBytes, startProgress, toast } from '../lib/ui.js';
import { SVG_SCALE_OPTIONS, isSvg, rasterizeSvg, readSvg, resolveScale } from '../lib/vector.js';

const THUMB_MAX = 240;
const ANIM_MAX = 1024; // 动画预览画布长边上限
const GIF_MAX_FPS = 50; // GIF 帧间隔最小 2/100 秒
const GIF_MAX_W = 4096;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' };

const ICON_ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_PIPETTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';
const ICON_HIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="M2 2l20 20"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m10 8 6 4-6 4z"/></svg>';
const PLAYER_HIDDEN_KEY = 'devtool-image-batch-player-hidden';

const TEMPLATE = `
<section class="panel ib-drop" data-ref="listPanel">
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">1. 导入与排序</h2>
      <span class="badge" data-ref="count" hidden></span>
    </div>
    <div class="actions" data-ref="listActions" hidden>
      <button class="btn" data-ref="add">添加图片</button>
      <button class="btn" data-ref="clear">清空</button>
    </div>
  </div>
  <div class="tool-toolbar">
    <label class="inline-field" title="导入 SVG 矢量图时转为位图的倍数，只影响之后导入的 SVG">SVG 渲染
      <select data-ref="svgScale">${SVG_SCALE_OPTIONS}</select>
    </label>
    <div class="actions" data-ref="selection" hidden>
      <div class="segmented" role="group" aria-label="选择">
        <button class="segmented-item" data-ref="selAll">全选</button>
        <button class="segmented-item" data-ref="selNone">全不选</button>
        <button class="segmented-item" data-ref="selInvert">反选</button>
      </div>
    </div>
  </div>
  <div class="stage" data-ref="dropStage">
    <label class="dropzone">
      <input type="file" accept="image/*,.svg" multiple aria-label="选择图片，可多选" data-ref="file">
      ${ICON_UPLOAD}
      <span class="dropzone-title">选择图片，可多选</span>
      <span class="dropzone-hint">拖拽或 Ctrl+V 粘贴 · 支持 SVG</span>
    </label>
  </div>
  <div class="interp-bar" data-ref="interpBar" hidden>
    <label class="inline-field">补帧方式
      <select data-ref="interpMethod">${INTERP_METHOD_OPTIONS}</select>
    </label>
    <label class="inline-field" title="按当前顺序，在每两张相邻的勾选图片之间插入的帧数">插帧数
      <select data-ref="interpCount">
        <option value="1">1 帧 · 2 倍</option>
        <option value="2">2 帧 · 3 倍</option>
        <option value="3">3 帧 · 4 倍</option>
      </select>
    </label>
    <label class="check" title="循环动画在最后一张和第一张之间也补帧"><input type="checkbox" data-ref="interpLoop">首尾衔接</label>
    <button class="btn" data-ref="interp" disabled>补帧</button>
    <button class="btn" data-ref="interpClear" disabled>移除补帧</button>
  </div>
  <div class="tiles tiles-scroll scroll-area ib-tiles" data-ref="tiles" title="拖拽排序；聚焦复选框后 Alt + ← / → 排序；Shift 点击选择区间" hidden></div>
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
    <div class="stage zoom-stage" data-ref="bgStage" title="滚轮缩放，拖拽平移；← → 切换参考图">
      <canvas class="stage-canvas checker" data-ref="bgCanvas"></canvas>
      <span class="stage-caption glass" data-ref="refCaption"></span>
      <button type="button" class="stage-nav stage-nav-prev" data-ref="refPrev" title="上一张参考图（←）" aria-label="上一张参考图">‹</button>
      <button type="button" class="stage-nav stage-nav-next" data-ref="refNext" title="下一张参考图（→）" aria-label="下一张参考图">›</button>
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
      </div>
      <label class="field">
        <span class="field-label">参考图<output data-ref="refOut"></output></span>
        <input type="range" min="0" max="0" step="1" value="0" data-ref="refIndex">
      </label>


      <div class="actions actions-stack">
        <button class="btn btn-primary" data-ref="apply" disabled>应用到所选图片</button>
        <button class="btn" data-ref="restore" disabled>还原所选图片</button>
      </div>
    </div>
  </div>
</section>

<section class="panel" data-ref="exportPanel" hidden>
  <div class="panel-header">
    <h2 class="section-title">3. 保存与导出</h2>
  </div>
  <div class="export-grid">
    <label class="field">GIF 宽度 (px)<input type="number" min="1" max="${GIF_MAX_W}" step="1" data-ref="gifW"></label>
    <label class="field">循环
      <select data-ref="gifLoop">
        <option value="0">无限循环</option>
        <option value="-1">播放一次</option>
      </select>
    </label>
    <label class="field" title="GIF 仅支持全透明或不透明像素，边缘羽化建议配合纯色填充">GIF 背景
      <select data-ref="gifBg">
        <option value="transparent">透明</option>
        <option value="color">纯色填充</option>
      </select>
    </label>
    <label class="field">填充颜色<input type="color" value="#ffffff" data-ref="gifMatte" disabled></label>
  </div>
  <div class="plan" data-ref="exportPlan"></div>
  <div class="actions export-actions">
    <button class="btn" data-ref="zip">打包 ZIP 下载</button>
    <button class="btn" data-ref="gif">导出 GIF</button>
    <button class="btn btn-primary" data-ref="save">保存选中到本地</button>
  </div>
</section>

<div class="ib-player-spacer" data-ref="spacer" aria-hidden="true" hidden></div>

<aside class="ib-player glass" data-ref="player" data-mode="mini" aria-label="动画预览" hidden>
  <div class="ib-player-header">
    <div class="panel-heading">
      <h2 class="section-title">动画预览</h2>
      <span class="badge" data-ref="animOut"></span>
    </div>
    <div class="ib-player-tools">
      <button type="button" class="icon-btn" data-ref="expand"></button>
      <button type="button" class="icon-btn" data-ref="hidePlayer" title="隐藏动画预览" aria-label="隐藏动画预览">${ICON_HIDE}</button>
    </div>
  </div>
  <div class="stage ib-player-stage" data-ref="animStage">
    <canvas class="checker" data-ref="animCanvas"></canvas>
    <span class="ib-player-empty" data-ref="animEmpty" hidden>请至少勾选一张图片</span>
  </div>
  <div class="ib-player-controls">
    <div class="segmented" role="group" aria-label="播放控制">
      <button class="segmented-item" data-ref="prev" title="上一张" aria-label="上一张">‹</button>
      <button class="segmented-item" data-ref="play" aria-pressed="true">暂停</button>
      <button class="segmented-item" data-ref="next" title="下一张" aria-label="下一张">›</button>
    </div>
    <label class="ib-fps"><input type="number" min="1" max="${GIF_MAX_FPS}" step="any" value="8" data-ref="animFps">fps</label>
  </div>
</aside>

<button type="button" class="ib-player-show glass" data-ref="showPlayer" title="显示动画预览" hidden>${ICON_PLAY}<span>动画预览</span></button>

<dialog class="lightbox glass" data-ref="lightbox" aria-label="图片预览">
  <div class="lightbox-header">
    <div class="panel-heading">
      <h3 class="section-title" data-ref="lbTitle"></h3>
      <span class="badge" data-ref="lbMeta"></span>
      <span class="lightbox-name" data-ref="lbName"></span>
    </div>
    <div class="actions">
      <div class="segmented" role="group" aria-label="预览内容">
        <button type="button" class="segmented-item" data-ref="lbViewResult" aria-pressed="true">去背景后</button>
        <button type="button" class="segmented-item" data-ref="lbViewOriginal" aria-pressed="false">原图</button>
      </div>
      <button type="button" class="btn" data-ref="lbSelect"></button>
      <button type="button" class="btn" data-ref="lbDownload">下载此图</button>
      <button type="button" class="btn" data-ref="lbClose">关闭</button>
    </div>
  </div>
  <div class="lightbox-body">
    <div class="stage lightbox-stage" data-ref="lbStage" title="滚轮缩放，拖拽平移；← → 切换图片，空格勾选，Esc 关闭">
      <img class="checker" alt="" data-ref="lbImg">
    </div>
    <button type="button" class="lightbox-nav lightbox-prev" data-ref="lbPrev" aria-label="上一张">‹</button>
    <button type="button" class="lightbox-nav lightbox-next" data-ref="lbNext" aria-label="下一张">›</button>
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

function readNumber(input) {
  return input.value.trim() === '' ? NaN : Number(input.value);
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function gifDelays(count, fps) {
  // 按累计时间取整，使整体时长贴近目标帧率
  return Array.from({ length: count }, (_, i) => Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));
}

export default {
  id: 'image-batch',
  name: '图片批处理',
  description: '批量排序、去除背景并导出动画',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',

  mount(root) {
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);
    // 浮动控件挂在 body，避免正文容器查询改变 fixed 的定位参照。
    document.body.append($.player, $.showPlayer);
    const animCtx = $.animCanvas.getContext('2d');
    const bgZoom = createZoomView($.bgStage, $.bgCanvas);
    const animZoom = createZoomView($.animStage, $.animCanvas);
    const lbZoom = createZoomView($.lbStage, $.lbImg);

    const state = {
      items: [], // { id, name, blob, width, height, origThumbUrl, procBlob, procThumbUrl, appliedKey, version, selected, generated, anim, card, check, img, seqEl, procEl }
      nextId: 1,
      importing: false,
      importToken: 0,
      busy: false, // 去背景 / 补帧 / 保存 / 导出中
      interp: { running: false, stop: false, token: 0 },
      colors: [], // '#rrggbb'
      view: 'result',
      picking: false,
      refId: null,
      ref: null, // { id, original: ImageData }
      refToken: 0,
      renderQueued: false,
      bgToken: 0,
      applyProgress: '',
      lastClicked: -1,
      drag: null, // { id, target: { id, after } | null }
      gifWTouched: false,
      playerHidden: localStorage.getItem(PLAYER_HIDDEN_KEY) === '1',
      anim: { list: [], playing: true, start: 0, index: 0, raf: 0, drawn: null, w: 0, h: 0, scale: 1, boxW: 0, boxH: 0 },
      lightbox: { id: null, url: null, needsFit: false, view: 'result' },
    };

    const findItem = (id) => state.items.find((it) => it.id === id);
    const indexOf = (id) => state.items.findIndex((it) => it.id === id);
    const selectedItems = () => state.items.filter((it) => it.selected);

    // ---------- 导入 ----------
    async function addFiles(fileList) {
      const files = [...fileList].filter((f) => f.type.startsWith('image/') || isSvg(f));
      if (!files.length) {
        toast('请选择图片文件');
        return;
      }
      if (state.importing) {
        toast('正在导入，请稍候');
        return;
      }
      state.importing = true;
      const token = state.importToken;
      let added = 0;
      let failed = 0;
      updateAll();
      try {
        for (let i = 0; i < files.length; i++) {
          $.add.textContent = `导入中 ${i + 1}/${files.length}`;
          let raster = files[i];
          let vector = 0; // SVG 的渲染倍数，位图为 0
          let bmp;
          try {
            if (isSvg(files[i])) {
              const info = await readSvg(files[i]);
              vector = resolveScale($.svgScale.value, info);
              raster = await rasterizeSvg(info, vector, files[i].name);
            }
            bmp = await createImageBitmap(raster);
          } catch {
            failed++;
            continue;
          }
          if (token !== state.importToken) {
            bmp.close();
            return;
          }
          const { width, height } = bmp;
          let thumb;
          try {
            thumb = await makeThumb(bmp, width, height);
          } finally {
            bmp.close();
          }
          if (token !== state.importToken) return;
          addItem(raster, width, height, thumb, { name: files[i].name, vector });
          added++;
        }
      } finally {
        if (token === state.importToken) {
          state.importing = false;
          $.add.textContent = '添加图片';
          updateAll();
        }
      }
      if (token === state.importToken) {
        toast(failed ? `已导入 ${added} 张，${failed} 张无法解码` : `已导入 ${added} 张图片`);
      }
    }

    // file 为实际使用的位图文件（SVG 已渲染为 PNG）；meta.name 为原始文件名，meta.vector 为 SVG 渲染倍数
    // meta.after 指定时插入到该图片之后（补帧），否则追加到末尾
    function addItem(file, width, height, thumb, meta = {}) {
      const item = {
        id: state.nextId++,
        name: meta.name || file.name || 'image.png',
        blob: file,
        vector: meta.vector || 0,
        width,
        height,
        origThumbUrl: URL.createObjectURL(thumb),
        procBlob: null,
        procThumbUrl: null,
        appliedKey: '',
        version: 0,
        selected: true,
        generated: Boolean(meta.generated),
        anim: null,
      };
      const card = document.createElement('div');
      card.className = 'tile selected';
      card.draggable = true;
      card.dataset.id = item.id;
      card.title = `${item.name}\n${width} × ${height}${item.vector ? `（SVG 按 ${+item.vector.toFixed(2)}× 渲染）` : ''}${item.generated ? '（补帧）' : ''}`;
      card.innerHTML = `
        <input type="checkbox" class="tile-check" checked>
        <div class="tile-actions">
          <button type="button" class="tile-action" data-action="ref" title="设为取色参考图" aria-label="设为取色参考图">${ICON_PIPETTE}</button>
          <button type="button" class="tile-action" data-action="zoom" title="放大预览" aria-label="放大预览">${ICON_ZOOM}</button>
          <button type="button" class="tile-action" data-action="download" title="下载此图" aria-label="下载此图">${ICON_DOWNLOAD}</button>
          <button type="button" class="tile-action" data-action="remove" title="移除" aria-label="移除">${ICON_REMOVE}</button>
        </div>
        <div class="tile-thumb"><img alt="" draggable="false"></div>
        <div class="tile-meta">
          <span class="badge" data-role="seq"></span>
          <span class="tile-pos ib-name" data-role="name"></span>
          ${item.vector ? `<span class="badge">SVG ${+item.vector.toFixed(2)}×</span>` : ''}
          ${item.generated ? '<span class="badge">补帧</span>' : ''}
          <span class="badge badge-success" data-role="proc" hidden>已去背景</span>
          <span class="badge" data-role="ref" hidden>取色参考</span>
          <span class="tile-size">${width} × ${height}</span>
        </div>`;
      card.querySelector('[data-role="name"]').textContent = item.name;
      item.card = card;
      item.check = card.querySelector('.tile-check');
      item.img = card.querySelector('img');
      item.seqEl = card.querySelector('[data-role="seq"]');
      item.procEl = card.querySelector('[data-role="proc"]');
      item.refEl = card.querySelector('[data-role="ref"]');
      item.img.src = item.origThumbUrl;
      if (meta.after) {
        state.items.splice(state.items.indexOf(meta.after) + 1, 0, item);
        meta.after.card.after(card);
        state.lastClicked = -1;
      } else {
        state.items.push(item);
        $.tiles.append(card);
      }
      renumber();
      if (state.items.length === 1) onFirstItem();
      updateRefSlider();
      updateAll();
      return item;
    }

    function onFirstItem() {
      for (const el of [$.listActions, $.count, $.selection, $.interpBar, $.tiles, $.bgPanel, $.exportPanel, $.spacer]) el.hidden = false;
      $.dropStage.hidden = true;
      setPlayerMode('mini');
      updatePlayerVisibility();
      setRef(state.items[0].id);
      if (!state.anim.raf) state.anim.raf = requestAnimationFrame(animLoop);
    }

    function showEmpty() {
      for (const el of [$.listActions, $.count, $.selection, $.interpBar, $.tiles, $.bgPanel, $.exportPanel, $.spacer]) el.hidden = true;
      $.dropStage.hidden = false;
      updatePlayerVisibility();
      state.refId = null;
      state.ref = null;
      state.gifWTouched = false;
      state.anim.boxW = 0; // 重新导入时按新图片重新计算画布尺寸与默认 GIF 宽度
      state.anim.boxH = 0;
      $.gifW.value = '';
      setPicking(false);
      if ($.lightbox.open) $.lightbox.close();
    }

    function renumber() {
      state.items.forEach((it, i) => {
        it.seqEl.textContent = `#${i + 1}`;
        it.check.setAttribute('aria-label', `选择第 ${i + 1} 张：${it.name}`);
      });
    }

    function releaseItem(it) {
      URL.revokeObjectURL(it.origThumbUrl);
      if (it.procThumbUrl) URL.revokeObjectURL(it.procThumbUrl);
      releaseAnim(it);
    }

    function removeItem(item) {
      const i = state.items.indexOf(item);
      if (i < 0) return;
      state.items.splice(i, 1);
      item.card.remove();
      releaseItem(item);
      if (state.lightbox.id === item.id && $.lightbox.open) $.lightbox.close();
      state.lastClicked = -1;
      if (!state.items.length) {
        showEmpty();
        updateAll();
        return;
      }
      renumber();
      if (state.refId === item.id) setRef(state.items[Math.min(i, state.items.length - 1)].id);
      updateRefSlider();
      updateAll();
    }

    function clearAll() {
      cancelInterp();
      state.importToken++;
      state.bgToken++;
      state.refToken++;
      state.importing = false;
      $.add.textContent = '添加图片';
      for (const it of state.items) releaseItem(it);
      state.items = [];
      state.lastClicked = -1;
      $.tiles.replaceChildren();
      showEmpty();
      updateAll();
    }

    $.file.addEventListener('change', () => {
      addFiles($.file.files);
      $.file.value = '';
    });
    $.add.addEventListener('click', () => $.file.click());
    $.clear.addEventListener('click', () => {
      if (state.items.length && confirm(`确定清空全部 ${state.items.length} 张图片？`)) clearAll();
    });

    // 外部文件拖入（与卡片排序拖拽区分开）
    const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    $.listPanel.addEventListener('dragover', (e) => {
      if (state.drag || !isFileDrag(e)) return;
      e.preventDefault();
      $.listPanel.classList.add('dragging');
    });
    $.listPanel.addEventListener('dragleave', (e) => {
      if (!$.listPanel.contains(e.relatedTarget)) $.listPanel.classList.remove('dragging');
    });
    $.listPanel.addEventListener('drop', (e) => {
      if (state.drag || !isFileDrag(e)) return;
      e.preventDefault();
      $.listPanel.classList.remove('dragging');
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

    // ---------- 排序 ----------
    function syncOrder() {
      $.tiles.append(...state.items.map((it) => it.card));
      renumber();
      state.lastClicked = -1;
      updateRefSlider();
      if (state.lightbox.id !== null && $.lightbox.open) updateLightboxHeader();
      updateAll();
    }

    function moveItem(from, to) {
      if (from === to || to < 0 || to >= state.items.length) return;
      const [item] = state.items.splice(from, 1);
      state.items.splice(to, 0, item);
      syncOrder();
    }

    function clearDropIndicator() {
      for (const el of $.tiles.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
    }

    $.tiles.addEventListener('dragstart', (e) => {
      const card = e.target.closest?.('.tile');
      if (!card) return;
      state.drag = { id: Number(card.dataset.id), target: null };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('dragging');
    });
    $.tiles.addEventListener('dragover', (e) => {
      if (!state.drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const card = e.target.closest('.tile');
      clearDropIndicator();
      if (!card || Number(card.dataset.id) === state.drag.id) {
        state.drag.target = null;
        return;
      }
      const r = card.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      card.classList.add(after ? 'drop-after' : 'drop-before');
      state.drag.target = { id: Number(card.dataset.id), after };
    });
    $.tiles.addEventListener('drop', (e) => {
      if (!state.drag) return;
      e.preventDefault();
      const { id, target } = state.drag;
      if (!target) return;
      const from = indexOf(id);
      let to = indexOf(target.id) + (target.after ? 1 : 0);
      if (from < to) to--; // 先移除自身，目标位置前移一位
      moveItem(from, to);
    });
    $.tiles.addEventListener('dragend', () => {
      clearDropIndicator();
      for (const el of $.tiles.querySelectorAll('.dragging')) el.classList.remove('dragging');
      state.drag = null;
    });

    // 键盘排序：聚焦卡片内控件时 Alt + ← / →
    $.tiles.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const card = e.target.closest('.tile');
      if (!card) return;
      e.preventDefault();
      const from = indexOf(Number(card.dataset.id));
      moveItem(from, from + (e.key === 'ArrowLeft' ? -1 : 1));
      e.target.focus();
    });

    // ---------- 选择 ----------
    function setSelected(it, value) {
      it.selected = value;
      it.check.checked = value;
      it.card.classList.toggle('selected', value);
    }

    $.tiles.addEventListener('click', (e) => {
      const card = e.target.closest('.tile');
      if (!card) return;
      const index = indexOf(Number(card.dataset.id));
      const item = state.items[index];
      if (!item) return;
      const action = e.target.closest('.tile-action')?.dataset.action;
      if (action === 'zoom') {
        openLightbox(index);
        return;
      }
      if (action === 'download') {
        downloadItem(item);
        return;
      }
      if (action === 'remove') {
        removeItem(item);
        return;
      }
      if (action === 'ref') {
        setRef(item.id);
        $.bgPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      // 直接点复选框时其状态已被浏览器切换
      const value = e.target === item.check ? item.check.checked : !item.selected;
      if (e.shiftKey && state.lastClicked >= 0 && state.lastClicked !== index && state.lastClicked < state.items.length) {
        const from = Math.min(state.lastClicked, index);
        const to = Math.max(state.lastClicked, index);
        for (let i = from; i <= to; i++) setSelected(state.items[i], value);
      } else {
        setSelected(item, value);
      }
      state.lastClicked = index;
      updateAll();
    });

    function setSelection(fn) {
      for (const it of state.items) setSelected(it, fn(it));
      updateAll();
    }
    $.selAll.addEventListener('click', () => setSelection(() => true));
    $.selNone.addEventListener('click', () => setSelection(() => false));
    $.selInvert.addEventListener('click', () => setSelection((it) => !it.selected));

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
      const ip = state.interp;
      $.interp.disabled = ip.running ? false : selectedItems().length < 2 || state.busy;
      if (!ip.running) $.interp.textContent = '补帧';
      $.interpClear.disabled = state.busy || !state.items.some((it) => it.generated);
      $.interpMethod.disabled = ip.running;
      $.interpCount.disabled = ip.running;
      $.interpLoop.disabled = ip.running;
    }

    function cancelInterp() {
      const ip = state.interp;
      ip.token++;
      if (ip.running) {
        ip.running = false;
        state.busy = false;
      }
    }

    // 解码原图并居中放到 w × h 的画布上
    async function itemRgba(it, ctx, w, h) {
      const bmp = await createImageBitmap(it.blob);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bmp, Math.round((w - bmp.width) / 2), Math.round((h - bmp.height) / 2));
      bmp.close();
      return ctx.getImageData(0, 0, w, h).data;
    }

    // 按当前顺序在相邻的勾选图片之间插入过渡帧。用原图补帧（不透明背景的 AI 补帧效果更好），
    // 两张源图都已按当前参数去背景时，补出的帧也按同样参数去背景
    async function interpolate() {
      const ip = state.interp;
      if (ip.running) {
        ip.stop = true;
        return;
      }
      const list = selectedItems();
      if (list.length < 2 || state.busy) return;
      const method = $.interpMethod.value;
      const count = Number($.interpCount.value);
      const pairs = list.slice(0, -1).map((it, i) => [it, list[i + 1]]);
      if ($.interpLoop.checked) pairs.push([list[list.length - 1], list[0]]);
      const total = pairs.length * count;
      const times = Array.from({ length: count }, (_, k) => (k + 1) / (count + 1));
      // 尺寸不同的图片居中放到统一画布上（与动画预览一致），补出的帧取这个尺寸
      const w = Math.max(...list.map((it) => it.width));
      const h = Math.max(...list.map((it) => it.height));
      const token = ++ip.token;
      ip.running = true;
      ip.stop = false;
      if ($.lightbox.open) $.lightbox.close();
      setBusy(true);
      $.interp.textContent = '停止补帧';
      const task = startProgress(isAiMethod(method) ? '正在加载 AI 补帧模型' : '正在补帧');
      let settled = false;
      let ai = null;
      let done = 0;
      try {
        ai = await createInterpolator(method);
        if (token !== ip.token) return;
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const procCanvas = createCanvas(1, 1);
        const label = () => (ai.backend ? `正在补帧（${ai.backend === 'webgpu' ? 'GPU' : 'CPU'}）` : '正在补帧');
        task.update(0, total, label());
        let cached = null; // 上一对的后一张就是下一对的前一张，复用解码结果
        for (const [a, b] of pairs) {
          if (ip.stop || token !== ip.token) break;
          const da = cached?.it === a ? cached.data : await itemRgba(a, ctx, w, h);
          const db = await itemRgba(b, ctx, w, h);
          cached = { it: b, data: db };
          const outs = await ai.run(da, db, w, h, times);
          if (token !== ip.token) return;
          const made = [];
          for (const data of outs) {
            ctx.putImageData(new ImageData(data, w, h), 0, 0);
            made.push({ blob: await canvasToBlob(canvas), thumb: await makeThumb(canvas, w, h) });
          }
          if (token !== ip.token) return;
          done += made.length;
          if (state.items.includes(a)) { // 补帧期间被移除的图片不再插入
            const key = bgKey();
            const params = bgParams();
            const keyed = key && a.appliedKey === key && b.appliedKey === key;
            const stem = baseName(a.name);
            let after = a;
            for (let k = 0; k < made.length; k++) {
              after = addItem(made[k].blob, w, h, made[k].thumb, { name: `${stem}_interp${k + 1}.png`, generated: true, after });
              if (keyed) {
                const out = await processItem(after, params, procCanvas);
                if (token !== ip.token) return;
                if (state.items.includes(after)) setItemOutput(after, key, out.blob, out.thumb);
              }
            }
          }
          $.interp.textContent = `停止补帧（${done}/${total}）`;
          task.update(done, total, label());
        }
        if (token !== ip.token) return;
        settled = true;
        if (done < total) {
          task.finish(`已停止补帧，插入了 ${done} 帧`);
          return;
        }
        // 帧数变为约 (count + 1) 倍，动画帧率同步提高以保持原来的播放时长
        const fps = Math.min(GIF_MAX_FPS, Math.round(animFps() * (count + 1) * 100) / 100);
        $.animFps.value = fps;
        $.animFps.dispatchEvent(new Event('input'));
        task.finish(`补帧完成，插入 ${done} 帧，动画帧率调整为 ${fps} fps`);
      } catch (err) {
        settled = true;
        task.fail(token === ip.token ? `补帧失败：${err.message}` : '补帧已中断');
      } finally {
        ai?.dispose();
        if (!settled) task.fail('补帧已中断');
        if (token === ip.token) {
          ip.running = false;
          setBusy(false);
        }
      }
    }

    $.interp.addEventListener('click', interpolate);
    $.interpClear.addEventListener('click', () => {
      const list = state.items.filter((it) => it.generated);
      if (!list.length || state.busy) return;
      for (const it of list) removeItem(it);
      toast(`已移除 ${list.length} 个补帧`);
    });

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

    function outputBlob(it) {
      return it.appliedKey ? it.procBlob : it.blob;
    }

    function setItemOutput(it, key, procBlob, procThumb) {
      if (it.procThumbUrl) URL.revokeObjectURL(it.procThumbUrl);
      it.procBlob = procBlob;
      it.procThumbUrl = procThumb ? URL.createObjectURL(procThumb) : null;
      it.appliedKey = key;
      it.version++;
      it.img.src = it.procThumbUrl || it.origThumbUrl;
      it.procEl.hidden = !key;
      if ($.lightbox.open && state.lightbox.id === it.id) showLightboxItem(indexOf(it.id));
    }

    async function processItem(it, params, canvas) {
      const bmp = await createImageBitmap(it.blob);
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

    // 只处理勾选且结果与当前参数不一致的图片；参数在处理期间被修改时，剩余图片仍按开始时的参数处理
    async function applyToSelected() {
      const key = bgKey();
      if (!key || state.busy) return;
      const list = selectedItems().filter((it) => it.appliedKey !== key);
      if (!list.length) return;
      const token = state.bgToken;
      const params = bgParams();
      const canvas = createCanvas(1, 1);
      let done = 0;
      setBusy(true);
      try {
        for (let n = 0; n < list.length; n++) {
          const it = list[n];
          state.applyProgress = `${n + 1}/${list.length}`;
          updateBgStatus();
          if (!state.items.includes(it)) continue; // 处理期间被移除
          const out = await processItem(it, params, canvas);
          if (token !== state.bgToken) return;
          if (!state.items.includes(it)) continue;
          setItemOutput(it, key, out.blob, out.thumb);
          done++;
        }
        toast(`已对 ${done} 张图片去除背景`);
      } catch (err) {
        if (token === state.bgToken) toast(`去除背景失败：${err.message}`);
      } finally {
        state.applyProgress = '';
        setBusy(false);
      }
    }

    function restoreSelected() {
      if (state.busy) return;
      const list = selectedItems().filter((it) => it.appliedKey);
      for (const it of list) setItemOutput(it, '', null, null);
      if (list.length) toast(`已还原 ${list.length} 张图片`);
      updateAll();
    }

    $.apply.addEventListener('click', applyToSelected);
    $.restore.addEventListener('click', restoreSelected);

    function updateBgStatus() {
      const key = bgKey();
      const sel = selectedItems();
      const pending = key ? sel.filter((it) => it.appliedKey !== key).length : 0;
      const applied = sel.filter((it) => it.appliedKey).length;
      if (state.applyProgress) $.bgStatus.textContent = `处理中 ${state.applyProgress}`;
      else if (!sel.length) $.bgStatus.textContent = '未勾选图片';
      else if (!$.bgEnabled.checked) $.bgStatus.textContent = '已关闭去除背景';
      else if (!key) $.bgStatus.textContent = '未选择背景颜色';
      else if (pending) $.bgStatus.textContent = `所选 ${sel.length} 张中 ${pending} 张待应用`;
      else $.bgStatus.textContent = '所选图片已全部应用';
      $.apply.disabled = state.busy || !pending;
      $.apply.textContent = state.applyProgress
        ? `处理中（${state.applyProgress}）`
        : pending ? `应用到所选图片（${pending}）` : '应用到所选图片';
      $.restore.disabled = state.busy || !applied;
    }

    function updateRefSlider() {
      const idx = indexOf(state.refId);
      const n = state.items.length;
      $.refIndex.max = Math.max(0, n - 1);
      $.refIndex.disabled = n < 2;
      for (const it of state.items) it.refEl.hidden = it.id !== state.refId;
      $.refPrev.hidden = $.refNext.hidden = n < 2;
      $.refPrev.disabled = idx <= 0;
      $.refNext.disabled = idx < 0 || idx >= n - 1;
      if (idx < 0) {
        $.refOut.textContent = '';
        $.refCaption.hidden = true;
        return;
      }
      const it = state.items[idx];
      $.refIndex.value = idx;
      $.refOut.textContent = `#${idx + 1} · ${it.name}`;
      $.refCaption.hidden = false;
      $.refCaption.textContent = `参考图 ${idx + 1} / ${n} · ${it.name}`;
    }

    function stepRef(delta) {
      const next = state.items[indexOf(state.refId) + delta];
      if (next) setRef(next.id);
    }

    async function setRef(id) {
      const it = findItem(id);
      if (!it) return;
      state.refId = id;
      updateRefSlider();
      const token = ++state.refToken;
      let bmp;
      try {
        bmp = await createImageBitmap(it.blob);
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
      state.ref = { id, original: ctx.getImageData(0, 0, c.width, c.height) };
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
      updateExportPlan();
    }

    $.tolerance.addEventListener('input', onBgParamsChange);
    $.feather.addEventListener('input', onBgParamsChange);
    $.bgEnabled.addEventListener('change', onBgParamsChange);
    $.refIndex.addEventListener('input', () => {
      const it = state.items[Number($.refIndex.value)];
      if (it) setRef(it.id);
    });
    $.refPrev.addEventListener('click', () => stepRef(-1));
    $.refNext.addEventListener('click', () => stepRef(1));
    // 鼠标停在参考图上时可用 ← / → 切换
    let bgHover = false;
    $.bgStage.addEventListener('mouseenter', () => (bgHover = true));
    $.bgStage.addEventListener('mouseleave', () => (bgHover = false));

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

    // ---------- 动画预览 ----------
    function animFps() {
      const v = readNumber($.animFps);
      return v > 0 ? Math.min(v, GIF_MAX_FPS) : 8;
    }

    function releaseAnim(it) {
      it.anim?.bitmap?.close();
      it.anim?.stale?.close();
      it.anim = null;
    }

    // 画布为所选图片的最大宽高（长边不超过 ANIM_MAX），尺寸不同的图片居中绘制
    function refreshAnimList() {
      const a = state.anim;
      a.list = selectedItems();
      for (const it of state.items) if (!it.selected) releaseAnim(it);
      const boxW = Math.max(0, ...a.list.map((it) => it.width));
      const boxH = Math.max(0, ...a.list.map((it) => it.height));
      if (boxW && (boxW !== a.boxW || boxH !== a.boxH)) {
        a.boxW = boxW;
        a.boxH = boxH;
        a.scale = Math.min(1, ANIM_MAX / Math.max(boxW, boxH));
        a.w = Math.max(1, Math.round(boxW * a.scale));
        a.h = Math.max(1, Math.round(boxH * a.scale));
        $.animCanvas.width = a.w;
        $.animCanvas.height = a.h;
        animZoom.refresh();
        if (!state.gifWTouched) $.gifW.value = Math.min(boxW, 480);
      }
      if (a.index >= a.list.length) a.index = 0;
      a.start = performance.now() - (a.index * 1000) / animFps();
      a.drawn = null;
      const empty = !a.list.length;
      $.animEmpty.hidden = !empty;
      $.animCanvas.hidden = empty;
      if (empty) $.animOut.textContent = '未勾选';
    }

    function animSize(it) {
      const s = state.anim.scale;
      return { w: Math.max(1, Math.round(it.width * s)), h: Math.max(1, Math.round(it.height * s)) };
    }

    // 按需解码缩小的预览位图；新位图就绪前继续显示旧的，避免闪烁
    function animBitmap(it) {
      const { w, h } = animSize(it);
      const key = `${it.version}|${w}x${h}`;
      let entry = it.anim;
      if (!entry || entry.key !== key) {
        const stale = entry ? entry.bitmap || entry.stale : null;
        entry = { key, bitmap: null, stale };
        it.anim = entry;
        decodeScaled(outputBlob(it), w, h)
          .then((bmp) => {
            if (it.anim !== entry) {
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
      if (!n || $.player.hidden) return;
      if (a.playing) a.index = Math.floor(((now - a.start) * animFps()) / 1000) % n;
      for (let k = 1; k <= 3 && k < n; k++) animBitmap(a.list[(a.index + k) % n]);
      const it = a.list[a.index];
      const bmp = animBitmap(it);
      if (bmp && bmp !== a.drawn) {
        const { w, h } = animSize(it);
        animCtx.clearRect(0, 0, a.w, a.h);
        animCtx.drawImage(bmp, Math.round((a.w - w) / 2), Math.round((a.h - h) / 2), w, h);
        a.drawn = bmp;
        $.animOut.textContent = `${a.index + 1} / ${n}`;
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

    function setPlayerMode(mode) {
      const expanded = mode === 'expanded';
      $.player.dataset.mode = mode;
      $.expand.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
      $.expand.title = expanded ? '缩小到右下角' : '放大预览';
      $.expand.setAttribute('aria-label', $.expand.title);
      animZoom.fit();
    }

    $.play.addEventListener('click', () => setPlaying(!state.anim.playing));
    $.prev.addEventListener('click', () => stepAnim(-1));
    $.next.addEventListener('click', () => stepAnim(1));
    $.animFps.addEventListener('input', () => {
      state.anim.start = performance.now() - (state.anim.index * 1000) / animFps();
      updateExportPlan();
    });
    $.expand.addEventListener('click', () => {
      setPlayerMode($.player.dataset.mode === 'expanded' ? 'mini' : 'expanded');
    });

    // 隐藏后只在右下角保留一个“动画预览”按钮，并停止绘制与解码；隐藏状态会被记住
    function updatePlayerVisibility() {
      const hasItems = state.items.length > 0;
      $.player.hidden = !hasItems || state.playerHidden;
      $.showPlayer.hidden = !hasItems || !state.playerHidden;
      $.spacer.classList.toggle('is-compact', state.playerHidden);
    }

    function setPlayerHidden(on) {
      state.playerHidden = on;
      localStorage.setItem(PLAYER_HIDDEN_KEY, on ? '1' : '0');
      updatePlayerVisibility();
      if (on) {
        $.showPlayer.focus();
      } else {
        state.anim.drawn = null;
        animZoom.fit();
        $.hidePlayer.focus();
      }
    }

    $.hidePlayer.addEventListener('click', () => setPlayerHidden(true));
    $.showPlayer.addEventListener('click', () => setPlayerHidden(false));
    $.animStage.addEventListener('dblclick', (e) => {
      if ($.player.dataset.mode === 'mini' && !e.target.closest('.zoom-bar')) setPlayerMode('expanded');
    });

    // ---------- 保存与导出 ----------
    // 去过背景或由 SVG 渲染来的输出 PNG，其余保留原扩展名
    function outputName(it, seq, digits) {
      const ext = it.appliedKey || it.vector ? 'png' : (/\.([a-z0-9]+)$/i.exec(it.name)?.[1].toLowerCase() || MIME_EXT[it.blob.type] || 'png');
      return `${String(seq).padStart(digits, '0')}_${baseName(it.name)}.${ext}`;
    }

    const digitsFor = (n) => Math.max(2, String(n).length);

    function downloadItem(it) {
      downloadBlob(outputBlob(it), outputName(it, indexOf(it.id) + 1, digitsFor(state.items.length)));
    }

    function gifSize() {
      const a = state.anim;
      const w = readNumber($.gifW);
      if (!a.boxW || !Number.isInteger(w) || w < 1 || w > GIF_MAX_W) return null;
      return { w, h: Math.max(1, Math.round((w * a.boxH) / a.boxW)) };
    }

    function updateExportPlan() {
      const sel = selectedItems();
      const n = sel.length;
      const size = gifSize();
      if (!n) {
        $.exportPlan.textContent = '请先在上方勾选需要的图片';
      } else {
        const fps = animFps();
        $.exportPlan.innerHTML = `已选 <b>${n}</b> 张，按当前顺序输出`
          + (size ? ` · GIF <b>${size.w}×${size.h}</b> px，约 <b>${(n / fps).toFixed(2)}</b> 秒（${fps} fps）` : '');
        const notes = [];
        if (!size) notes.push(`请输入有效的 GIF 宽度（1 ~ ${GIF_MAX_W}）`);
        const key = bgKey();
        const pending = key ? sel.filter((it) => it.appliedKey !== key).length : 0;
        if (pending) notes.push(`${pending} 张所选图片尚未按当前参数去除背景，将按卡片当前显示的效果输出`);
        if (sel.some((it) => it.width !== sel[0].width || it.height !== sel[0].height)) {
          notes.push('所选图片尺寸不一致，动画与 GIF 中会居中对齐');
        }
        for (const text of notes) {
          const span = document.createElement('span');
          span.className = 'plan-note';
          span.textContent = text;
          $.exportPlan.append(span);
        }
      }
      $.save.textContent = `保存选中到本地 (${n})`;
      $.save.disabled = !n || state.busy;
      $.zip.disabled = !n || state.busy;
      $.gif.disabled = !n || !size || state.busy;
    }

    $.gifW.addEventListener('input', () => {
      state.gifWTouched = true;
      updateExportPlan();
    });
    $.gifBg.addEventListener('change', () => {
      $.gifMatte.disabled = $.gifBg.value !== 'color';
    });

    function setBusy(on) {
      state.busy = on;
      updateAll();
    }

    function updateAll() {
      const n = state.items.length;
      $.count.textContent = `共 ${n} 张 · 已选 ${selectedItems().length} 张`;
      $.clear.disabled = state.busy;
      updateInterp();
      updateBgStatus();
      refreshAnimList();
      updateExportPlan();
    }

    async function exportGif() {
      const list = selectedItems();
      const size = gifSize();
      if (!list.length || !size || state.busy) return;
      setBusy(true);
      const task = startProgress('正在编码 GIF', list.length);
      try {
        const k = size.w / state.anim.boxW;
        const delays = gifDelays(list.length, animFps());
        const matte = $.gifBg.value === 'color' ? $.gifMatte.value : null;
        const encoder = new GifEncoder(size.w, size.h, { loop: Number($.gifLoop.value) });
        const canvas = createCanvas(size.w, size.h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          const w = Math.max(1, Math.round(it.width * k));
          const h = Math.max(1, Math.round(it.height * k));
          const bmp = await decodeScaled(outputBlob(it), w, h);
          ctx.clearRect(0, 0, size.w, size.h);
          if (matte) {
            ctx.fillStyle = matte;
            ctx.fillRect(0, 0, size.w, size.h);
          }
          ctx.drawImage(bmp, Math.round((size.w - w) / 2), Math.round((size.h - h) / 2), w, h);
          bmp.close();
          encoder.addFrame(ctx.getImageData(0, 0, size.w, size.h).data, delays[i]);
          $.gif.textContent = `编码中 ${i + 1}/${list.length}`;
          task.update(i + 1, list.length);
          await nextTick();
        }
        const blob = encoder.finish();
        downloadBlob(blob, `${baseName(list[0].name)}_${list.length}张.gif`);
        task.finish(`GIF 已生成（${list.length} 帧，${formatBytes(blob.size)}），浏览器开始下载`);
      } catch (err) {
        task.fail(`导出 GIF 失败：${err.message}`);
      } finally {
        $.gif.textContent = '导出 GIF';
        setBusy(false);
      }
    }

    $.gif.addEventListener('click', exportGif);

    async function saveSelected(asZip) {
      const chosen = selectedItems();
      if (!chosen.length || state.busy) return;
      const digits = digitsFor(chosen.length);
      const files = chosen.map((it, i) => ({ name: outputName(it, i + 1, digits), blob: outputBlob(it) }));
      const dir = asZip ? null : await pickFolder('image-batch');
      if (dir === undefined) return;
      setBusy(true);
      const task = startProgress('准备保存', files.length);
      try {
        await writeFiles(files, {
          dir,
          zipName: `${baseName(chosen[0].name)}_${chosen.length}张.zip`,
          task,
          summary: `${files.length} 张图片`,
        });
      } catch (err) {
        task.fail(`保存失败：${err.message}`);
      } finally {
        setBusy(false);
      }
    }

    $.save.addEventListener('click', () => saveSelected(false));
    $.zip.addEventListener('click', () => saveSelected(true));

    // ---------- 放大预览 ----------
    function updateLightboxHeader() {
      const index = indexOf(state.lightbox.id);
      const it = state.items[index];
      if (!it) return;
      const lb = state.lightbox;
      $.lbTitle.textContent = `第 ${index + 1} / ${state.items.length} 张`;
      $.lbMeta.textContent = `${it.width}×${it.height}`;
      $.lbName.textContent = it.name;
      $.lbPrev.disabled = index === 0;
      $.lbNext.disabled = index === state.items.length - 1;
      $.lbSelect.textContent = it.selected ? '✓ 已选中' : '选中此图';
      $.lbSelect.classList.toggle('btn-primary', it.selected);
      const processed = Boolean(it.appliedKey);
      const showResult = processed && lb.view === 'result';
      $.lbViewResult.disabled = !processed;
      $.lbViewResult.setAttribute('aria-pressed', String(showResult));
      $.lbViewOriginal.setAttribute('aria-pressed', String(!showResult));
      $.lbViewResult.title = processed ? '' : '此图尚未去除背景';
    }

    function showLightboxItem(index) {
      const it = state.items[index];
      if (!it) return;
      const lb = state.lightbox;
      lb.id = it.id;
      updateLightboxHeader();
      const blob = it.appliedKey && lb.view === 'result' ? it.procBlob : it.blob;
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
      showLightboxItem(index);
    }

    function stepLightbox(delta) {
      const next = indexOf(state.lightbox.id) + delta;
      if (next >= 0 && next < state.items.length) showLightboxItem(next);
    }

    function setLightboxView(view) {
      state.lightbox.view = view;
      showLightboxItem(indexOf(state.lightbox.id));
    }

    // 切换到同尺寸的图片或切换原图 / 去背景后时保留缩放与位置，方便对比同一处细节
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
    $.lbViewResult.addEventListener('click', () => setLightboxView('result'));
    $.lbViewOriginal.addEventListener('click', () => setLightboxView('original'));
    $.lbDownload.addEventListener('click', () => {
      const it = findItem(state.lightbox.id);
      if (it) downloadItem(it);
    });
    $.lbSelect.addEventListener('click', () => {
      const index = indexOf(state.lightbox.id);
      const it = state.items[index];
      if (!it) return;
      setSelected(it, !it.selected);
      state.lastClicked = index;
      updateAll();
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
      lb.id = null;
      $.lbImg.removeAttribute('src');
      if (lb.url) URL.revokeObjectURL(lb.url);
      lb.url = null;
    });

    // ← / →：鼠标停在参考图上时切换参考图
    // Esc：先取消取色，其次把放大的动画预览缩回右下角（预览弹窗打开时由弹窗自己处理）
    const onKeydown = (e) => {
      if ($.lightbox.open) return;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && bgHover && !e.altKey
        && !e.target.closest?.('input, select, textarea')) {
        e.preventDefault();
        stepRef(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.key !== 'Escape') return;
      if (state.picking) setPicking(false);
      else if ($.player.dataset.mode === 'expanded') setPlayerMode('mini');
    };
    document.addEventListener('keydown', onKeydown);

    renderColors();
    updateAll();

    // 其他工具（如智能切图）发送过来的图片
    const incoming = takeHandoff('image-batch');
    if (incoming?.length) addFiles(incoming);

    // ---------- 卸载 ----------
    return () => {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('paste', onPaste);
      cancelAnimationFrame(state.anim.raf);
      bgZoom.destroy();
      animZoom.destroy();
      lbZoom.destroy();
      cancelInterp();
      state.importToken++;
      state.bgToken++;
      state.refToken++;
      for (const it of state.items) releaseItem(it);
      state.items = [];
      if ($.lightbox.open) $.lightbox.close();
      $.player.remove();
      $.showPlayer.remove();
    };
  },
};
