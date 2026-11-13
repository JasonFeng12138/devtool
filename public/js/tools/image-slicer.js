import { pickFolder, writeFiles } from '../lib/save.js';
import { ICON_UPLOAD, collectRefs, formatBytes, startProgress, toast } from '../lib/ui.js';
import { SVG_SCALE_OPTIONS, cropSvg, isSvg, rasterSize, rasterizeSvg, readSvg, resolveScale } from '../lib/vector.js';

const FORMATS = {
  png: { mime: 'image/png', ext: 'png', label: 'PNG（无损）' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
  svg: { mime: 'image/svg+xml', ext: 'svg', label: 'SVG（保留矢量，仅限 SVG 原图）' },
};

const MAX_TILES_WITHOUT_CONFIRM = 2000;

const TEMPLATE = `
<section class="panel">
  <div class="panel-header">
    <h2 class="section-title">切分设置</h2>
  </div>
  <div class="tool-split">
    <div class="stage scroll-area" data-ref="stage">
      <label class="dropzone" data-ref="dropzone">
        <input type="file" accept="image/*,.svg" aria-label="选择图片" data-ref="file">
        ${ICON_UPLOAD}
        <span class="dropzone-title">选择图片</span>
        <span class="dropzone-hint">拖拽或 Ctrl+V 粘贴 · 支持 SVG</span>
      </label>
      <div class="preview" data-ref="preview" hidden>
        <img data-ref="img" alt="原图预览">
        <canvas data-ref="overlay"></canvas>
      </div>
    </div>

    <div class="controls">
      <div class="dims" data-ref="dims" hidden>
        <div class="dim"><span class="dim-label">原图宽度</span><span class="dim-value"><b data-ref="imgW">0</b> px</span></div>
        <div class="dim"><span class="dim-label">原图高度</span><span class="dim-value"><b data-ref="imgH">0</b> px</span></div>
        <div class="file-meta" data-ref="fileMeta"></div>
      </div>

      <label class="field" data-ref="svgField" hidden>矢量图渲染倍数
        <select data-ref="svgScale">${SVG_SCALE_OPTIONS}</select>
        <span class="plan-note" data-ref="svgNote"></span>
      </label>

      <div class="control-group">
        <div class="field-row">
          <label class="field">每块宽度 (px)<input type="number" min="1" step="1" placeholder="如 512" data-ref="tileW"></label>
          <label class="field">每块高度 (px)<input type="number" min="1" step="1" placeholder="如 512" data-ref="tileH"></label>
        </div>
        <label class="field">输出格式
          <select data-ref="format">
            ${Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="plan" data-ref="plan" hidden></div>

      <div class="actions actions-stack">
        <button class="btn btn-primary" data-ref="confirm" disabled>开始切分</button>
        <button class="btn" data-ref="change" disabled>更换图片</button>
      </div>
    </div>
  </div>
</section>

<section class="panel" data-ref="results" hidden>
  <div class="panel-header">
    <div class="panel-heading">
      <h2 class="section-title">切分结果</h2>
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
  <div class="tiles" data-ref="tiles"></div>
</section>
`;

function computePlan(imgW, imgH, tileW, tileH) {
  if (!imgW || !imgH || !(tileW >= 1) || !(tileH >= 1)) return null;
  const cols = Math.ceil(imgW / tileW);
  const rows = Math.ceil(imgH / tileH);
  return {
    tileW,
    tileH,
    cols,
    rows,
    total: cols * rows,
    lastW: imgW - (cols - 1) * tileW,
    lastH: imgH - (rows - 1) * tileH,
  };
}

function readPositiveInt(input) {
  const v = Number(input.value);
  return Number.isInteger(v) && v >= 1 ? v : NaN;
}

function baseName(filename) {
  const name = filename.replace(/\.[^.]+$/, '') || 'image';
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

function canvasToBlob(canvas, mime) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), mime, 0.92);
  });
}

