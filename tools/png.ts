import { deflateSync, inflateSync } from "node:zlib";
import { frameRgb, type Frame } from "@sci-ts/sci";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes an indexed frame as an RGB PNG, optionally scaled up (with 4:3 aspect correction). */
export function framePng(frame: Frame, scale = 2): Buffer {
  const w = frame.width * scale, h = Math.round(frame.height * scale * 1.2);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const rgb = frameRgb(frame);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(frame.height - 1, Math.floor(y / (scale * 1.2)));
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = (sy * frame.width + Math.floor(x / scale)) * 3;
      raw.set(rgb.subarray(i, i + 3), y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

/** An RGBA image. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array; // width * height * 4
}

/** Encodes RGBA pixels as a PNG, 1:1. */
export function rgbaPng(img: Rgba): Buffer {
  const { width: w, height: h } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(img.data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/**
 * Decodes an 8-bit, non-interlaced PNG (greyscale, RGB, palette, grey+alpha or RGBA) to RGBA.
 * Enough for art made in any paint program.
 */
export function decodePng(file: Uint8Array): Rgba {
  const b = Buffer.from(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let plte: Uint8Array | undefined, trns: Uint8Array | undefined;
  const idat: Buffer[] = [];
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p), kind = b.toString("ascii", p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") [width, height, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8]!, data[9]!, data[12]!];
    else if (kind === "PLTE") plte = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`Only 8-bit non-interlaced PNGs are supported (bit depth ${depth}, interlace ${interlace})`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels) throw new Error(`Unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels]! : 0;
      const up = y ? px[(y - 1) * stride + x]! : 0;
      const c = y && x >= channels ? px[(y - 1) * stride + x - channels]! : 0;
      const pred = filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >> 1 : filter === 4 ? paeth(a, up, c) : 0;
      px[y * stride + x] = (src[x]! + pred) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, i * channels + channels);
    let r: number, g: number, bl: number, al = 255;
    if (type === 3) {
      const k = s[0]!;
      [r, g, bl] = [plte![k * 3]!, plte![k * 3 + 1]!, plte![k * 3 + 2]!];
      al = trns && k < trns.length ? trns[k]! : 255;
    } else if (type === 0 || type === 4) {
      r = g = bl = s[0]!;
      if (type === 4) al = s[1]!;
    } else {
      [r, g, bl] = [s[0]!, s[1]!, s[2]!];
      if (type === 6) al = s[3]!;
    }
    data.set([r, g, bl, al], i * 4);
  }
  return { width, height, data };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
