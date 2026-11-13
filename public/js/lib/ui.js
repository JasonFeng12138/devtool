export const ICON_UPLOAD = '<svg class="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';

let toastTimer;

export function toast(message, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// 把模板中带 data-ref 的元素收集为 { name: element }
export function collectRefs(root) {
  const refs = {};
  for (const el of root.querySelectorAll('[data-ref]')) refs[el.dataset.ref] = el;
  return refs;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

// ---------- 右下角任务进度卡片 ----------
// 同一时间只显示一个任务，新任务会接管卡片；完成后变为提醒，几秒后自动消失。
// 卡片挂在 body 上，切换工具时不会消失（例如智能切图发送到图片批处理）。

const PROGRESS_ICONS = {
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

let progressEl = null;
let progressSeq = 0;
let progressTimer = 0;

function progressCard() {
  if (progressEl) return progressEl;
  progressEl = document.createElement('div');
  progressEl.className = 'progress-card glass';
  progressEl.hidden = true;
  progressEl.innerHTML = `
    <div class="progress-head">
      <span class="progress-icon" aria-hidden="true"></span>
      <span class="progress-title" role="status" aria-live="polite"></span>
      <span class="progress-count"></span>
      <button type="button" class="icon-btn progress-close" title="关闭" aria-label="关闭">${PROGRESS_ICONS.close}</button>
    </div>
    <div class="progress-track"><div class="progress-bar"></div></div>`;
  progressEl.querySelector('.progress-close').addEventListener('click', () => hideProgress(progressSeq));
  document.body.append(progressEl);
  return progressEl;
}

function hideProgress(id) {
  if (id !== progressSeq || !progressEl) return;
  clearTimeout(progressTimer);
  progressEl.classList.add('is-leaving');
  progressTimer = setTimeout(() => {
    if (id === progressSeq) progressEl.hidden = true;
  }, 200);
}

/**
 * 显示进度卡片并返回任务对象。total 为 0 时显示不确定进度（来回滑动的进度条）。
 * @returns {{ update(done: number, total?: number, title?: string): void, finish(message: string): void, fail(message: string): void }}
 */
export function startProgress(title, total = 0) {
  const el = progressCard();
  const id = ++progressSeq;
  clearTimeout(progressTimer);
  const titleEl = el.querySelector('.progress-title');
  const countEl = el.querySelector('.progress-count');
  const iconEl = el.querySelector('.progress-icon');
  const bar = el.querySelector('.progress-bar');
  el.classList.remove('is-leaving');
  el.dataset.state = 'running';
  iconEl.innerHTML = '';
  el.hidden = false;

  const set = (label, done, n) => {
    if (label) titleEl.textContent = label;
    el.classList.toggle('is-indeterminate', !n);
    bar.style.width = n ? `${Math.min(100, (done / n) * 100)}%` : '';
    countEl.textContent = n ? `${done}/${n}` : '';
  };
  const end = (state, message, ms) => {
    if (id !== progressSeq) return;
    el.dataset.state = state;
    el.classList.remove('is-indeterminate');
    iconEl.innerHTML = PROGRESS_ICONS[state];
    titleEl.textContent = message;
    countEl.textContent = '';
    bar.style.width = '100%';
    progressTimer = setTimeout(() => hideProgress(id), ms);
  };
  set(title, 0, total);

  return {
    update(done, n = total, label) {
      if (id !== progressSeq) return;
      total = n;
      set(label, done, n);
    },
    finish: (message) => end('done', message, 3500),
    fail: (message) => end('error', message, 6000),
  };
}
