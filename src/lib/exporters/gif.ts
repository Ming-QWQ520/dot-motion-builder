import { MotionData } from "./motion-data";
import { sanitizeName } from "./utils";

// Self-contained GIF89a encoder: palette quantization, LZW compression, and
// frame timing are implemented from scratch so the editor has zero runtime
// dependencies beyond the browser itself. The rasterizer mirrors the Web
// exporter (inactive base + animated overlay per cell, per-cell colors and
// shapes), so a GIF matches what the canvas preview shows.

export type GifOptions = {
  /** Rendered size of one grid cell in output pixels. */
  cellPx?: number;
  /** Reserve one palette slot as fully transparent instead of compositing over the background color. */
  transparent?: boolean;
};

export type RasterFrame = {
  width: number;
  height: number;
  /** Palette index per pixel (row-major). */
  indices: Uint8Array;
};

export type GifExportResult = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  frameCount: number;
  width: number;
  height: number;
  colorCount: number;
  delayMs: number;
};

// ---------------------------------------------------------------------------
// LZW compressor (classic GIF variant, LSB-first bit packing)
// ---------------------------------------------------------------------------

class LzwWriter {
  private out: number[] = [];
  private curAccum = 0;
  private curBits = 0;
  private nBits: number;
  private maxcode: number;
  private freeEnt: number;
  private clearFlag = false;
  private readonly clearCode: number;
  private readonly eoiCode: number;
  private readonly maxbits = 12;
  private htab = new Map<number, number>();

  constructor(private readonly minCodeSize: number) {
    this.clearCode = 1 << minCodeSize;
    this.eoiCode = this.clearCode + 1;
    this.nBits = minCodeSize + 1;
    this.maxcode = (1 << this.nBits) - 1;
    this.freeEnt = this.clearCode + 2;
  }

  private emit(code: number) {
    this.curAccum |= code << this.curBits;
    this.curBits += this.nBits;
    while (this.curBits >= 8) {
      this.out.push(this.curAccum & 0xff);
      this.curAccum >>>= 8;
      this.curBits -= 8;
    }

    // Deferred code-size growth, matching the classic encoders decoders sync to.
    if (this.freeEnt > this.maxcode || this.clearFlag) {
      if (this.clearFlag) {
        this.nBits = this.minCodeSize + 1;
        this.maxcode = (1 << this.nBits) - 1;
        this.clearFlag = false;
      } else {
        this.nBits += 1;
        this.maxcode = this.nBits === this.maxbits ? (1 << this.maxbits) : (1 << this.nBits) - 1;
      }
    }
  }

  private resetTable() {
    this.htab.clear();
    this.freeEnt = this.clearCode + 2;
    this.clearFlag = true;
    this.emit(this.clearCode);
  }

  encode(indices: Uint8Array): number[] {
    this.emit(this.clearCode);
    let prefix = -1;
    for (let i = 0; i < indices.length; i += 1) {
      const k = indices[i];
      if (prefix < 0) {
        prefix = k;
        continue;
      }
      const key = (prefix << 8) | k;
      const found = this.htab.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      this.emit(prefix);
      prefix = k;
      if (this.freeEnt < (1 << this.maxbits)) {
        this.htab.set(key, this.freeEnt);
        this.freeEnt += 1;
      } else {
        this.resetTable();
      }
    }
    if (prefix >= 0) {
      this.emit(prefix);
    }
    this.emit(this.eoiCode);
    if (this.curBits > 0) {
      this.out.push(this.curAccum & 0xff);
    }
    return this.out;
  }
}

// ---------------------------------------------------------------------------
// GIF byte stream
// ---------------------------------------------------------------------------

class ByteStream {
  private chunks: number[] = [];
  byte(value: number) {
    this.chunks.push(value & 0xff);
  }
  short(value: number) {
    this.chunks.push(value & 0xff, (value >> 8) & 0xff);
  }
  ascii(value: string) {
    for (let i = 0; i < value.length; i += 1) {
      this.chunks.push(value.charCodeAt(i));
    }
  }
  bytes(values: number[] | Uint8Array) {
    for (let i = 0; i < values.length; i += 1) {
      this.chunks.push(values[i] & 0xff);
    }
  }
  subBlocks(data: number[] | Uint8Array) {
    for (let offset = 0; offset < data.length; offset += 255) {
      const size = Math.min(255, data.length - offset);
      this.chunks.push(size);
      for (let i = 0; i < size; i += 1) {
        this.chunks.push(data[offset + i] & 0xff);
      }
    }
    this.chunks.push(0);
  }
  toUint8Array() {
    return new Uint8Array(this.chunks);
  }
}

