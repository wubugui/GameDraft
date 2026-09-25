/**
 * 最小 PNG 编解码 + 像素对比(只靠 node:zlib,不引依赖)。
 *
 * 解码:8 位、非交错的灰度 / 灰度+α / RGB / RGBA(Playwright 截图只出 8 位 RGB/RGBA 非交错,这里多收两种灰度兜底);
 *       其它格式(16 位、调色板、Adam7 交错)直接抛错,不猜。
 * 编码:8 位 RGB,逐行自适应选滤波(五种里挑绝对值和最小的那种),deflate 6 档。
 * 对比:单像素差 = 三个颜色通道绝对差的最大值;> 阈值(缺省 16)算「不同像素」。
 *       另数一下「不同像素」里有多少能被 ±1 行位移解释(A 的这个像素 ≈ B 上一行或下一行同列的像素):
 *       master(WebGL)与分支(WebGPU)默认帧缓冲光栅化方向相反,恰好落在半像素上的水平边会整行错开一行,
 *       几乎全部可由行位移解释的差异多半就是这一类(也可能是 1 像素的纵向摆位差,看热图定)。
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** @returns {{width:number,height:number,data:Uint8Array}} data 恒为 RGBA */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      ctype = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !channels || interlace !== 0) {
    throw new Error(`不支持的 PNG 格式(位深 ${depth} / 色型 ${ctype} / 交错 ${interlace});只收 8 位非交错灰度/RGB/RGBA`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据长度不足');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= channels && y > 0 ? px[prev + x - channels] : 0;
      let out;
      switch (f) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error(`PNG 行滤波类型非法:${f}`);
      }
      px[dst + x] = out & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: px };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels === 3) {
      data[o] = px[j]; data[o + 1] = px[j + 1]; data[o + 2] = px[j + 2]; data[o + 3] = 255;
    } else if (channels === 1) {
      data[o] = data[o + 1] = data[o + 2] = px[j]; data[o + 3] = 255;
    } else {
      data[o] = data[o + 1] = data[o + 2] = px[j]; data[o + 3] = px[j + 1];
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** 编码成 8 位 RGB PNG(丢 α;截图恒不透明)。rgb:长度 w*h*3 */
export function encodePngRgb(width, height, rgb) {
  const stride = width * 3;
  const out = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = rgb[row + x];
        const a = x >= 3 ? rgb[row + x - 3] : 0;
        const b = y > 0 ? rgb[prev + x] : 0;
        const cc = x >= 3 && y > 0 ? rgb[prev + x - 3] : 0;
        let o;
        switch (f) {
          case 0: o = v; break;
          case 1: o = v - a; break;
          case 2: o = v - b; break;
          case 3: o = v - ((a + b) >> 1); break;
          default: o = v - paeth(a, b, cc);
        }
        o &= 0xff;
        c[x] = o;
        sum += o < 128 ? o : 256 - o;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    // 早退只是剪枝:选中的那种要完整重算一遍
    const c = cand[best];
    for (let x = 0; x < stride; x++) {
      const v = rgb[row + x];
      const a = x >= 3 ? rgb[row + x - 3] : 0;
      const b = y > 0 ? rgb[prev + x] : 0;
      const cc = x >= 3 && y > 0 ? rgb[prev + x - 3] : 0;
      let o;
      switch (best) {
        case 0: o = v; break;
        case 1: o = v - a; break;
        case 2: o = v - b; break;
        case 3: o = v - ((a + b) >> 1); break;
        default: o = v - paeth(a, b, cc);
      }
      c[x] = o & 0xff;
    }
    out[y * (stride + 1)] = best;
    c.copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 两张 RGBA 图逐像素比。尺寸不同时按重叠区比,重叠区外整片算「不同」(百分比按两者并集面积)。
 * 同时出热图(RGB,尺寸 = 重叠区):相同像素压暗成灰,阈值内的差蓝色,超阈值的红→黄按幅度。
 */
export function diffImages(a, b, threshold = 16) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const unionArea = Math.max(a.width, b.width) * Math.max(a.height, b.height);
  const heat = new Uint8Array(w * h * 3);
  let bad = 0;
  let rowShift = 0;
  let changed = 0;
  let max = 0;
  let sum = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[ia] - b.data[ib]),
        Math.abs(a.data[ia + 1] - b.data[ib + 1]),
        Math.abs(a.data[ia + 2] - b.data[ib + 2]),
      );
      const o = (y * w + x) * 3;
      sum += d;
      if (d > max) max = d;
      if (d === 0) {
        const g = ((a.data[ia] * 77 + a.data[ia + 1] * 150 + a.data[ia + 2] * 29) >> 8) >> 2;
        heat[o] = heat[o + 1] = heat[o + 2] = g;
        continue;
      }
      changed++;
      if (d > threshold) {
        bad++;
        for (const dy of [-1, 1]) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const js = (yy * b.width + x) * 4;
          const ds = Math.max(
            Math.abs(a.data[ia] - b.data[js]),
            Math.abs(a.data[ia + 1] - b.data[js + 1]),
            Math.abs(a.data[ia + 2] - b.data[js + 2]),
          );
          if (ds <= threshold) {
            rowShift++;
            break;
          }
        }
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        heat[o] = 255;
        heat[o + 1] = Math.min(255, (d - threshold) * 2);
        heat[o + 2] = 0;
      } else {
        heat[o] = 0;
        heat[o + 1] = 40;
        heat[o + 2] = 90 + d * 10;
      }
    }
  }
  const outside = unionArea - w * h;
  return {
    sameSize: a.width === b.width && a.height === b.height,
    sizeA: [a.width, a.height],
    sizeB: [b.width, b.height],
    badPct: ((bad + outside) / unionArea) * 100,
    changedPct: ((changed + outside) / unionArea) * 100,
    badPixels: bad + outside,
    rowShiftPct: bad + outside > 0 ? (rowShift / (bad + outside)) * 100 : 0,
    max: outside > 0 ? 255 : max,
    mean: sum / Math.max(1, w * h),
    bbox: maxX >= 0 ? [minX, minY, maxX, maxY] : null,
    heat: { width: w, height: h, data: heat },
  };
}

/** A | B | 热图 三联(RGB),中间 4 像素分隔;A、B 按各自原尺寸贴,热图按重叠区 */
export function triptych(a, b, heat) {
  const gap = 4;
  const h = Math.max(a.height, b.height, heat.height);
  const w = a.width + b.width + heat.width + gap * 2;
  const out = new Uint8Array(w * h * 3).fill(48);
  const blitRgba = (img, ox) => {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        const d = (y * w + ox + x) * 3;
        out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2];
      }
    }
  };
  blitRgba(a, 0);
  blitRgba(b, a.width + gap);
  const ox = a.width + b.width + gap * 2;
  for (let y = 0; y < heat.height; y++) {
    const s = y * heat.width * 3;
    const d = (y * w + ox) * 3;
    out.set(heat.data.subarray(s, s + heat.width * 3), d);
  }
  return { width: w, height: h, data: out };
}

/** RGB 盒式缩小(整数倍),给报告内嵌缩略图用 */
export function downscaleRgb(img, factor) {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return img;
  const w = Math.max(1, Math.floor(img.width / f));
  const h = Math.max(1, Math.floor(img.height / f));
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = 0; yy < f; yy++) {
        for (let xx = 0; xx < f; xx++) {
          const s = ((y * f + yy) * img.width + (x * f + xx)) * 3;
          r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2];
        }
      }
      const n = f * f;
      const d = (y * w + x) * 3;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
  }
  return { width: w, height: h, data: out };
}
