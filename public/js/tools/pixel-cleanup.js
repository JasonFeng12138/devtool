import { collectRefs, ICON_UPLOAD, startProgress, toast } from '../lib/ui.js';
import { pickFolder, writeFiles } from '../lib/save.js';
import { handoff, takeHandoff } from '../lib/handoff.js';
import { createZoomView } from '../lib/zoom.js';
import { analyzeGrid, cleanupPixels, gridBoundary, processPixelBatch, MAX_LOGICAL_SIDE, MAX_OUTPUT_PIXELS, MAX_SIDE, MAX_SOURCE_PIXELS } from '../lib/pixel-cleanup.js';

const TEMPLATE = `
<section class="panel">
  <div class="panel-header">
    <h2 class="section-title">像素设置</h2>
    <button type="button" class="btn" data-ref="change">添加图片</button>
  </div>
  <div class="tool-split">
    <div class="pc-preview">
      <div class="tool-toolbar" data-ref="toolbar" hidden>
        <label class="inline-field">预览
          <select data-ref="view"><option value="compare">对比</option><option value="result">处理结果</option><option value="source">原图</option></select>
        </label>
        <label class="check" title="显示原图上的采样网格；导出不包含网格"><input type="checkbox" data-ref="grid">网格</label>
        <button type="button" class="btn" data-ref="enlarge" title="放大查看当前图片">放大查看</button>
      </div>
      <div class="stage scroll-area" data-ref="uploadStage">
        <label class="dropzone">
          <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/bmp,image/avif,.png,.jpg,.jpeg,.webp,.bmp,.avif" aria-label="批量选择静态图片" data-ref="file">
          ${ICON_UPLOAD}
          <span class="dropzone-title">选择像素风图片</span>
          <span class="dropzone-hint">支持多选、拖拽或 Ctrl+V 粘贴 · PNG / JPEG / WebP / BMP / AVIF</span>
        </label>
      </div>
      <div class="stage zoom-stage pc-stage scroll-area" data-ref="previewStage" hidden tabindex="0" aria-label="图片对比画布" title="拖动分界线对比，滚轮缩放，拖拽空白处平移；← → 切换图片，双击放大">
        <canvas class="checker pc-canvas" data-ref="canvas" aria-label="像素规整对比预览"></canvas>
        <span class="stage-caption glass" data-ref="caption"></span>
        <button type="button" class="pc-divider" data-ref="divider" role="slider" aria-label="拖动原图与结果分界线" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" title="左右拖动对比；方向键微调" hidden><span class="pc-divider-grip" aria-hidden="true">‹ ›</span></button>
        <button type="button" class="stage-nav stage-nav-prev" data-ref="prev" title="上一张（←）" aria-label="上一张图片">‹</button>
        <button type="button" class="stage-nav stage-nav-next" data-ref="next" title="下一张（→）" aria-label="下一张图片">›</button>
      </div>
      <p class="plan-note pc-status" data-ref="status" role="status" aria-live="polite"></p>
    </div>
    <div class="controls">
      <div class="file-meta" data-ref="fileMeta" hidden></div>
      <fieldset class="pc-settings" data-ref="settings" disabled>
        <div class="control-group">
          <div class="field-label"><span>像素网格</span><button type="button" class="btn" data-ref="analyze">自动识别</button></div>
          <label class="field">逻辑分辨率
            <select data-ref="preset" title="长边的美术像素数量；短边按原图比例计算">
              <option value="custom">自定义</option><option value="32">长边 32 像素</option><option value="64">长边 64 像素</option><option value="128">长边 128 像素</option><option value="256">长边 256 像素</option><option value="512">长边 512 像素</option>
            </select>
          </label>
          <div class="field-row">
            <label class="field">逻辑宽<input type="number" min="1" max="512" step="1" value="128" data-ref="cols"></label>
            <label class="field">逻辑高<input type="number" min="1" max="512" step="1" value="128" data-ref="rows"></label>
          </div>
          <label class="check"><input type="checkbox" checked data-ref="lock">保持原图比例</label>
          <div class="field-row">
            <label class="field" title="按原图像素移动内部网格线，边缘格保留到画布边界">横向偏移<input type="number" value="0" step="1" data-ref="offsetX"></label>
            <label class="field" title="按原图像素移动内部网格线，边缘格保留到画布边界">纵向偏移<input type="number" value="0" step="1" data-ref="offsetY"></label>
          </div>
          <span class="plan-note" data-ref="gridNote"></span>
        </div>
        <div class="control-group">
          <label class="field">色彩数量
            <select data-ref="colors"><option value="0">保留原色</option><option value="16">最多 16 色</option><option value="32" selected>最多 32 色</option><option value="64">最多 64 色</option><option value="128">最多 128 色</option></select>
          </label>
          <label class="check" title="将每格透明度按 128 阈值变为全透明或不透明"><input type="checkbox" data-ref="hardAlpha">硬边透明</label>
          <label class="check" title="删除八个相邻格都透明的孤立像素，可能移除高光或粒子"><input type="checkbox" data-ref="removeNoise">清理孤立像素</label>
        </div>
      </fieldset>
      <div class="actions actions-stack">
        <button type="button" class="btn btn-primary" data-ref="generate" disabled>应用到全部图片</button>
        <button type="button" class="btn" data-ref="cancel" hidden>取消处理</button>
      </div>
    </div>
  </div>
</section>
<section class="panel" data-ref="batchPanel" hidden>
  <div class="panel-header">
    <div class="panel-heading"><h2 class="section-title">图片</h2><span class="badge" data-ref="batchCount"></span></div>
    <div class="actions">
      <div class="segmented" role="group" aria-label="批量选择">
        <button type="button" class="segmented-item" data-ref="selectAll">全选</button>
        <button type="button" class="segmented-item" data-ref="selectNone">全不选</button>
      </div>
      <button type="button" class="btn" data-ref="clear">清空</button>
    </div>
  </div>
  <div class="tool-toolbar">
    <button type="button" class="btn" data-ref="batchGenerate" disabled>应用到勾选图片</button>
  </div>
  <div class="pc-items scroll-area" data-ref="items"></div>
</section>
<section class="panel" data-ref="output" hidden>
  <div class="panel-header"><h2 class="section-title">输出 PNG</h2><span class="badge" data-ref="colorCount"></span></div>
  <div class="export-grid">
    <label class="field">输出倍数
      <select data-ref="scale"><option value="1">1 倍</option><option value="2">2 倍</option><option value="4" selected>4 倍</option><option value="8">8 倍</option><option value="16">16 倍</option></select>
    </label>
    <label class="field">当前文件名<input type="text" data-ref="name" value="pixel" autocomplete="off"></label>
  </div>
  <div class="plan" data-ref="plan"></div>
  <p class="plan-note" data-ref="outputNote"></p>
  <div class="actions export-actions">
    <button type="button" class="btn" data-ref="send" disabled>发送到图片批处理</button>
    <button type="button" class="btn" data-ref="zip" disabled>打包 ZIP 下载</button>
    <button type="button" class="btn btn-primary" data-ref="save" disabled>保存选中到本地</button>
  </div>
</section>
<dialog class="lightbox glass pc-lightbox" data-ref="lightbox" aria-label="像素图片放大预览">
  <div class="lightbox-header">
    <div class="panel-heading"><h2 class="section-title">放大查看</h2><span class="lightbox-name" data-ref="lbName"></span></div>
    <div class="actions">
      <label class="inline-field">预览<select data-ref="lbView"><option value="compare">对比</option><option value="result">处理结果</option><option value="source">原图</option></select></label>
      <button type="button" class="btn" data-ref="lbClose" title="关闭（Esc）">关闭</button>
    </div>
  </div>
  <div class="lightbox-body" data-ref="lbBody"></div>
</dialog>`;