export default {
  id: 'image-slicer',
  name: '图片切分',
  description: '按固定宽高切分图片',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/></svg>',

  mount(root) {
    root.innerHTML = TEMPLATE;
    const $ = collectRefs(root);

    const state = {
      source: null, // { name, size, url, width, height, vector: { info, scale } | null }
      tiles: [], // { seq, row, col, x, y, w, h, blob, url, name, selected }
      busy: false,
      loadToken: 0,
    };

    // ---------- 加载图片 ----------
    // SVG 先按倍数渲染为 PNG 再显示与切割；选择 SVG 输出格式时从原始矢量内容裁切
    async function loadFile(file) {
      if (!file || !(file.type.startsWith('image/') || isSvg(file))) {
        toast('请选择图片文件');
        return;
      }
      const token = ++state.loadToken;
      let raster = file;
      let vector = null;
      if (isSvg(file)) {
        try {
          const info = await readSvg(file);
          const scale = resolveScale($.svgScale.value, info);
          raster = await rasterizeSvg(info, scale, file.name);
          vector = { info, scale };
        } catch (err) {
          if (token === state.loadToken) toast(`无法读取该矢量图：${err.message}`);
          return;
        }
        if (token !== state.loadToken) return;
      }
      showSource(raster, { name: file.name || 'pasted.png', size: file.size, vector });
    }

    function showSource(raster, meta) {
      const url = URL.createObjectURL(raster);
      const probe = new Image();
      probe.onload = () => {
        if (state.source) URL.revokeObjectURL(state.source.url);
        clearTiles();
        state.source = { ...meta, url, width: probe.naturalWidth, height: probe.naturalHeight };
        $.img.src = url;
        $.imgW.textContent = state.source.width;
        $.imgH.textContent = state.source.height;
        $.fileMeta.textContent = `${meta.name} · ${formatBytes(meta.size)}${meta.vector ? ' · SVG 矢量图' : ''}`;
        $.dims.hidden = false;
        $.dropzone.hidden = true;
        $.preview.hidden = false;
        $.change.disabled = false;
        updateVectorUi();
        updatePlan();
      };
      probe.onerror = () => {
        URL.revokeObjectURL(url);
        toast('无法读取该图片');
      };
      probe.src = url;
    }

    function updateVectorUi() {
      const v = state.source?.vector;
      $.svgField.hidden = !v;
      $.format.querySelector('option[value="svg"]').disabled = !v;
      if (!v && $.format.value === 'svg') $.format.value = 'png';
      if (v) {
        const { w, h } = rasterSize(v.info, v.scale);
        $.svgNote.textContent = `固有尺寸 ${Math.round(v.info.width)}×${Math.round(v.info.height)}，渲染为 ${w}×${h} 像素；切块尺寸按渲染后的像素计算`;
      }
    }

    // 改变倍数：从原始 SVG 重新渲染
    $.svgScale.addEventListener('change', async () => {
      const src = state.source;
      if (!src?.vector) return;
      const token = ++state.loadToken;
      const scale = resolveScale($.svgScale.value, src.vector.info);
      try {
        const raster = await rasterizeSvg(src.vector.info, scale, src.name);
        if (token !== state.loadToken) return;
        showSource(raster, { name: src.name, size: src.size, vector: { info: src.vector.info, scale } });
      } catch (err) {
        if (token === state.loadToken) toast(`矢量图渲染失败：${err.message}`);
      }
    });

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
      loadFile(e.dataTransfer.files[0]);
    });

    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) loadFile(item.getAsFile());
    };
    document.addEventListener('paste', onPaste);

    // ---------- 方案预览 ----------
    function currentPlan() {
      const s = state.source;
      return s && computePlan(s.width, s.height, readPositiveInt($.tileW), readPositiveInt($.tileH));
    }

    function updatePlan() {
      const plan = currentPlan();
      $.plan.hidden = !state.source;
      if (!state.source) {
        $.plan.textContent = '请先上传图片';
      } else if (!plan) {
        $.plan.textContent = '请输入每块的宽度和高度（正整数像素）';
      } else {
        const edge = [];
        if (plan.lastW !== plan.tileW) edge.push(`最右列宽 ${plan.lastW}px`);
        if (plan.lastH !== plan.tileH) edge.push(`最底行高 ${plan.lastH}px`);
        $.plan.innerHTML =
          `将切分为 <b>${plan.cols}</b> 列 × <b>${plan.rows}</b> 行，共 <b>${plan.total}</b> 张` +
          (edge.length ? `<span class="plan-note">${edge.join('，')}</span>` : '');
      }
      $.confirm.disabled = !plan || state.busy;
      drawOverlay();
    }

    function drawOverlay() {
      const canvas = $.overlay;
      const ctx = canvas.getContext('2d');
      const w = $.img.clientWidth;
      const h = $.img.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const plan = currentPlan();
      if (!plan || !w || !h) return;
      const sx = w / state.source.width;
      const sy = h / state.source.height;

      // 网格线：内部分割线 + 外框（外框内缩半像素保证可见）
      const path = new Path2D();
      for (let c = 1; c < plan.cols; c++) {
        const x = Math.round(c * plan.tileW * sx) + 0.5;
        path.moveTo(x, 0);
        path.lineTo(x, h);
      }
      for (let r = 1; r < plan.rows; r++) {
        const y = Math.round(r * plan.tileH * sy) + 0.5;
        path.moveTo(0, y);
        path.lineTo(w, y);
      }
      path.rect(0.5, 0.5, w - 1, h - 1);

      ctx.lineWidth = 1;
      // 先画一层半透明深色底线，保证白色虚线在浅色图片上也能看清
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.stroke(path);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke(path);

      // 块足够大时标注序号
      const cellW = plan.tileW * sx;
      const cellH = plan.tileH * sy;
      if (cellW >= 26 && cellH >= 18 && plan.total <= 600) {
        ctx.font = '11px ui-monospace, Consolas, monospace';
        ctx.textBaseline = 'top';
        let seq = 1;
        for (let r = 0; r < plan.rows; r++) {
          for (let c = 0; c < plan.cols; c++) {
            const label = String(seq++);
            const x = c * cellW + 4;
            const y = r * cellH + 4;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
            ctx.fillRect(x - 2, y - 2, tw + 4, 15);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, x, y);
          }
        }
      }
    }

    $.tileW.addEventListener('input', updatePlan);
    $.tileH.addEventListener('input', updatePlan);
    $.img.addEventListener('load', drawOverlay);
    const resizeObserver = new ResizeObserver(drawOverlay);
    resizeObserver.observe($.img);

    // ---------- 切割 ----------
    function clearTiles() {
      for (const t of state.tiles) URL.revokeObjectURL(t.url);
      state.tiles = [];
      $.tiles.replaceChildren();
      $.results.hidden = true;
    }

    async function slice() {
      const plan = currentPlan();
      if (!plan || state.busy) return;
      if (plan.total > MAX_TILES_WITHOUT_CONFIRM && !confirm(`将生成 ${plan.total} 张图片，可能较慢，确定继续？`)) return;

      state.busy = true;
      $.confirm.disabled = true;
      clearTiles();

      const format = FORMATS[$.format.value];
      const base = baseName(state.source.name);
      const digits = String(plan.total).length;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const tiles = [];

      try {
        let seq = 0;
        for (let row = 0; row < plan.rows; row++) {
          for (let col = 0; col < plan.cols; col++) {
            seq++;
            const x = col * plan.tileW;
            const y = row * plan.tileH;
            const w = Math.min(plan.tileW, state.source.width - x);
            const h = Math.min(plan.tileH, state.source.height - y);
            let blob;
            if (format.ext === 'svg') {
              blob = cropSvg(state.source.vector.info, state.source.vector.scale, { x, y, w, h });
            } else {
              canvas.width = w;
              canvas.height = h;
              if (format.mime === 'image/jpeg') {
                ctx.fillStyle = '#ffffff'; // JPEG 不支持透明，透明区域填白
                ctx.fillRect(0, 0, w, h);
              }
              ctx.drawImage($.img, x, y, w, h, 0, 0, w, h);
              blob = await canvasToBlob(canvas, format.mime);
            }
            tiles.push({
              seq, row, col, x, y, w, h, blob,
              url: URL.createObjectURL(blob),
              name: `${base}_${String(seq).padStart(digits, '0')}_r${row + 1}c${col + 1}.${format.ext}`,
              selected: true,
            });
            $.confirm.textContent = `切分中 ${seq}/${plan.total}`;
          }
        }
        state.tiles = tiles;
        renderTiles();
        $.results.hidden = false;
        $.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(`切分完成，共 ${tiles.length} 张`);
      } catch (err) {
        for (const t of tiles) URL.revokeObjectURL(t.url);
        toast(`切分失败：${err.message}`);
      } finally {
        state.busy = false;
        $.confirm.textContent = '开始切分';
        updatePlan();
      }
    }

    $.confirm.addEventListener('click', slice);

    // ---------- 结果展示与勾选 ----------
    function renderTiles() {
      const frag = document.createDocumentFragment();
      for (const t of state.tiles) {
        const card = document.createElement('label');
        card.className = 'tile';
        card.title = `${t.name}\n位置 (${t.x}, ${t.y})  尺寸 ${t.w}×${t.h}`;
        card.innerHTML = `
          <input type="checkbox" class="tile-check">
          <div class="tile-thumb"><img alt="" loading="lazy"></div>
          <div class="tile-meta">
            <span class="tile-pos">第${t.row + 1}行 第${t.col + 1}列</span>
            <span class="badge">#${t.seq}</span>
            <span class="tile-size">${t.w} × ${t.h}</span>
          </div>`;
        card.querySelector('img').src = t.url;
        const check = card.querySelector('input');
        check.checked = t.selected;
        card.classList.toggle('selected', t.selected);
        check.addEventListener('change', () => {
          t.selected = check.checked;
          card.classList.toggle('selected', t.selected);
          updateCount();
        });
        t.check = check;
        t.card = card;
        frag.append(card);
      }
      $.tiles.replaceChildren(frag);
      updateCount();
    }

    function setSelection(fn) {
      for (const t of state.tiles) {
        t.selected = fn(t);
        t.check.checked = t.selected;
        t.card.classList.toggle('selected', t.selected);
      }
      updateCount();
    }

    function updateCount() {
      const n = state.tiles.filter((t) => t.selected).length;
      $.count.textContent = `共 ${state.tiles.length} 张 · 已选 ${n} 张`;
      $.save.textContent = `保存选中到本地 (${n})`;
      $.save.disabled = n === 0;
      $.zip.disabled = n === 0;
    }

    $.selAll.addEventListener('click', () => setSelection(() => true));
    $.selNone.addEventListener('click', () => setSelection(() => false));
    $.selInvert.addEventListener('click', () => setSelection((t) => !t.selected));

    // ---------- 保存 ----------
    function selectedTiles() {
      return state.tiles.filter((t) => t.selected);
    }

    async function saveSelected(asZip) {
      const chosen = selectedTiles();
      if (!chosen.length) return;
      const dir = asZip ? null : await pickFolder('image-slicer');
      if (dir === undefined) return;
      const task = startProgress('准备保存', chosen.length);
      try {
        await writeFiles(chosen, {
          dir,
          zipName: `${baseName(state.source.name)}_slices.zip`,
          task,
          summary: `${chosen.length} 张图片`,
        });
      } catch (err) {
        task.fail(`保存失败：${err.message}`);
      }
    }

    $.save.addEventListener('click', () => saveSelected(false));
    $.zip.addEventListener('click', () => saveSelected(true));

    updateVectorUi();

    // ---------- 卸载 ----------
    return () => {
      document.removeEventListener('paste', onPaste);
      resizeObserver.disconnect();
      clearTiles();
      if (state.source) URL.revokeObjectURL(state.source.url);
    };
  },
};
