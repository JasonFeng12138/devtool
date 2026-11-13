import imageSlicer from './tools/image-slicer.js';
import smartSlicer from './tools/smart-slicer.js';
import videoFrames from './tools/video-frames.js';
import imageBatch from './tools/image-batch.js';
import screenPreview from './tools/screen-preview.js';
import pixelCleanup from './tools/pixel-cleanup.js';

// 新工具：在 tools/ 下实现 { id, name, description, icon, mount(root) => cleanup }，再加入此列表
const tools = [imageSlicer, smartSlicer, videoFrames, imageBatch, pixelCleanup, screenPreview];

const ICONS = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>',
};

const nav = document.getElementById('tool-nav');
const root = document.getElementById('tool-root');
const main = document.querySelector('.main');
const pageTitle = document.getElementById('page-title');
const pageDesc = document.getElementById('page-desc');
const themeToggle = document.getElementById('theme-toggle');
const sidebarPin = document.getElementById('sidebar-pin');
let active = null;
let cleanup = null;

function activate(id) {
  const tool = tools.find((t) => t.id === id) || tools[0];
  if (tool === active) return;
  cleanup?.();
  root.replaceChildren();
  pageTitle.textContent = tool.name;
  pageDesc.textContent = tool.description || '';
  cleanup = tool.mount(root);
  main.scrollTop = 0;
  active = tool;
  document.title = `${tool.name} - DevTool`;
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.id === tool.id);
    if (a.dataset.id === tool.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

for (const tool of tools) {
  const a = document.createElement('a');
  a.className = 'nav-item';
  a.href = `#${tool.id}`;
  a.dataset.id = tool.id;
  a.title = tool.name; // 图标栏模式下悬停提示
  a.innerHTML = `${tool.icon || ''}<span class="nav-label"></span>`;
  a.querySelector('.nav-label').textContent = tool.name;
  nav.append(a);
}

function renderThemeToggle() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? '浅色模式' : '深色模式';
  themeToggle.innerHTML = `${dark ? ICONS.sun : ICONS.moon}<span class="nav-label">${label}</span>`;
  themeToggle.title = label;
}

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('devtool-theme', next);
  renderThemeToggle();
});

// 侧栏：pinned 固定展开；collapsed 收起为图标栏，鼠标移入时悬浮展开
const sidebar = document.querySelector('.sidebar');
let peekTimer;
let suppressPeek = false; // 刚点了“收起”时鼠标还在侧栏上，需移出后再移入才展开

function setPeek(on) {
  clearTimeout(peekTimer);
  sidebar.classList.toggle('is-peek', on);
}

sidebar.addEventListener('mouseenter', () => {
  if (suppressPeek) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => sidebar.classList.add('is-peek'), 120); // 避免鼠标掠过时误展开
});
sidebar.addEventListener('mouseleave', () => {
  suppressPeek = false;
  if (!sidebar.querySelector(':focus-visible')) setPeek(false);
});
sidebar.addEventListener('focusin', (e) => {
  if (e.target.matches(':focus-visible')) setPeek(true);
});
sidebar.addEventListener('focusout', (e) => {
  if (!sidebar.contains(e.relatedTarget) && !sidebar.matches(':hover')) setPeek(false);
});

function renderSidebarPin() {
  const pinned = document.documentElement.dataset.sidebar !== 'collapsed';
  const label = pinned ? '收起侧栏' : '固定侧栏';
  sidebarPin.innerHTML = `${pinned ? ICONS.collapse : ICONS.pin}<span class="nav-label">${label}</span>`;
  sidebarPin.title = label;
}

sidebarPin.addEventListener('click', () => {
  const next = document.documentElement.dataset.sidebar === 'collapsed' ? 'pinned' : 'collapsed';
  document.documentElement.dataset.sidebar = next;
  localStorage.setItem('devtool-sidebar', next);
  suppressPeek = next === 'collapsed';
  setPeek(false);
  renderSidebarPin();
});

renderThemeToggle();
renderSidebarPin();
window.addEventListener('hashchange', () => activate(location.hash.slice(1)));
activate(location.hash.slice(1));