function globalColorTableSize(paletteLength: number) {
  let bits = 1; // 2^1 = 2 entries minimum
  while (1 << bits < paletteLength && bits < 8) {
    bits += 1;
  }
  return 1 << bits;
}

/**
 * Encode indexed frames into a GIF89a byte stream. Pure function — safe to run
 * in Node for tests.
 */
export function encodeGifFrames(
  frames: RasterFrame[],
  palette: number[][],
  delaysMs: number[],
  options: { loop?: boolean; transparentIndex?: number } = {}
): Uint8Array {
  const stream = new ByteStream();
  const loop = options.loop !== false;
  const transparentIndex = options.transparentIndex ?? -1;

  stream.ascii("GIF89a");

  const width = frames[0]?.width ?? 1;
  const height = frames[0]?.height ?? 1;
  const tableEntries = globalColorTableSize(Math.max(palette.length, 2));
  const sizeBits = Math.log2(tableEntries) - 1;

  stream.short(width);
  stream.short(height);
  // Global color table flag | color resolution (7) | sort (0) | size bits.
  stream.byte(0x80 | 0x70 | sizeBits);
  stream.byte(0); // background color index
  stream.byte(0); // pixel aspect ratio

  for (let i = 0; i < tableEntries; i += 1) {
    const color = palette[i] ?? [0, 0, 0];
    stream.bytes(color);
  }

  if (loop) {
    // NETSCAPE2.0 application extension: loop forever.
    stream.byte(0x21);
    stream.byte(0xff);
    stream.byte(0x0b);
    stream.ascii("NETSCAPE2.0");
    stream.byte(3);
    stream.byte(1);
    stream.short(0); // loop forever
    stream.byte(0);
  }

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const delayCs = Math.max(2, Math.round((delaysMs[index] ?? 100) / 10));

    stream.byte(0x21);
    stream.byte(0xf9);
    stream.byte(4);
    // Disposal 2 (restore to background) when transparent, else 1 (keep).
    const disposal = transparentIndex >= 0 ? 2 : 1;
    const packed = (disposal << 2) | (transparentIndex >= 0 ? 1 : 0);
    stream.byte(packed);
    stream.short(delayCs);
    stream.byte(Math.max(0, transparentIndex));
    stream.byte(0);

    stream.byte(0x2c);
    stream.short(0);
    stream.short(0);
    stream.short(frame.width);
    stream.short(frame.height);
    stream.byte(0); // no local color table

    const minCodeSize = Math.max(2, Math.ceil(Math.log2(Math.max(2, tableEntries))));
    stream.byte(minCodeSize);
    const lzw = new LzwWriter(minCodeSize);
    stream.subBlocks(lzw.encode(frame.indices));
  }

  stream.byte(0x3b); // trailer
  return stream.toUint8Array();
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function buildPalette(framesPixels: Uint8ClampedArray[], transparent: boolean) {
  const counts = new Map<number, number>();
  for (const pixels of framesPixels) {
    for (let i = 0; i < pixels.length; i += 4) {
      if (transparent && pixels[i + 3] < 128) {
        continue;
      }
      const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const transparentIndex = transparent ? 0 : -1;
  const capacity = 256 - (transparent ? 1 : 0);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const palette: number[][] = transparent ? [[0, 0, 0]] : [];
  const map = new Map<number, number>();
  let overflow: Array<[number, number]> = [];

  for (const [key] of entries) {
    if (palette.length < capacity) {
      map.set(key, palette.length);
      palette.push([(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff]);
    } else {
      overflow.push([key, 0]);
    }
  }

  // Quantize overflow colors to the nearest kept palette entry.
  for (const [key] of overflow) {
    const r = (key >> 16) & 0xff;
    const g = (key >> 8) & 0xff;
    const b = key & 0xff;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = transparent ? 1 : 0; i < palette.length; i += 1) {
      const dr = palette[i][0] - r;
      const dg = palette[i][1] - g;
      const db = palette[i][2] - b;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    map.set(key, best);
  }

  return { palette, map, transparentIndex, distinctColors: counts.size };
}

// ---------------------------------------------------------------------------
// Canvas rasterizer (browser only)
// ---------------------------------------------------------------------------

function drawCellShape(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  polygon: number[],
  radius: number,
  cellSize: number
) {
  ctx.beginPath();
  if (polygon.length > 0) {
    for (let i = 0; i < polygon.length; i += 2) {
      const px = x + polygon[i] * size;
      const py = y + polygon[i + 1] * size;
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
  } else {
    const r = Math.min(size / 2, (radius / cellSize) * size);
    ctx.roundRect(x, y, size, size, r);
  }
}

function sampleAt(samples: number[][], phase: number) {
  const position = phase * (samples.length - 1);
  const index = Math.min(samples.length - 2, Math.floor(position));
  const mix = position - index;
  const a = samples[index];
  const b = samples[Math.min(samples.length - 1, index + 1)];
  return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
}

/** Rasterize the shared motion data into an animated GIF. Browser only. */
export function renderMotionGif(data: MotionData, name: string, options: GifOptions = {}): GifExportResult {
  const cellPx = Math.min(24, Math.max(2, Math.round(options.cellPx ?? 8)));
  const transparent = options.transparent ?? false;
  const scene0 = data.scenes[0];
  if (!scene0) {
    throw new Error("no scenes to export");
  }

  const scale = cellPx / scene0.cellSize;
  const width = Math.max(1, Math.round(data.width * scale));
  const height = Math.max(1, Math.round(data.height * scale));
  const totalCells = scene0.cells.length;
  const frameCap = totalCells > 120 ? 30 : 60;
  const frameCount = data.discrete
    ? data.scenes.length
    : Math.min(frameCap, Math.max(10, Math.round(data.duration * 24)));
  const delayMs = (data.duration * 1000) / frameCount;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("canvas unavailable");
  }

  const pixelsPerFrame: Uint8ClampedArray[] = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const phase = frame / frameCount;
    const scene = data.discrete
      ? data.scenes[Math.min(data.scenes.length - 1, Math.floor(phase * data.scenes.length))]
      : scene0;
    const scenePhase = data.discrete ? phase * data.scenes.length - Math.floor(phase * data.scenes.length) : phase;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!transparent) {
      ctx.fillStyle = `rgb(${Math.round(scene.background[0] * 255)},${Math.round(scene.background[1] * 255)},${Math.round(scene.background[2] * 255)})`;
      ctx.fillRect(0, 0, width, height);
    }
    const offsetX = (data.width - scene.width) / 2;
    const offsetY = (data.height - scene.height) / 2;
    ctx.translate((offsetX + 0.5) * scale, (offsetY + 0.5) * scale);
    ctx.scale(scale, scale);

    for (const cell of scene.cells) {
      const v = sampleAt(cell.samples, scenePhase);
      // Inactive base layer.
      if (v[2] > 0.004) {
        ctx.globalAlpha = v[2];
        drawCellShape(ctx, cell.x, cell.y, scene.cellSize, cell.polygon, cell.radius, scene.cellSize);
        ctx.fillStyle = `rgb(${Math.round(scene.background[0] * 255)},${Math.round(scene.background[1] * 255)},${Math.round(scene.background[2] * 255)})`;
        ctx.fill();
      }
      // Active overlay (per-cell color, glow, animated scale).
      if (cell.active && v[0] > 0.004 && v[1] > 0) {
        const size = scene.cellSize * v[1];
        const inset = (scene.cellSize - size) / 2;
        ctx.globalAlpha = v[0];
        if (scene.glow > 0) {
          ctx.shadowColor = `rgba(${Math.round(cell.color[0] * 255)},${Math.round(cell.color[1] * 255)},${Math.round(cell.color[2] * 255)},${cell.color[3]})`;
          ctx.shadowBlur = scene.glow * scale;
        }
        drawCellShape(ctx, cell.x + inset, cell.y + inset, size, cell.polygon, cell.radius, scene.cellSize);
        ctx.fillStyle = `rgb(${Math.round(cell.color[0] * 255)},${Math.round(cell.color[1] * 255)},${Math.round(cell.color[2] * 255)})`;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalAlpha = 1;

    if (scene.label) {
      ctx.fillStyle = `rgb(${Math.round(scene.textColor[0] * 255)},${Math.round(scene.textColor[1] * 255)},${Math.round(scene.textColor[2] * 255)})`;
      ctx.font = `${scene.fontWeight} ${scene.fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(scene.label, scene.width / 2, scene.labelY);
    }

    pixelsPerFrame.push(ctx.getImageData(0, 0, width, height).data);
  }

  const { palette, map, transparentIndex, distinctColors } = buildPalette(pixelsPerFrame, transparent);

  const frames: RasterFrame[] = pixelsPerFrame.map((pixels) => {
    const indices = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < indices.length; i += 1, p += 4) {
      if (transparentIndex >= 0 && pixels[p + 3] < 128) {
        indices[i] = transparentIndex;
        continue;
      }
      const key = (pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2];
      indices[i] = map.get(key) ?? 0;
    }
    return { width, height, indices };
  });

  const bytes = encodeGifFrames(
    frames,
    palette,
    Array.from({ length: frames.length }, () => delayMs),
    { loop: data.loop, transparentIndex }
  );

  return {
    bytes,
    filename: `${sanitizeName(name)}.gif`,
    mimeType: "image/gif",
    frameCount,
    width,
    height,
    colorCount: distinctColors,
    delayMs
  };
}
