// 零依赖 GIF89a 编码器：每帧用中位切分量化出局部调色板（≤256 色）并 LZW 压缩；alpha < 128 视为透明。

const HIST_SIZE = 1 << 15; // RGB 各取高 5 位作为直方图桶
const MAX_CODE = 4096;

function u16(v) {
  return [v & 0xff, (v >> 8) & 0xff];
}

// 盒子评分为加权平方误差，优先切分颜色最分散的盒子；沿方差最大的通道切分
function makeBox(keys, hist, start, end) {
  let count = 0, sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0;
  for (let j = start; j < end; j++) {
    const k = keys[j];
    const w = hist[k];
    const r = (k >> 10) & 31, g = (k >> 5) & 31, b = k & 31;
    count += w;
    sr += w * r;
    sg += w * g;
    sb += w * b;
    qr += w * r * r;
    qg += w * g * g;
    qb += w * b * b;
  }
  const vars = [qr - (sr * sr) / count, qg - (sg * sg) / count, qb - (sb * sb) / count];
  const maxVar = Math.max(...vars);
  return {
    start,
    end,
    count,
    score: end - start > 1 ? vars[0] + vars[1] + vars[2] : 0,
    channel: vars.indexOf(maxVar),
  };
}

function splitBox(keys, hist, box) {
  const shift = [10, 5, 0][box.channel];
  keys.subarray(box.start, box.end).sort((x, y) => ((x >> shift) & 31) - ((y >> shift) & 31));
  const half = box.count / 2;
  let acc = 0;
  let mid = box.end - 1;
  for (let j = box.start; j < box.end - 1; j++) {
    acc += hist[keys[j]];
    if (acc >= half) {
      mid = j + 1;
      break;
    }
  }
  return [makeBox(keys, hist, box.start, mid), makeBox(keys, hist, mid, box.end)];
}

function quantize(rgba) {
  const hist = new Uint32Array(HIST_SIZE);
  const sumR = new Float64Array(HIST_SIZE);
  const sumG = new Float64Array(HIST_SIZE);
  const sumB = new Float64Array(HIST_SIZE);
  let hasAlpha = false;

  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) {
      hasAlpha = true;
      continue;
    }
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    hist[k]++;
    sumR[k] += r;
    sumG[k] += g;
    sumB[k] += b;
  }

  let used = 0;
  for (let k = 0; k < HIST_SIZE; k++) if (hist[k]) used++;
  const keys = new Uint16Array(used);
  for (let k = 0, j = 0; k < HIST_SIZE; k++) if (hist[k]) keys[j++] = k;

  const maxColors = hasAlpha ? 255 : 256; // 透明色占用一个索引
  const boxes = used ? [makeBox(keys, hist, 0, used)] : [];
  while (boxes.length < maxColors) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].score > bestScore) {
        bestScore = boxes[i].score;
        best = i;
      }
    }
    if (best < 0) break;
    boxes.splice(best, 1, ...splitBox(keys, hist, boxes[best]));
  }

  const palette = new Uint8Array(256 * 3);
  const lookup = new Uint8Array(HIST_SIZE);
  boxes.forEach((box, idx) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (let j = box.start; j < box.end; j++) {
      const k = keys[j];
      lookup[k] = idx;
      n += hist[k];
      r += sumR[k];
      g += sumG[k];
      b += sumB[k];
    }
    palette[idx * 3] = Math.round(r / n);
    palette[idx * 3 + 1] = Math.round(g / n);
    palette[idx * 3 + 2] = Math.round(b / n);
  });

  return { palette, lookup, transparentIndex: hasAlpha ? boxes.length : -1 };
}

class LzwEncoder {
  constructor() {
    // 字典键 = (前缀码 << 8) | 索引；用代号标记有效项，重置字典无需清空数组
    this.codes = new Int16Array(MAX_CODE << 8);
    this.stamps = new Int32Array(MAX_CODE << 8);
    this.gen = 0;
  }

  encode(indices, minCodeSize) {
    const { codes, stamps } = this;
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const out = new Uint8Array(Math.ceil(indices.length * 1.51) + 32);
    let pos = 0, cur = 0, bits = 0;
    let codeSize = minCodeSize + 1;
    let next = eoiCode + 1;
    let gen = ++this.gen;

    const emit = (code) => {
      cur |= code << bits;
      bits += codeSize;
      while (bits >= 8) {
        out[pos++] = cur & 0xff;
        cur >>>= 8;
        bits -= 8;
      }
    };

    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      if (stamps[key] === gen) {
        prefix = codes[key];
        continue;
      }
      emit(prefix);
      if (next === MAX_CODE) {
        emit(clearCode);
        codeSize = minCodeSize + 1;
        next = eoiCode + 1;
        gen = ++this.gen;
      } else {
        if (next >= 1 << codeSize) codeSize++;
        codes[key] = next++;
        stamps[key] = gen;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bits > 0) out[pos++] = cur & 0xff;
    return out.subarray(0, pos);
  }
}

function toSubBlocks(data) {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 255) + 1);
  let p = 0;
  for (let i = 0; i < data.length; i += 255) {
    const len = Math.min(255, data.length - i);
    out[p++] = len;
    out.set(data.subarray(i, i + len), p);
    p += len;
  }
  out[p] = 0;
  return out;
}

export class GifEncoder {
  /** @param {{ loop?: number }} options loop：0 无限循环，>0 循环次数，<0 只播放一次 */
  constructor(width, height, { loop = 0 } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
      throw new Error('GIF 尺寸无效');
    }
    this.width = width;
    this.height = height;
    this.lzw = new LzwEncoder();
    this.parts = [
      new TextEncoder().encode('GIF89a'),
      Uint8Array.of(...u16(width), ...u16(height), 0x00, 0x00, 0x00), // 不使用全局调色板
    ];
    if (loop >= 0) {
      this.parts.push(Uint8Array.of(
        0x21, 0xff, 0x0b, ...new TextEncoder().encode('NETSCAPE2.0'), 0x03, 0x01, ...u16(Math.min(loop, 65535)), 0x00,
      ));
    }
  }

  /** @param {Uint8ClampedArray} rgba @param {number} delayCs 帧间隔（百分之一秒） */
  addFrame(rgba, delayCs) {
    const { width, height } = this;
    if (rgba.length !== width * height * 4) throw new Error('帧尺寸与 GIF 尺寸不一致');
    const { palette, lookup, transparentIndex } = quantize(rgba);

    const indices = new Uint8Array(width * height);
    for (let i = 0, p = 0; p < indices.length; i += 4, p++) {
      indices[p] = rgba[i + 3] < 128
        ? transparentIndex
        : lookup[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
    }

    const transparent = transparentIndex >= 0;
    // 有透明像素时用“恢复背景”处置，避免上一帧从透明处透出来
    const packed = ((transparent ? 2 : 1) << 2) | (transparent ? 1 : 0);
    const delay = Math.max(2, Math.min(65535, Math.round(delayCs)));
    this.parts.push(
      Uint8Array.of(0x21, 0xf9, 0x04, packed, ...u16(delay), transparent ? transparentIndex : 0, 0x00),
      Uint8Array.of(0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0x87), // 局部调色板 256 色
      palette,
      Uint8Array.of(8),
      toSubBlocks(this.lzw.encode(indices, 8)),
    );
  }

  finish() {
    this.parts.push(Uint8Array.of(0x3b));
    return new Blob(this.parts, { type: 'image/gif' });
  }
}
