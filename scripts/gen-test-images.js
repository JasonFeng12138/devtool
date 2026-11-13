// 生成智能切图的测试素材图（零依赖，PNG 用 Node 自带 zlib 编码）：node scripts/gen-test-images.js
// 输出到 test-images/：白底、透明底、品红底三张同样内容的精灵图。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const W = 960;
const H = 720;
const SS = 4; // 每像素 4×4 超采样，产生抗锯齿边缘
const OUT_DIR = path.join(__dirname, '..', 'test-images');

// ---------- PNG 编码 ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // 不使用行过滤
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形状（返回“点是否在内部”的函数与外接范围） ----------
const circle = (cx, cy, r) => ({ box: [cx - r, cy - r, cx + r, cy + r], hit: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r });
const ellipse = (cx, cy, rx, ry) => ({ box: [cx - rx, cy - ry, cx + rx, cy + ry], hit: (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 });

function roundRect(x, y, w, h, r = 0) {
  return {
    box: [x, y, x + w, y + h],
    hit: (px, py) => {
      if (px < x || px > x + w || py < y || py > y + h) return false;
      const dx = Math.max(x + r - px, 0, px - (x + w - r));
      const dy = Math.max(y + r - py, 0, py - (y + h - r));
      return dx * dx + dy * dy <= r * r;
    },
  };
}

function polygon(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    hit: (x, y) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
  };
}

function star(cx, cy, outer, inner, points, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = rot + (i * Math.PI) / points;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return polygon(pts);
}

// 以 (cx, cy) 为中心、旋转 angle 的矩形（用于四肢、剑刃）
function rotRect(cx, cy, w, h, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return polygon([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]));
}

// ---------- 素材清单：每个操作是 { shape, color } 或 { shape, erase: true }（挖洞，露出背景） ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ops = [];
const fill = (shape, color) => ops.push({ shape, color: hex(color) });
const erase = (shape) => ops.push({ shape, erase: true });

// 第 1 行：常见道具图标，大小各不相同
fill(circle(80, 90, 40), '#e0a91b'); // 金币
fill(circle(80, 90, 30), '#f5c542');
fill(roundRect(74, 70, 12, 40, 3), '#c98d0c');
fill(star(205, 92, 50, 22, 5), '#f2b705'); // 五角星
fill(circle(318, 80, 22), '#e23d4b'); // 爱心
fill(circle(352, 80, 22), '#e23d4b');
fill(polygon([[297, 88], [373, 88], [335, 132]]), '#e23d4b');
fill(polygon([[460, 40], [500, 80], [460, 140], [420, 80]]), '#2ec4d6'); // 宝石
fill(polygon([[460, 40], [500, 80], [460, 80]]), '#8be6f0');
fill(circle(590, 108, 30), '#7b4ddb'); // 药水瓶：瓶身、瓶颈、瓶塞彼此相接
fill(roundRect(580, 58, 20, 24, 2), '#b9a3f0');
fill(roundRect(576, 46, 28, 12, 3), '#8a5a2b');
fill(roundRect(680, 40, 80, 100, 18), '#3d6fd6'); // 盾牌，中间挖空露出背景
erase(circle(720, 88, 16));
fill(star(720, 89, 9, 4, 5), '#ffd166'); // 镂空里不相连的徽章：被盾牌的框包含，应自动并入盾牌
fill(rotRect(860, 86, 12, 110, Math.PI / 4), '#c7ccd6'); // 斜放的剑：剑刃 + 护手 + 剑柄
fill(rotRect(834, 112, 40, 10, -Math.PI / 4), '#8a5a2b');
fill(rotRect(822, 124, 10, 22, Math.PI / 4), '#5b3a1a');

