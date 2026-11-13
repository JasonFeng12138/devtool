// GIF 解码：解析帧结构（LZW 解压 + 按处置方式合成），纯函数，可在 Node 中测试

// 与浏览器一致：帧间隔小于 2/100 秒按 10/100 秒播放
const MIN_DELAY_CS = 2;
const DEFAULT_DELAY_CS = 10;

/**
 * 解析 GIF 文件，只做结构解析，像素在 createGifRenderer 中按需解压。
 * 返回 { width, height, duration, frames: [{ x, y, w, h, time, delay, disposal, transparent, palette, interlaced, minCodeSize, data }] }
 * time / delay / duration 单位为秒；文件截断时保留已完整读取的帧。
 */
export function parseGif(bytes) {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('不是有效的 GIF 文件');
  let pos = 6;
  const u8 = () => {
    if (pos >= bytes.length) throw new RangeError('truncated');
    return bytes[pos++];
  };
  const u16 = () => u8() | (u8() << 8);
  const readPalette = (size) => {
    if (pos + size * 3 > bytes.length) throw new RangeError('truncated');
    const p = bytes.subarray(pos, pos + size * 3);
    pos += size * 3;
    return p;
  };
  // 连续的数据子块拼接为一段
  const readSubBlocks = () => {
    const parts = [];
    let total = 0;
    for (let n = u8(); n; n = u8()) {
      if (pos + n > bytes.length) throw new RangeError('truncated');
      parts.push(bytes.subarray(pos, pos + n));
      pos += n;
      total += n;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  const width = u16();
  const height = u16();
  const packed = u8();
  pos += 2; // 背景色索引、像素宽高比（浏览器合成时不使用背景色）
  const globalPalette = packed & 0x80 ? readPalette(2 << (packed & 7)) : null;
  if (!width || !height) throw new Error('GIF 尺寸无效');

  const frames = [];
  let gce = null;
  let time = 0;
  try {
    for (;;) {
      const block = u8();
      if (block === 0x3b) break;
      if (block === 0x21) {
        const label = u8();
        if (label === 0xf9) {
          const data = readSubBlocks();
          if (data.length >= 4) {
            gce = {
              disposal: (data[0] >> 2) & 7,
              transparent: data[0] & 1 ? data[3] : -1,
              delay: data[1] | (data[2] << 8),
            };
          }
        } else {
          readSubBlocks();
        }
      } else if (block === 0x2c) {
        const x = u16();
        const y = u16();
        const w = u16();
        const h = u16();
        const flags = u8();
        const palette = flags & 0x80 ? readPalette(2 << (flags & 7)) : globalPalette;
        const minCodeSize = u8();
        const data = readSubBlocks();
        const cs = gce?.delay ?? 0;
        const delay = (cs < MIN_DELAY_CS ? DEFAULT_DELAY_CS : cs) / 100;
        if (palette && minCodeSize >= 1 && minCodeSize <= 11) {
          frames.push({
            x, y, w, h, time, delay,
            disposal: gce?.disposal ?? 0,
            transparent: gce?.transparent ?? -1,
            palette,
            interlaced: (flags & 0x40) !== 0,
            minCodeSize,
            data,
          });
          time += delay;
        }
        gce = null;
      } else {
        break; // 未知块，按文件结束处理
      }
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
  }
  if (!frames.length) throw new Error('GIF 中没有可读取的帧');
  return { width, height, duration: time, frames };
}

function lzwDecode(minCodeSize, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let avail = clear + 2;
  let old = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let pos = 0;
  let top = 0;
  let pi = 0;

  decode: while (pi < pixelCount) {
    if (top === 0) {
      while (bits < codeSize) {
        if (pos >= data.length) break decode;
        datum |= data[pos++] << bits;
        bits += 8;
      }
      let code = datum & codeMask;
      datum >>= codeSize;
      bits -= codeSize;
      if (code === clear) {
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        avail = clear + 2;
        old = -1;
        continue;
      }
      if (code === eoi) break;
      if (old === -1) {
        if (code >= clear) break; // 数据损坏
        stack[top++] = suffix[code];
        old = code;
        first = code;
        continue;
      }
      const inCode = code;
      if (code === avail) {
        stack[top++] = first;
        code = old;
      } else if (code > avail) {
        break; // 数据损坏
      }
      while (code > clear) {
        stack[top++] = suffix[code];
        code = prefix[code];
      }
      first = suffix[code];
      stack[top++] = first;
      if (avail < 4096) {
        prefix[avail] = old;
        suffix[avail] = first;
        avail++;
        if ((avail & codeMask) === 0 && avail < 4096) {
          codeSize++;
          codeMask += avail;
        }
      }
      old = inCode;
    }
    out[pi++] = stack[--top];
  }
  return out; // 数据不足时剩余像素为索引 0
}

// 隔行扫描：解压出的第 n 行对应的实际行号
function interlaceRows(h) {
  const rows = new Uint32Array(h);
  let n = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows[n++] = y;
  }
  return rows;
}

/**
 * 逐帧合成器。render(i) 返回第 i 帧合成后的整幅 RGBA（内部缓冲区，下次 render 前有效）。
 * 按顺序访问时只合成新增的帧；往回访问时从第一帧重新合成。
 */
export function createGifRenderer(gif) {
  const { width, height, frames } = gif;
  const canvas = new Uint8ClampedArray(width * height * 4);
  let current = -1;
  let saved = null; // 处置方式 3（恢复到上一帧）需要的快照

  function clearRect(f) {
    const x1 = Math.min(width, f.x + f.w);
    const y1 = Math.min(height, f.y + f.h);
    for (let y = f.y; y < y1; y++) canvas.fill(0, (y * width + f.x) * 4, (y * width + x1) * 4);
  }

  function draw(f) {
    const pixels = lzwDecode(f.minCodeSize, f.data, f.w * f.h);
    const rows = f.interlaced ? interlaceRows(f.h) : null;
    const pal = f.palette;
    const colors = pal.length / 3;
    for (let r = 0; r < f.h; r++) {
      const y = f.y + (rows ? rows[r] : r);
      if (y >= height) continue;
      for (let c = 0; c < f.w; c++) {
        const x = f.x + c;
        if (x >= width) break;
        const idx = pixels[r * f.w + c];
        if (idx === f.transparent || idx >= colors) continue;
        const o = (y * width + x) * 4;
        canvas[o] = pal[idx * 3];
        canvas[o + 1] = pal[idx * 3 + 1];
        canvas[o + 2] = pal[idx * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
  }

  function render(index) {
    const target = Math.max(0, Math.min(frames.length - 1, index));
    if (target < current) {
      canvas.fill(0);
      current = -1;
      saved = null;
    }
    while (current < target) {
      const prev = frames[current];
      if (prev?.disposal === 2) clearRect(prev);
      else if (prev?.disposal === 3 && saved) canvas.set(saved);
      current++;
      const f = frames[current];
      saved = f.disposal === 3 ? canvas.slice() : null;
      draw(f);
    }
    return canvas;
  }

  return { width, height, render };
}

/** 时间点（秒）所显示的帧序号 */
export function gifFrameAt(gif, time) {
  const { frames } = gif;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
