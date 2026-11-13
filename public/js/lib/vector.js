// 矢量图（SVG）支持：解析固有尺寸、按倍数栅格化为 PNG、按区域裁出保留矢量的 SVG。
// 浏览器的 createImageBitmap 不能直接解码 SVG，统一先通过 <img> 渲染到 canvas。

export const MAX_RASTER = 8192; // 栅格化后长边上限
const AUTO_TARGET = 1024; // 「自动」倍数：把长边放大到约 1024px
const AUTO_MAX_SCALE = 8;
const FALLBACK_SIZE = { width: 300, height: 150 }; // 浏览器对无尺寸 SVG 的默认大小

/** 渲染倍数下拉框的选项 */
export const SVG_SCALE_OPTIONS = `
  <option value="auto">自动（长边约 1024px）</option>
  <option value="1">1×（原始尺寸）</option>
  <option value="2">2×</option>
  <option value="4">4×</option>
  <option value="8">8×</option>`;

export function isSvg(file) {
  return file?.type === 'image/svg+xml' || /\.svg$/i.test(file?.name || '');
}

const UNIT_PX = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

// 绝对长度转 CSS 像素；百分比、em 等相对单位返回 null
function parseLength(value) {
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(value || '');
  if (!m) return null;
  const k = UNIT_PX[m[2].toLowerCase()];
  const v = k ? parseFloat(m[1]) * k : NaN;
  return v > 0 ? v : null;
}

/**
 * 读取并解析 SVG 文件。
 * @returns {Promise<{ root: Element, width: number, height: number, viewBox: number[] | null }>} width / height 为固有尺寸（CSS 像素）
 */
export async function readSvg(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('不是有效的 SVG 文件');
  }
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const viewBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0 ? vb : null;
  let width = parseLength(root.getAttribute('width'));
  let height = parseLength(root.getAttribute('height'));
  if (viewBox) {
    if (!width && !height) {
      width = viewBox[2];
      height = viewBox[3];
    } else if (!width) {
      width = (height * viewBox[2]) / viewBox[3];
    } else if (!height) {
      height = (width * viewBox[3]) / viewBox[2];
    }
  }
  return {
    root,
    width: width || FALLBACK_SIZE.width,
    height: height || FALLBACK_SIZE.height,
    viewBox,
  };
}

/** 解析倍数选择（'auto' 或数字），并保证栅格化后长边不超过 MAX_RASTER */
export function resolveScale(choice, info) {
  const long = Math.max(info.width, info.height);
  const s = choice === 'auto'
    ? (long >= AUTO_TARGET ? 1 : Math.min(AUTO_MAX_SCALE, Math.ceil(AUTO_TARGET / long)))
    : Number(choice) || 1;
  return Math.min(s, MAX_RASTER / long);
}

export function rasterSize(info, scale) {
  return { w: Math.max(1, Math.round(info.width * scale)), h: Math.max(1, Math.round(info.height * scale)) };
}

// 复制根元素并把尺寸设为 w×h 像素；缺少 viewBox 时补上，使内容随尺寸缩放
function sizedRoot(info, w, h) {
  const root = info.root.cloneNode(true);
  if (!info.viewBox) root.setAttribute('viewBox', `0 0 ${info.width} ${info.height}`);
  root.setAttribute('width', w);
  root.setAttribute('height', h);
  return root;
}

/** 按倍数把 SVG 渲染为 PNG 文件（文件名沿用原名，扩展名改为 .png） */
export async function rasterizeSvg(info, scale, name = 'vector.svg') {
  const { w, h } = rasterSize(info, scale);
  const markup = new XMLSerializer().serializeToString(sizedRoot(info, w, h));
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('SVG 渲染失败'))), 'image/png');
    });
    return new File([blob], `${name.replace(/\.svg$/i, '') || 'vector'}.png`, { type: 'image/png' });
  } catch (err) {
    if (err.name === 'SecurityError') throw new Error('该 SVG 含有浏览器禁止导出的内容（如 foreignObject）');
    if (err.name === 'EncodingError') throw new Error('SVG 渲染失败，可能格式有误或引用了无法加载的外部资源');
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 裁出保留矢量的 SVG：原图内容整体嵌套在新 SVG 中，通过 viewBox 只显示裁切区域。
 * @param rect 栅格坐标（scale 倍）中的裁切区域 { x, y, w, h }
 * @param frame 可选的统一画布 { w, h, dx, dy }（栅格像素），素材在画布中偏移 dx / dy
 * @returns {Blob} 输出尺寸与对应的 PNG 相同（栅格像素）
 */
export function cropSvg(info, scale, rect, frame) {
  const inner = sizedRoot(info, info.width, info.height);
  inner.setAttribute('x', 0);
  inner.setAttribute('y', 0);
  const ow = frame ? frame.w : rect.w;
  const oh = frame ? frame.h : rect.h;
  const ox = rect.x - (frame ? frame.dx : 0);
  const oy = rect.y - (frame ? frame.dy : 0);
  const n = (v) => +(v / scale).toFixed(4);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${ow}" height="${oh}" viewBox="${n(ox)} ${n(oy)} ${n(ow)} ${n(oh)}">`
    + new XMLSerializer().serializeToString(inner)
    + '</svg>';
  return new Blob([markup], { type: 'image/svg+xml' });
}
