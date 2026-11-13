// 可缩放 / 平移的图片视图：滚轮以光标为中心缩放，拖拽平移，右下角工具条控制缩放。
// 拖拽结束后会吞掉随之而来的 click，避免误触发取色等点击操作。

const MIN_SCALE = 0.05;
const MAX_SCALE = 64;
const STEP = 1.5;
const FIT_PADDING = 16;
const DRAG_THRESHOLD = 3;

/**
 * @param {HTMLElement} viewport 视口容器
 * @param {HTMLElement} target 被缩放的内容：canvas / img，或带 options.size 的任意容器
 * @param {object} [options]
 * @param {() => {w: number, h: number}} [options.size] 内容的自然尺寸（target 不是 canvas / img 时必填）
 * @param {(e: PointerEvent) => boolean} [options.shouldPan] 返回 false 时该次按下不触发平移，交给调用方处理
 * @param {(scale: number) => void} [options.onChange] 缩放或平移后回调
 */
export function createZoomView(viewport, target, options = {}) {
  viewport.classList.add('zoom-viewport');
  target.classList.add('zoom-target');
  if (target instanceof HTMLImageElement) target.draggable = false;

  const bar = document.createElement('div');
  bar.className = 'zoom-bar glass';
  bar.innerHTML = `
    <button type="button" data-zoom="out" title="缩小" aria-label="缩小">−</button>
    <button type="button" data-zoom="actual" class="zoom-level" title="实际大小 (1:1)">100%</button>
    <button type="button" data-zoom="in" title="放大" aria-label="放大">+</button>
    <button type="button" data-zoom="fit" title="适应窗口">适应</button>`;
  viewport.append(bar);
  const level = bar.querySelector('.zoom-level');

  let scale = 1;
  let x = 0;
  let y = 0;
  let fitMode = true;
  let size = { w: 0, h: 0 };
  let drag = null;
  let suppressClick = false;

  function naturalSize() {
    if (options.size) return options.size();
    return target instanceof HTMLImageElement
      ? { w: target.naturalWidth, h: target.naturalHeight }
      : { w: target.width, h: target.height };
  }

  function clampPan() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const w = size.w * scale;
    const h = size.h * scale;
    // 内容小于视口时居中，否则不允许把内容拖出视口
    x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, x));
    y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, y));
  }

  function apply() {
    clampPan();
    target.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    target.style.setProperty('--zoom', scale);
    target.classList.toggle('pixelated', scale >= 2);
    level.textContent = `${Math.round(scale * 100)}%`;
    options.onChange?.(scale);
  }

  function fit() {
    size = naturalSize();
    fitMode = true;
    const vw = viewport.clientWidth - FIT_PADDING * 2;
    const vh = viewport.clientHeight - FIT_PADDING * 2;
    const s = size.w && size.h ? Math.min(vw / size.w, vh / size.h) : 1;
    scale = s > 0 ? Math.min(MAX_SCALE, s) : 1;
    apply();
  }

  function zoomTo(next, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) {
    if (!size.w || !size.h) return;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    x = cx - (cx - x) * (s / scale);
    y = cy - (cy - y) * (s / scale);
    scale = s;
    fitMode = false;
    apply();
  }

  /** 内容变化后调用：尺寸变了就重新适应，否则保留当前缩放与位置，便于对比同一位置 */
  function refresh() {
    const n = naturalSize();
    if (fitMode || n.w !== size.w || n.h !== size.h) fit();
    else apply();
  }

  /** 让内容中的矩形区域（自然像素坐标）居中可见；当前缩放下放不下时缩小到刚好放下 */
  function showRect(r) {
    size = naturalSize();
    if (!size.w || !size.h) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const fitRect = Math.min((vw - FIT_PADDING * 4) / r.w, (vh - FIT_PADDING * 4) / r.h);
    if (fitRect > 0 && fitRect < scale) scale = Math.max(MIN_SCALE, fitRect);
    x = vw / 2 - (r.x + r.w / 2) * scale;
    y = vh / 2 - (r.y + r.h / 2) * scale;
    fitMode = false;
    apply();
  }

  const onWheel = (e) => {
    // 先隔离滚轮：空画布和缩放到极限时也不能带动外层页面。
    e.preventDefault();
    e.stopPropagation();
    if (!size.w || !size.h) return;
    const dy = Math.max(-200, Math.min(200, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY));
    const r = viewport.getBoundingClientRect();
    zoomTo(scale * Math.exp(-dy * 0.002), e.clientX - r.left, e.clientY - r.top);
  };

  const onPointerDown = (e) => {
    suppressClick = false;
    // 缩放条及视口内的其他按钮（如左右切换）不触发平移
    if ((e.button !== 0 && e.button !== 1) || e.target.closest('.zoom-bar, button')) return;
    if (options.shouldPan && !options.shouldPan(e)) return;
    if (e.button === 1) e.preventDefault(); // 阻止中键自动滚动
    drag = { sx: e.clientX, sy: e.clientY, x, y, moved: false };
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    viewport.classList.add('panning');
    x = drag.x + dx;
    y = drag.y + dy;
    fitMode = false;
    apply();
  };

  const onPointerUp = () => {
    if (!drag) return;
    suppressClick = drag.moved;
    drag = null;
    viewport.classList.remove('panning');
  };

  const onClickCapture = (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  const onBarClick = (e) => {
    const action = e.target.closest('button')?.dataset.zoom;
    if (!action) return;
    if (action === 'in') zoomTo(scale * STEP);
    else if (action === 'out') zoomTo(scale / STEP);
    else if (action === 'actual') zoomTo(1);
    else fit();
  };

  viewport.addEventListener('wheel', onWheel, { capture: true, passive: false });
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('click', onClickCapture, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  bar.addEventListener('click', onBarClick);

  const resizeObserver = new ResizeObserver(() => (fitMode ? fit() : apply()));
  resizeObserver.observe(viewport);

  return {
    refresh,
    fit,
    showRect,
    getScale: () => scale,
    destroy() {
      resizeObserver.disconnect();
      viewport.removeEventListener('wheel', onWheel, true);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('click', onClickCapture, true);
      bar.removeEventListener('click', onBarClick);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