const baseName = (name) => (name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/[.\s]+$/g, '').trim() || 'pixel');
const abortError = () => new DOMException('已取消处理', 'AbortError');
const int = (el) => el.value === '' ? NaN : Number(el.value);

export default {
  id: 'pixel-cleanup',
  name: '像素规整',
  description: '统一像素网格、整理杂色，生成清晰的像素图',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6zM12 3v18M3 12h18"/></svg>',

  mount(root) {
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);
    const state = { items: [], currentId: null, seq: 0, recipe: null, split: 50, splitPointer: null, paintFrame: 0, source: null, result: null, token: 0, loadToken: 0, exportToken: 0, busy: false, batchBusy: false, batchLabel: '', loading: false, importing: false, exporting: false, disposed: false, job: null, timer: 0, exportTask: null };
    const sourceCanvas = document.createElement('canvas');
    const nativeCanvas = document.createElement('canvas');
    const thumbSource = document.createElement('canvas');
    const previewHome = document.createComment('像素画布原位置');
    $.previewStage.before(previewHome);
    const ctx = $.canvas.getContext('2d');
    const zoom = createZoomView($.previewStage, $.canvas, { onChange: drawPreview });

    function check(token) { if (state.disposed || token !== state.token) throw abortError(); }

    const currentItem = () => state.items.find((item) => item.id === state.currentId);
    const selectedItems = () => state.items.filter((item) => item.selected);

    function updateItem(item) {
      const refs = item.refs;
      if (!refs) return;
      refs.selected.checked = item.selected;
      refs.selected.disabled = state.batchBusy || state.loading || state.exporting;
      refs.preview.disabled = state.batchBusy || state.importing || state.exporting;
      refs.enlarge.disabled = state.batchBusy || state.importing || state.exporting;
      refs.remove.disabled = state.busy || state.loading || state.exporting;
      item.card.classList.toggle('is-current', item.id === state.currentId);
      item.card.classList.toggle('selected', item.selected);
      refs.preview.setAttribute('aria-pressed', String(item.id === state.currentId));
      refs.meta.textContent = `${item.width}×${item.height} → ${item.result ? `${item.result.width}×${item.result.height} · ${item.result.colorCount} 色` : '待生成'}`;
      refs.status.textContent = item.processing ? '处理中' : item.error ? `失败：${item.error}` : item.result ? '已完成' : '待处理';
      refs.status.classList.toggle('is-error', !!item.error);
      if (item.thumbResult !== item.result) {
        item.thumbResult = item.result;
        refs.thumb.hidden = !!item.result;
        refs.thumbCanvas.hidden = !item.result;
        if (item.result) {
          const r = item.result, ratio = Math.min(1, 128 / Math.max(r.width, r.height));
          thumbSource.width = r.width; thumbSource.height = r.height;
          thumbSource.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
          refs.thumbCanvas.width = Math.max(1, Math.round(r.width * ratio)); refs.thumbCanvas.height = Math.max(1, Math.round(r.height * ratio));
          const context = refs.thumbCanvas.getContext('2d');
          context.imageSmoothingEnabled = false;
          context.drawImage(thumbSource, 0, 0, refs.thumbCanvas.width, refs.thumbCanvas.height);
          thumbSource.width = thumbSource.height = 1;
        } else refs.thumbCanvas.width = refs.thumbCanvas.height = 1;
      }
    }

    function renderItems() {
      for (const item of state.items) {
        if (!item.card) {
          const card = document.createElement('div');
          card.className = 'tile pc-item';
          card.innerHTML = `<input type="checkbox" class="tile-check" data-ref="selected"><button type="button" class="pc-item-preview" data-ref="preview"><span class="tile-thumb"><img alt="" data-ref="thumb"><canvas data-ref="thumbCanvas" hidden></canvas></span><span class="pc-item-info"><span class="pc-item-name" data-ref="name"></span><span class="plan-note" data-ref="meta"></span><span class="plan-note" data-ref="status"></span></span></button><div class="tile-actions"><button type="button" class="tile-action" title="放大查看" aria-label="放大查看" data-ref="enlarge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M10 7v6M7 10h6"/></svg></button><button type="button" class="tile-action" title="移除图片" aria-label="移除图片" data-ref="remove">×</button></div>`;
          const refs = collectRefs(card);
          item.card = card; item.refs = refs;
          refs.name.textContent = item.name;
          refs.preview.title = item.name;
          refs.thumb.src = item.url;
          refs.selected.setAttribute('aria-label', `选择 ${item.name}`);
          refs.selected.addEventListener('change', () => { item.selected = refs.selected.checked; updateButtons(); });
          refs.preview.addEventListener('click', () => selectItem(item.id));
          refs.preview.addEventListener('dblclick', () => openLightbox(item.id));
          refs.enlarge.addEventListener('click', () => openLightbox(item.id));
          refs.remove.addEventListener('click', () => removeItem(item.id));
        }
        updateItem(item);
      }
      $.items.replaceChildren(...state.items.map((item) => item.card));
      updateButtons();
    }

    function stopJob() {
      clearTimeout(state.timer);
      state.token++;
      state.job?.cancel();
      state.job = null;
      state.busy = false;
      state.batchBusy = false;
      state.batchLabel = '';
      for (const item of state.items) item.processing = false;
    }

    function updateButtons() {
      $.generate.disabled = !state.source || state.busy || state.loading || state.exporting;
      $.generate.textContent = state.busy || state.exporting ? $.generate.textContent : `应用到全部图片 (${state.items.length})`;
      $.cancel.hidden = !(state.busy || state.loading || state.exporting);
      $.analyze.disabled = state.busy || state.loading || state.exporting;
      $.settings.disabled = !state.source || state.loading || state.exporting || state.batchBusy;
      $.change.disabled = state.loading || state.exporting || state.batchBusy;
      $.file.disabled = state.loading || state.exporting || state.batchBusy;
      $.scale.disabled = state.exporting || state.batchBusy;
      $.name.disabled = !state.source || state.loading || state.exporting || state.batchBusy;
      const chosen = selectedItems();
      $.batchPanel.hidden = state.items.length === 0;
      $.batchCount.textContent = `共 ${state.items.length} 张 · 已勾选 ${chosen.length} 张`;
      $.batchGenerate.disabled = !chosen.length || state.busy || state.loading || state.exporting || !state.source;
      if (!state.batchBusy) $.batchGenerate.textContent = `应用到勾选图片 (${chosen.length})`;
      const index = state.items.findIndex((item) => item.id === state.currentId);
      const navigating = state.batchBusy || state.importing || state.exporting;
      $.prev.hidden = $.next.hidden = state.items.length < 2;
      $.prev.disabled = navigating || index <= 0;
      $.next.disabled = navigating || index < 0 || index >= state.items.length - 1;
      $.enlarge.disabled = !state.source || state.loading || state.batchBusy || state.exporting;
      for (const el of [$.selectAll, $.selectNone, $.clear]) el.disabled = state.busy || state.loading || state.exporting;
      for (const item of state.items) updateItem(item);
      updateOutput();
    }

    function readOptions() {
      const s = state.source;
      const cols = int($.cols), rows = int($.rows), offsetX = int($.offsetX), offsetY = int($.offsetY);
      if (!s || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > Math.min(s.width, MAX_LOGICAL_SIDE) || rows > Math.min(s.height, MAX_LOGICAL_SIDE)) throw new Error('逻辑宽高须为 1～512 之间且不大于原图的整数');
      if (!Number.isInteger(offsetX) || !Number.isInteger(offsetY) || Math.abs(offsetX) > Math.floor((s.width / cols - 1) / 2) || Math.abs(offsetY) > Math.floor((s.height / rows - 1) / 2)) throw new Error('请在输入框限定范围内设置网格偏移');
      return { cols, rows, offsetX, offsetY, colors: int($.colors), hardAlpha: $.hardAlpha.checked, removeNoise: $.removeNoise.checked };
    }

    function limitOffsets(reset = false, clamp = true) {
      if (!state.source) return;
      for (const [input, count, size] of [[$.offsetX, int($.cols), state.source.width], [$.offsetY, int($.rows), state.source.height]]) {
        if (!Number.isFinite(count) || count < 1) continue;
        const max = Math.max(0, Math.floor((size / count - 1) / 2));
        input.min = -max;
        input.max = max;
        if (reset || clamp) input.value = reset ? 0 : Math.max(-max, Math.min(max, Number(input.value) || 0));
      }
    }

    function updateOutput() {
      const r = state.result, s = state.source;
      $.output.hidden = !state.items.length;
      const scale = int($.scale);
      const chosen = selectedItems(), ready = chosen.filter((item) => item.result);
      const oversized = ready.filter((item) => !validOutput(item.result, scale)).length;
      const valid = chosen.length && ready.length === chosen.length && !oversized && !state.busy && !state.loading && !state.exporting;
      for (const button of [$.save, $.zip, $.send]) button.disabled = !valid;
      $.save.textContent = `保存选中到本地 (${chosen.length})`;
      $.zip.textContent = `打包选中 ZIP (${chosen.length})`;
      $.send.textContent = `发送选中到图片批处理 (${chosen.length})`;
      $.plan.textContent = r && s ? `当前：原图 ${s.width}×${s.height} → 逻辑 ${r.width}×${r.height} → 输出 ${r.width * scale}×${r.height * scale} px（${scale} 倍）` : `已选 ${chosen.length} 张，已生成 ${ready.length} 张`;
      $.colorCount.textContent = `已生成 ${state.items.filter((item) => item.result).length}/${state.items.length} 张`;
      $.outputNote.textContent = oversized ? `${oversized} 张输出过大，请降低倍数（单张最长边 8192，最多 1600 万像素）` : ready.length < chosen.length ? `勾选图片中有 ${chosen.length - ready.length} 张未生成，可点击「应用到全部图片」。` : '勾选结果按网格顺序保存，文件名自动添加序号。';
      $.outputNote.classList.toggle('is-error', oversized > 0);
    }

    function validOutput(result, scale) {
      const w = result.width * scale, h = result.height * scale;
      return w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_OUTPUT_PIXELS;
    }

    function resizePreview() {
      if (!state.source) return;
      const r = state.result, scale = int($.scale);
      let w = r ? r.width * scale : state.source.width;
      let h = r ? r.height * scale : state.source.height;
      if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_OUTPUT_PIXELS) { w = r.width; h = r.height; }
      if ($.canvas.width !== w || $.canvas.height !== h) { $.canvas.width = w; $.canvas.height = h; zoom.refresh(); }
    }

    function drawPreview() {
      if (!state.source) return;
      const w = $.canvas.width, h = $.canvas.height;
      ctx.clearRect(0, 0, w, h);
      const mode = $.view.value;
      const hasResult = !!state.result;
      const geometry = comparisonGeometry();
      const split = mode === 'compare' && geometry.image.width ? Math.max(0, Math.min(w, (geometry.x - geometry.image.left) / geometry.image.width * w)) : mode === 'source' ? w : 0;
      ctx.imageSmoothingEnabled = false;
      if (!hasResult || mode === 'source') ctx.drawImage(sourceCanvas, 0, 0, w, h);
      else {
        ctx.drawImage(nativeCanvas, 0, 0, w, h);
        if (mode === 'compare') {
          ctx.save();
          ctx.beginPath(); ctx.rect(0, 0, split, h); ctx.clip();
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(sourceCanvas, 0, 0, w, h);
          ctx.restore();
        }
      }
      const styles = getComputedStyle(root);
      const sx = w / state.source.width, sy = h / state.source.height;
      if ($.grid.checked) {
        try {
          const o = state.result ? currentItem().options : readOptions();
          const grid = (source, left, right) => {
            ctx.save(); ctx.beginPath(); ctx.rect(left, 0, right - left, h); ctx.clip(); ctx.beginPath();
            for (let x = 1; x < o.cols; x++) { const xx = source ? gridBoundary(x, o.cols, state.source.width, o.offsetX) * sx : x * w / o.cols; ctx.moveTo(xx, 0); ctx.lineTo(xx, h); }
            for (let y = 1; y < o.rows; y++) { const yy = source ? gridBoundary(y, o.rows, state.source.height, o.offsetY) * sy : y * h / o.rows; ctx.moveTo(0, yy); ctx.lineTo(w, yy); }
            ctx.lineWidth = 1 / Math.max(0.05, zoom.getScale());
            ctx.strokeStyle = styles.getPropertyValue('--primary').trim();
            ctx.globalAlpha = 0.6; ctx.stroke(); ctx.restore();
          };
          if (!hasResult || mode === 'source') grid(true, 0, w);
          else if (mode === 'result') grid(false, 0, w);
          else { grid(true, 0, split); grid(false, split, w); }
        } catch { /* 输入未完成时不画网格 */ }
      }
      const index = state.items.findIndex((item) => item.id === state.currentId);
      const caption = !hasResult ? '原图' : mode === 'compare' ? '左：原图 · 右：处理结果' : mode === 'source' ? '原图' : '处理结果';
      $.caption.textContent = `${index + 1}/${state.items.length} · ${caption}`;
      $.lbName.textContent = `${index + 1}/${state.items.length} · ${state.source.name}`;
      updateDivider();
    }

    function comparisonGeometry() {
      const image = $.canvas.getBoundingClientRect(), stage = $.previewStage.getBoundingClientRect();
      const left = Math.max(image.left, stage.left), right = Math.min(image.right, stage.right);
      return { image, stage, left, right, x: left + (right - left) * state.split / 100, top: Math.max(image.top, stage.top), bottom: Math.min(image.bottom, stage.bottom) };
    }

    function updateDivider() {
      const geometry = comparisonGeometry();
      const { image, stage, x, top, bottom, left, right } = geometry;
      $.divider.hidden = !state.result || $.view.value !== 'compare' || !image.width || right <= left || bottom <= top;
      if ($.divider.hidden) return;
      $.divider.style.left = `${x - stage.left}px`;
      $.divider.style.top = `${top - stage.top}px`;
      $.divider.style.height = `${bottom - top}px`;
      $.divider.setAttribute('aria-valuenow', String(Math.round(state.split)));
      $.divider.setAttribute('aria-valuetext', `原图 ${Math.round(state.split)}%，处理结果 ${100 - Math.round(state.split)}%`);
    }

    function stopDividerDrag() {
      if (state.splitPointer !== null && $.divider.hasPointerCapture(state.splitPointer)) $.divider.releasePointerCapture(state.splitPointer);
      state.splitPointer = null;
    }

    function dragDivider(e) {
      if (e.pointerId !== state.splitPointer) return;
      const { left, right } = comparisonGeometry();
      if (right <= left) return;
      state.split = Math.max(0, Math.min(100, (e.clientX - left) / (right - left) * 100));
      if (!state.paintFrame) state.paintFrame = requestAnimationFrame(() => { state.paintFrame = 0; if (!state.disposed) drawPreview(); });
    }

    function navigate(delta) {
      const index = state.items.findIndex((item) => item.id === state.currentId) + delta;
      if (index >= 0 && index < state.items.length) selectItem(state.items[index].id);
    }

    async function openLightbox(id = state.currentId) {
      if (!id || state.batchBusy || state.importing || state.exporting) return;
      if (state.source?.id !== id || state.loading) {
        const pending = selectItem(id), loadToken = state.loadToken;
        await pending;
        if (state.disposed || loadToken !== state.loadToken || state.currentId !== id) return;
      }
      if (!state.source || state.source.id !== id || state.disposed) return;
      if (!$.lightbox.open) {
        $.lbView.value = $.view.value;
        $.lbBody.append($.previewStage);
        $.previewStage.classList.add('lightbox-stage');
        $.lightbox.showModal();
      }
      zoom.fit(); drawPreview();
    }

    function restorePreview() {
      stopDividerDrag();
      previewHome.after($.previewStage);
      $.previewStage.classList.remove('lightbox-stage');
      if (!state.disposed) { zoom.refresh(); drawPreview(); }
    }

    function progress(token, { done, total, title }) {
      if (state.disposed || token !== state.token) return;
      const label = `${title} ${Math.round(done)}/${Math.round(total)}`;
      if (state.batchBusy) $.generate.textContent = $.batchGenerate.textContent = `${state.batchLabel} · ${label}`;
      else $.generate.textContent = label;
    }

    async function runFallback(kind, options, token, source) {
      check(token);
      const s = source;
      const hooks = { check: () => check(token), progress: (done, total, title) => progress(token, { done, total, title }) };
      const result = kind === 'analyze' ? await analyzeGrid(s.data, s.width, s.height, hooks) : await cleanupPixels(s.data, s.width, s.height, options, hooks);
      check(token);
      return result;
    }

    async function runJob(kind, options, token, source = state.source) {
      check(token);
      try {
        const result = await new Promise((resolve, reject) => {
          const worker = new Worker(new URL('../workers/pixel-cleanup.js', import.meta.url), { type: 'module' });
          state.job = { cancel: () => { worker.terminate(); reject(abortError()); } };
          worker.onmessage = ({ data }) => {
            if (data.token !== token || token !== state.token || state.disposed) return;
            if (data.progress) { progress(token, data.progress); return; }
            worker.terminate();
            state.job = null;
            if (data.error) reject(new Error(data.error)); else resolve(data.result);
          };
          worker.onerror = (e) => { e.preventDefault(); worker.terminate(); if (token === state.token) state.job = null; reject(new Error('后台线程不可用')); };
          const s = source, copy = s.data.slice();
          worker.postMessage({ token, kind, buffer: copy.buffer, width: s.width, height: s.height, options }, [copy.buffer]);
        });
        check(token);
        return result;
      } catch (err) {
        check(token);
        if (err.name === 'AbortError') throw err;
        state.job?.cancel();
        state.job = null;
        const result = await runFallback(kind, options, token, source);
        check(token);
        return result;
      }
    }

    async function generate(auto = false) {
      if (!state.source || state.loading || state.exporting || state.batchBusy) return;
      stopJob();
      const token = state.token;
      const item = currentItem();
      state.busy = true;
      state.result = null;
      item.result = null; item.error = null; item.processing = true;
      $.status.textContent = auto ? '正在分析像素网格' : '正在生成像素图';
      $.generate.textContent = '准备处理';
      updateButtons();
      drawPreview();
      try {
        if (auto) {
          const grid = await runJob('analyze', null, token);
          check(token);
          $.cols.value = grid.cols; $.rows.value = grid.rows;
          $.offsetX.value = grid.offsetX; $.offsetY.value = grid.offsetY;
          $.preset.value = 'custom';
          limitOffsets();
          $.gridNote.textContent = grid.reliable ? '已找到重复网格，可打开网格检查细节对齐。' : '未找到可用的统一网格，已建议逻辑分辨率，可手动调整。';
          item.gridNote = $.gridNote.textContent;
        }
        const options = readOptions();
        item.options = options;
        state.recipe = { ...options };
        const result = await runJob('cleanup', options, token);
        check(token);
        nativeCanvas.width = result.width; nativeCanvas.height = result.height;
        nativeCanvas.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
        state.result = result;
        item.result = result;
        $.status.textContent = `已生成 ${result.width}×${result.height} 个美术像素 · ${result.colorCount} 色`;
      } catch (err) {
        if (token !== state.token || state.disposed) return;
        item.error = err.message;
        $.status.textContent = err.name === 'AbortError' ? '已取消处理' : `处理失败：${err.message}`;
      } finally {
        if (token === state.token && !state.disposed) { item.processing = false; state.busy = false; resizePreview(); updateButtons(); drawPreview(); }
      }
    }

    function schedule() {
      if (!state.source || state.loading || state.exporting || state.batchBusy) return;
      stopJob();
      state.result = null;
      const item = currentItem();
      if (item) { item.result = null; item.error = null; item.gridNote = $.gridNote.textContent; }
      $.status.textContent = '参数已更新';
      updateButtons(); drawPreview();
      try { item.options = readOptions(); state.recipe = { ...item.options }; } catch (err) { $.status.textContent = err.message; return; }
      state.timer = setTimeout(() => generate(), 240);
    }

    async function decodeFile(file, ensure, thumbnail = false) {
      let bitmap = null;
      const canvas = document.createElement('canvas');
      try {
        bitmap = await createImageBitmap(file);
        ensure();
        const { width, height } = bitmap;
        if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_SOURCE_PIXELS) throw new Error('图片过大：最长边 8192，最多 1600 万像素');
        const ratio = thumbnail ? Math.min(1, 128 / Math.max(width, height)) : 1;
        canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
        const context = canvas.getContext('2d', { willReadFrequently: !thumbnail });
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (thumbnail) {
          const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('缩略图生成失败')), 'image/png'));
          ensure();
          return { width, height, blob };
        }
        return { width, height, data: context.getImageData(0, 0, width, height).data };
      } finally {
        bitmap?.close();
        canvas.width = canvas.height = 1;
      }
    }

    function applyOptions(options, clamp = true) {
      for (const name of ['cols', 'rows', 'offsetX', 'offsetY', 'colors']) $[name].value = options[name];
      $.hardAlpha.checked = options.hardAlpha;
      $.removeNoise.checked = options.removeNoise;
      $.preset.value = 'custom';
      limitOffsets(false, clamp);
    }

    function showCurrentResult() {
      const item = currentItem();
      if (!item || !state.source) return;
      state.result = item.result;
      const matches = item.options && state.recipe && ['cols', 'rows', 'offsetX', 'offsetY', 'colors', 'hardAlpha', 'removeNoise'].every((key) => item.options[key] === state.recipe[key]);
      $.gridNote.textContent = item.result && !matches ? '当前结果尚未应用这套参数。' : item.gridNote || '';
      if (item.result) {
        nativeCanvas.width = item.result.width; nativeCanvas.height = item.result.height;
        nativeCanvas.getContext('2d').putImageData(new ImageData(item.result.data, item.result.width, item.result.height), 0, 0);
      }
      resizePreview(); drawPreview();
    }

    async function selectItem(id) {
      if (state.importing || state.batchBusy || state.exporting) return;
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return;
      if (!state.loading && state.source?.id === id) return;
      stopJob();
      stopDividerDrag();
      const loadToken = ++state.loadToken;
      const ensure = () => { if (state.disposed || loadToken !== state.loadToken) throw abortError(); };
      state.loading = true; state.currentId = id;
      state.source = state.result = null;
      resetPreview(true);
      $.caption.textContent = `正在读取 ${item.name}`;
      $.lbName.textContent = item.name;
      $.status.textContent = `正在读取 ${item.name}`;
      updateButtons();
      try {
        const source = await decodeFile(item.file, ensure);
        ensure();
        state.source = { ...source, id, name: item.name };
        sourceCanvas.width = source.width; sourceCanvas.height = source.height;
        sourceCanvas.getContext('2d').putImageData(new ImageData(source.data, source.width, source.height), 0, 0);
        $.name.value = item.outputName;
        $.fileMeta.textContent = `${item.name} · ${source.width}×${source.height} px`;
        $.fileMeta.hidden = false;
        $.cols.max = Math.min(source.width, MAX_LOGICAL_SIDE); $.rows.max = Math.min(source.height, MAX_LOGICAL_SIDE);
        if (state.recipe) applyOptions(state.recipe, false);
        else {
          const step = Math.max(1, Math.max(source.width, source.height) / 128);
          $.cols.value = Math.max(1, Math.round(source.width / step)); $.rows.value = Math.max(1, Math.round(source.height / step));
          limitOffsets(true);
        }
        $.uploadStage.hidden = true; $.previewStage.hidden = false; $.toolbar.hidden = false;
        showCurrentResult(); zoom.fit();
        $.status.textContent = item.error ? `处理失败：${item.error}` : item.result ? `已生成 ${item.result.width}×${item.result.height} 个美术像素 · ${item.result.colorCount} 色` : '待生成';
      } catch (err) {
        if (loadToken !== state.loadToken || state.disposed) return;
        item.error = err.message;
        $.status.textContent = `无法读取图片：${err.message}`;
        return;
      } finally {
        if (loadToken === state.loadToken && !state.disposed) { state.loading = false; updateButtons(); }
      }
      if (loadToken !== state.loadToken || state.disposed) return;
      if (!item.result) {
        await generate(!state.recipe);
        if (loadToken !== state.loadToken || state.disposed) return;
      }
    }

    async function addFiles(files) {
      if (state.loading || state.batchBusy || state.exporting) { toast('请先完成或取消当前任务'); return; }
      const incoming = Array.from(files || []);
      if (!incoming.length) return;
      stopJob();
      const loadToken = ++state.loadToken;
      const ensure = () => { if (state.disposed || loadToken !== state.loadToken) throw abortError(); };
      state.loading = state.importing = true;
      const added = [], failures = [];
      updateButtons();
      try {
        for (let i = 0; i < incoming.length; i++) {
          const file = incoming[i];
          $.status.textContent = `导入中 ${i + 1}/${incoming.length}`;
          $.generate.textContent = `导入中 ${i + 1}/${incoming.length}`;
          try {
            if (!/\.(png|jpe?g|webp|bmp|avif)$/i.test(file.name || '') && !/^image\/(png|jpeg|webp|bmp|avif)$/.test(file.type)) throw new Error('不支持的图片格式');
            const decoded = await decodeFile(file, ensure, true);
            ensure();
            const item = { id: ++state.seq, file, name: file.name || 'pasted.png', width: decoded.width, height: decoded.height, url: URL.createObjectURL(decoded.blob), outputName: `${baseName(file.name || 'pasted.png')}_pixel`, selected: true, result: null, options: null, error: null, processing: false };
            state.items.push(item); added.push(item);
            renderItems();
          } catch (err) {
            ensure();
            failures.push(`${file.name || '图片'}：${err.message}`);
          }
        }
        if (failures.length) toast(`已添加 ${added.length} 张，跳过 ${failures.length} 张。${failures[0]}`, 6000);
        $.status.textContent = `已添加 ${added.length} 张图片，设好参数后可应用到全部图片`;
      } catch (err) {
        if (loadToken !== state.loadToken || state.disposed) return;
        $.status.textContent = `导入失败：${err.message}`;
      } finally {
        if (loadToken === state.loadToken && !state.disposed) { state.loading = state.importing = false; renderItems(); }
      }
      if (loadToken !== state.loadToken || state.disposed) return;
      if (!state.source && state.items.length) {
        const selectToken = state.loadToken + 1;
        await selectItem(added[0]?.id || state.items[0].id);
        if (selectToken !== state.loadToken || state.disposed) return;
      }
    }

    async function generateBatch(all = false) {
      if (state.busy || state.loading || state.exporting) return;
      const chosen = all ? [...state.items] : selectedItems();
      if (!chosen.length) return;
      let template;
      try {
        template = readOptions();
        state.recipe = { ...template };
      } catch (err) { $.status.textContent = err.message; return; }
      stopJob();
      const token = state.token;
      state.busy = state.batchBusy = true;
      $.generate.textContent = $.batchGenerate.textContent = '准备批量应用参数';
      updateButtons();
      try {
        const summary = await processPixelBatch(chosen, async (item) => {
          const source = state.source?.id === item.id ? state.source : await decodeFile(item.file, () => check(token));
          check(token);
          const options = { ...template };
          item.gridNote = '已应用统一设定。';
          item.options = options;
          const result = await runJob('cleanup', options, token, source);
          check(token);
          return result;
        }, {
          check: () => check(token),
          onStart(item, i, total) {
            state.batchLabel = `处理图片 ${i + 1}/${total}`;
            $.status.textContent = `${state.batchLabel} · ${item.name}`;
            $.generate.textContent = $.batchGenerate.textContent = state.batchLabel;
            item.processing = true; item.result = null; item.error = null;
            if (item.id === state.currentId) { state.result = null; drawPreview(); }
            updateItem(item); updateOutput();
          },
          onResult(item, result) {
            item.result = result; item.processing = false;
            if (item.id === state.currentId) showCurrentResult();
            updateItem(item); updateOutput();
          },
          onError(item, err) {
            item.result = null; item.error = err.message; item.processing = false;
            if (item.id === state.currentId) { state.result = null; drawPreview(); }
            updateItem(item); updateOutput();
          },
        });
        check(token);
        $.status.textContent = `批量处理完成：成功 ${summary.completed} 张${summary.failed ? `，失败 ${summary.failed} 张` : ''}`;
      } catch (err) {
        if (token !== state.token || state.disposed) return;
        $.status.textContent = `批量处理失败：${err.message}`;
      } finally {
        if (token === state.token && !state.disposed) { state.busy = state.batchBusy = false; showCurrentResult(); updateButtons(); }
      }
    }

    function cancelAll() {
      stopJob(); state.loadToken++; state.exportToken++;
      state.exportTask?.fail('已取消像素图导出'); state.exportTask = null;
      state.loading = state.importing = state.exporting = false;
      if (!state.source) resetPreview();
      $.status.textContent = '已取消任务，已完成的图片保留';
      updateButtons(); drawPreview();
    }

    function removeItem(id) {
      if (state.busy || state.loading || state.exporting) return;
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return;
      URL.revokeObjectURL(item.url);
      state.items = state.items.filter((entry) => entry !== item);
      if (!state.items.length) state.recipe = null;
      item.result = null;
      if (id === state.currentId) {
        stopJob(); state.loadToken++;
        state.currentId = null; state.source = state.result = null;
        resetPreview();
      }
      renderItems();
      if (!state.source && state.items.length) selectItem(state.items[0].id);
    }

    function resetPreview(keepStage = false) {
      stopDividerDrag();
      sourceCanvas.width = sourceCanvas.height = nativeCanvas.width = nativeCanvas.height = $.canvas.width = $.canvas.height = 1;
      $.uploadStage.hidden = keepStage;
      $.previewStage.hidden = $.toolbar.hidden = !keepStage;
      $.divider.hidden = $.fileMeta.hidden = true;
      $.gridNote.textContent = ''; $.status.textContent = '';
    }

    async function encodeResult(item, token, scale, sequence) {
      const r = item.result;
      if (!r) throw new Error('请先生成像素图');
      const width = r.width * scale, height = r.height * scale;
      if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_OUTPUT_PIXELS) throw new Error('输出过大，请降低倍数');
      const canvas = document.createElement('canvas');
      const native = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      try {
        native.width = r.width; native.height = r.height;
        native.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = false;
        context.drawImage(native, 0, 0, width, height);
        const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG 编码失败')), 'image/png'));
        if (token !== state.exportToken || state.disposed) throw abortError();
        return { name: `${sequence}_${baseName(item.outputName)}_${width}x${height}.png`, blob };
      } finally { canvas.width = canvas.height = native.width = native.height = 1; }
    }

    async function exportResult(kind) {
      if (state.busy || state.loading || state.exporting) return;
      const chosen = selectedItems(), scale = int($.scale);
      if (!chosen.length || chosen.some((item) => !item.result || !validOutput(item.result, scale))) return;
      clearTimeout(state.timer);
      const token = ++state.exportToken;
      state.exporting = true;
      updateButtons();
      let task = null;
      try {
        const dir = kind === 'save' ? await pickFolder('pixel-cleanup') : null;
        if (token !== state.exportToken || state.disposed) return;
        if (dir === undefined) return;
        task = startProgress(kind === 'send' ? '正在准备像素图' : '正在生成 PNG', chosen.length);
        state.exportTask = task;
        const files = [], digits = Math.max(2, String(state.items.length).length);
        for (let i = 0; i < chosen.length; i++) {
          const sequence = String(state.items.indexOf(chosen[i]) + 1).padStart(digits, '0');
          $.generate.textContent = `编码中 ${i + 1}/${chosen.length}`;
          task.update(i, chosen.length, '正在生成 PNG');
          const file = await encodeResult(chosen[i], token, scale, sequence);
          if (token !== state.exportToken || state.disposed) return;
          files.push(file);
        }
        if (kind === 'send') {
          task.finish(`${files.length} 张像素图已发送到图片批处理`);
          state.exportTask = null;
          handoff('image-batch', files.map((file) => new File([file.blob], file.name, { type: 'image/png' })));
        } else {
          await writeFiles(files, { dir, zipName: chosen.length === 1 ? `${baseName(files[0].name)}.zip` : 'pixel_cleanup.zip', task, summary: `${files.length} 张像素图`, check: () => { if (token !== state.exportToken || state.disposed) throw abortError(); } });
          if (token !== state.exportToken || state.disposed) return;
        }
      } catch (err) {
        if (token !== state.exportToken || state.disposed) return;
        if (err.name !== 'AbortError') task ? task.fail(`导出失败：${err.message}`) : toast(`导出失败：${err.message}`);
      } finally {
        if (token === state.exportToken && !state.disposed) { state.exporting = false; state.exportTask = null; updateButtons(); }
      }
    }

    $.change.addEventListener('click', () => $.file.click());
    $.file.addEventListener('change', () => { addFiles($.file.files); $.file.value = ''; });
    $.generate.addEventListener('click', () => generateBatch(true));
    $.analyze.addEventListener('click', () => generate(true));
    $.prev.addEventListener('click', () => navigate(-1));
    $.next.addEventListener('click', () => navigate(1));
    $.enlarge.addEventListener('click', () => openLightbox());
    $.lbClose.addEventListener('click', () => $.lightbox.close());
    $.lightbox.addEventListener('close', restorePreview);
    $.lbView.addEventListener('change', () => { $.view.value = $.lbView.value; drawPreview(); });
    $.previewStage.addEventListener('dblclick', (e) => { if (e.target === $.canvas) openLightbox(); });
    $.divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state.result) return;
      e.preventDefault(); e.stopPropagation();
      state.splitPointer = e.pointerId;
      $.divider.setPointerCapture(e.pointerId);
      $.divider.focus();
    });
    $.divider.addEventListener('pointermove', dragDivider);
    $.divider.addEventListener('pointerup', stopDividerDrag);
    $.divider.addEventListener('pointercancel', stopDividerDrag);
    $.divider.addEventListener('lostpointercapture', () => { state.splitPointer = null; });
    $.divider.addEventListener('keydown', (e) => {
      const delta = e.shiftKey ? 10 : 1;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      state.split = e.key === 'Home' ? 0 : e.key === 'End' ? 100 : Math.max(0, Math.min(100, state.split + (e.key === 'ArrowLeft' ? -delta : delta)));
      drawPreview();
    });
    $.cancel.addEventListener('click', cancelAll);
    $.batchGenerate.addEventListener('click', () => generateBatch(false));
    $.selectAll.addEventListener('click', () => { for (const item of state.items) item.selected = true; updateButtons(); });
    $.selectNone.addEventListener('click', () => { for (const item of state.items) item.selected = false; updateButtons(); });
    $.clear.addEventListener('click', () => {
      if (state.busy || state.loading || state.exporting) return;
      stopJob(); state.loadToken++;
      for (const item of state.items) URL.revokeObjectURL(item.url);
      state.items = []; state.currentId = null; state.recipe = null; state.source = state.result = null;
      resetPreview(); renderItems();
    });
    $.cols.addEventListener('input', () => {
      if ($.lock.checked && state.source && Number.isInteger(int($.cols))) $.rows.value = Math.max(1, Math.min(Number($.rows.max), Math.round(int($.cols) * state.source.height / state.source.width)));
      $.preset.value = 'custom'; $.gridNote.textContent = '使用手动设置的网格。'; limitOffsets(true); schedule();
    });
    $.rows.addEventListener('input', () => {
      if ($.lock.checked && state.source && Number.isInteger(int($.rows))) $.cols.value = Math.max(1, Math.min(Number($.cols.max), Math.round(int($.rows) * state.source.width / state.source.height)));
      $.preset.value = 'custom'; $.gridNote.textContent = '使用手动设置的网格。'; limitOffsets(true); schedule();
    });
    $.preset.addEventListener('change', () => {
      if (!state.source || $.preset.value === 'custom') return;
      const s = state.source, ratio = Math.min(int($.preset), Math.max(s.width, s.height)) / Math.max(s.width, s.height);
      $.cols.value = Math.max(1, Math.round(s.width * ratio)); $.rows.value = Math.max(1, Math.round(s.height * ratio));
      $.gridNote.textContent = '使用预设逻辑分辨率。'; limitOffsets(true); schedule();
    });
    $.lock.addEventListener('change', () => { if ($.lock.checked) $.cols.dispatchEvent(new Event('input')); });
    for (const el of [$.offsetX, $.offsetY]) el.addEventListener('input', () => { $.gridNote.textContent = '使用手动设置的网格。'; schedule(); });
    for (const el of [$.colors, $.hardAlpha, $.removeNoise]) el.addEventListener('change', schedule);
    $.view.addEventListener('change', () => { $.lbView.value = $.view.value; stopDividerDrag(); drawPreview(); });
    $.grid.addEventListener('change', drawPreview);
    $.scale.addEventListener('change', () => { resizePreview(); updateOutput(); drawPreview(); });
    $.name.addEventListener('input', () => { const item = currentItem(); if (item) item.outputName = $.name.value; });
    $.save.addEventListener('click', () => exportResult('save'));
    $.zip.addEventListener('click', () => exportResult('zip'));
    $.send.addEventListener('click', () => exportResult('send'));

    const onDrop = (e) => { e.preventDefault(); $.uploadStage.classList.remove('dragging'); $.previewStage.classList.remove('dragging'); addFiles(e.dataTransfer.files); };
    for (const stage of [$.uploadStage, $.previewStage]) {
      stage.addEventListener('dragover', (e) => { e.preventDefault(); if (!state.exporting && !state.loading && !state.batchBusy) stage.classList.add('dragging'); });
      stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
      stage.addEventListener('drop', onDrop);
    }
    const onPaste = (e) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return;
      const files = [...(e.clipboardData?.items || [])].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addFiles(files); }
    };
    document.addEventListener('paste', onPaste);
    const onKeyDown = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable="true"], [role="slider"]')) return;
      if (!$.lightbox.open && !$.previewStage.matches(':hover') && !root.contains(document.activeElement)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); navigate(e.key === 'ArrowLeft' ? -1 : 1); }
    };
    document.addEventListener('keydown', onKeyDown);
    const themeObserver = new MutationObserver(drawPreview);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const incoming = takeHandoff('pixel-cleanup');
    if (incoming?.length) addFiles(incoming);

    return () => {
      state.disposed = true;
      stopDividerDrag();
      cancelAnimationFrame(state.paintFrame);
      $.lightbox.removeEventListener('close', restorePreview);
      if ($.lightbox.open) $.lightbox.close();
      restorePreview();
      state.loadToken++; state.exportToken++;
      state.exportTask?.fail('已取消像素图导出');
      stopJob();
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKeyDown);
      themeObserver.disconnect();
      zoom.destroy();
      for (const item of state.items) { URL.revokeObjectURL(item.url); item.result = null; }
      state.items = [];
      state.source = state.result = null;
      for (const canvas of [sourceCanvas, nativeCanvas, thumbSource, $.canvas]) canvas.width = canvas.height = 1;
    };
  },
};
