// 按颜色去除背景（色键），视频抽帧与图片批处理共用

export const MAX_COLOR_DISTANCE = Math.sqrt(3 * 255 * 255);

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * 原地修改 RGBA 数据：与任一背景色的 RGB 距离 ≤ 容差的像素变为全透明，
 * 容差到“容差 + 羽化”之间的像素按距离线性降低 alpha。
 * @param {Uint8ClampedArray} data
 * @param {{ colors: number[][], tolerance: number, feather: number }} params 容差、羽化为 0~100 的百分比
 */
export function removeBackground(data, { colors, tolerance, feather }) {
  if (!colors.length) return;
  const t = (tolerance / 100) * MAX_COLOR_DISTANCE;
  const f = (feather / 100) * MAX_COLOR_DISTANCE;
  const t2 = t * t;
  const outer2 = (t + f) ** 2;
  const n = colors.length;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let min = Infinity;
    for (let k = 0; k < n; k++) {
      const c = colors[k];
      const dr = r - c[0], dg = g - c[1], db = b - c[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < min) min = d;
    }
    if (min > outer2) continue;
    data[i + 3] = min <= t2 ? 0 : Math.round((data[i + 3] * (Math.sqrt(min) - t)) / f);
  }
}