// 第 2 行：多部件素材，测试“合并距离”
fill(circle(100, 207, 22), '#f1c27d'); // 小人：头、身体、手臂、腿之间都隔 3px
fill(roundRect(75, 232, 50, 60, 10), '#2f9e62');
fill(roundRect(62, 238, 10, 44, 5), '#f1c27d');
fill(roundRect(128, 238, 10, 44, 5), '#f1c27d');
fill(roundRect(80, 295, 16, 34, 4), '#3b4a6b');
fill(roundRect(104, 295, 16, 34, 4), '#3b4a6b');
for (const [x, y] of [[250, 230], [282, 234], [258, 262], [292, 266], [276, 296]]) {
  fill(star(x, y, 11, 3, 4, 0), '#ffcf3f'); // 闪光：5 颗小星星，外框间距约 8~12px（合并距离调到 12 左右会合成一组）
}
fill(roundRect(400, 235, 50, 50, 8), '#ef7d2d'); // 两个相距 10px 的独立方块
fill(roundRect(460, 235, 50, 50, 8), '#2d9cef');
fill(circle(620, 260, 45), '#9b5de5'); // 圆环（中间是洞，但仍是一个素材）
erase(circle(620, 260, 22));
fill(roundRect(720, 258, 200, 3, 1), '#444b5a'); // 3px 高的细线，宽度足够，不应被当成噪点

// 第 3 行：6 帧走路动画，每帧宽度不同（测试“统一尺寸”与发送到图片批处理做动画）
const legAngles = [0.45, 0.25, 0, -0.25, -0.45, 0];
legAngles.forEach((a, i) => {
  const cx = 90 + i * 140;
  const bob = i % 3 === 2 ? -4 : 0;
  fill(rotRect(cx - 9, 525 + bob, 10, 46, a), '#3b4a6b'); // 双腿与身体相连
  fill(rotRect(cx + 9, 525 + bob, 10, 46, -a), '#3b4a6b');
  fill(ellipse(cx, 482 + bob, 26, 32), '#e4572e'); // 身体
  fill(circle(cx, 440 + bob, 18), '#f1c27d'); // 头（与身体相接）
  fill(rotRect(cx + 24, 482 + bob, 9, 36, -a * 1.4), '#f1c27d'); // 摆臂
});

// 第 4 行：大小差异、浅色素材和噪点
fill(ellipse(140, 650, 90, 34), '#4caf50'); // 大叶子
fill(rotRect(140, 650, 160, 3, 0), '#2e7d32');
for (let i = 0; i < 5; i++) fill(roundRect(280 + i * 20, 640, 12, 12, 3), '#5c6bc0'); // 12px 小图标，间隔 8px
for (let i = 0; i < 4; i++) fill(roundRect(400 + i * 14, 643, 6, 6, 1), '#ab47bc'); // 6px 小方块：默认最小尺寸 8 会被当成噪点
fill(circle(560, 650, 26), '#ececec'); // 很浅的云：与白底颜色很接近，测试容差
fill(circle(590, 640, 32), '#ececec');
fill(circle(622, 652, 24), '#ececec');
fill(roundRect(700, 610, 220, 80, 14), '#26323f'); // UI 面板与上面的两个按钮
fill(roundRect(716, 660, 80, 20, 6), '#3fb950');
fill(roundRect(824, 660, 80, 20, 6), '#f85149');

// 散落的 1~2px 噪点
const specks = [[30, 360], [520, 380], [880, 380], [350, 590], [680, 560], [930, 700], [250, 700], [600, 30], [940, 180], [20, 600]];
specks.forEach(([x, y], i) => fill(roundRect(x, y, 1 + (i % 2), 1 + (i % 2), 0), '#333333'));

// ---------- 渲染 ----------
function render(bg) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set(bg, i);
  for (const op of ops) {
    const [bx0, by0, bx1, by1] = op.shape.box;
    for (let y = Math.max(0, Math.floor(by0)); y <= Math.min(H - 1, Math.ceil(by1)); y++) {
      for (let x = Math.max(0, Math.floor(bx0)); x <= Math.min(W - 1, Math.ceil(bx1)); x++) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) if (op.shape.hit(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
        }
        if (!hits) continue;
        const a = hits / (SS * SS);
        const i = (y * W + x) * 4;
        if (op.erase) {
          // 按覆盖率把像素混回背景（透明底时 alpha 也随之降低）
          for (let k = 0; k < 4; k++) data[i + k] = Math.round(data[i + k] * (1 - a) + bg[k] * a);
        } else {
          // 普通 alpha 合成（source-over）
          const da = data[i + 3] / 255;
          const oa = a + da * (1 - a);
          for (let k = 0; k < 3; k++) data[i + k] = Math.round((op.color[k] * a + data[i + k] * da * (1 - a)) / oa);
          data[i + 3] = Math.round(oa * 255);
        }
      }
    }
  }
  return data;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, bg] of [
  ['sprites-white.png', [255, 255, 255, 255]],
  ['sprites-transparent.png', [0, 0, 0, 0]],
  ['sprites-magenta.png', [255, 0, 255, 255]],
]) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(render(bg), W, H));
  console.log(`已生成 ${path.relative(process.cwd(), file)}`);
}

// SVG 矢量精灵图：只有 viewBox、没有 width / height（测试尺寸推断，「自动」倍数会渲染为 1440×1080）
const starPoints = (cx, cy, outer, inner, n) => Array.from({ length: n * 2 }, (_, i) => {
  const r = i % 2 ? inner : outer;
  const a = -Math.PI / 2 + (i * Math.PI) / n;
  return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
}).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360">
  <!-- 第 1 行：图标 -->
  <circle cx="50" cy="50" r="30" fill="#e0a91b"/><circle cx="50" cy="50" r="22" fill="#f5c542"/>
  <polygon points="${starPoints(140, 52, 34, 15, 5)}" fill="#f2b705"/>
  <path d="M230 40 a15 15 0 0 1 30 0 a15 15 0 0 1 30 0 q0 25 -30 45 q-30 -20 -30 -45z" fill="#e23d4b"/>
  <polygon points="350,18 378,48 350,86 322,48" fill="#2ec4d6"/>
  <rect x="405" y="18" width="56" height="66" rx="12" fill="#3d6fd6"/><circle cx="433" cy="51" r="11" fill="#fff"/>
  <!-- 第 2 行：多部件小人（部件间隔 2 个单位，渲染 3× 后约 6px）与渐变圆 -->
  <circle cx="60" cy="140" r="16" fill="#f1c27d"/>
  <rect x="42" y="158" width="36" height="44" rx="7" fill="#2f9e62"/>
  <rect x="32" y="162" width="8" height="32" rx="4" fill="#f1c27d"/><rect x="80" y="162" width="8" height="32" rx="4" fill="#f1c27d"/>
  <rect x="46" y="204" width="12" height="24" rx="3" fill="#3b4a6b"/><rect x="62" y="204" width="12" height="24" rx="3" fill="#3b4a6b"/>
  <defs><radialGradient id="g"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ef476f"/></radialGradient></defs>
  <circle cx="180" cy="180" r="40" fill="url(#g)"/>
  <rect x="260" y="150" width="90" height="60" rx="10" fill="none" stroke="#9b5de5" stroke-width="8"/>
  <path d="M390 220 C 400 140, 460 140, 470 220 Z" fill="#06d6a0"/>
  <!-- 第 3 行：细线与小图标 -->
  <rect x="20" y="280" width="200" height="2" fill="#444b5a"/>
  ${[0, 1, 2, 3, 4].map((i) => `<rect x="${260 + i * 26}" y="270" width="16" height="16" rx="4" fill="#5c6bc0"/>`).join('')}
</svg>
`;
fs.writeFileSync(path.join(OUT_DIR, 'sprites-vector.svg'), svg);
console.log(`已生成 ${path.relative(process.cwd(), path.join(OUT_DIR, 'sprites-vector.svg'))}`);
