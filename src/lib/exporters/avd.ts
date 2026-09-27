import { MotionData } from "./motion-data";
import { sanitizeName } from "./utils";
import { ExportArtifact } from "@/types/dot-motion";

// AnimatedVectorDrawable (AVD) export — one self-contained XML resource with
// inline <aapt:attr> animations, ready to drop into res/drawable/.
//
// Continuous editor animations are converted into a stepped frame sequence. Each
// dot's opacity (and scale, when animated) is driven by ONE objectAnimator per
// property spanning the full loop, with a staircase <pathInterpolator> that
// holds the exact per-frame value. This keeps the file compact, loops
// infinitely, and needs no per-frame animator sets.
//
// Dots whose color or shape changes across frames (sequence animations,
// per-cell overrides) are decomposed into one path per distinct visual, each
// with its own alpha staircase — exact, no cross-blending.
//
// Notes:
// - The objectAnimator interpolates valueFrom + (valueTo-valueFrom) * f(t), where
//   f comes from the staircase pathInterpolator. The path's y values may exceed
//   [0,1] (pathInterpolator supports overshoot), which lets the first and last
//   frame values coincide while the middle frames still hold exact values.
// - Glow is not representable in plain VectorDrawable and is omitted.

type Scene = MotionData["scenes"][number];
type Cell = Scene["cells"][number];

const EPS = 1e-4;
const fmt = (n: number) => {
  const v = Number(n.toFixed(4));
  return Object.is(v, -0) ? "0" : String(v);
};

function hexColor(color: number[]) {
  const r = Math.round(color[0] * 255);
  const g = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).toUpperCase().padStart(6, "0")}`;
}

/** Path data for one cell shape inside a 1x1 local box, optionally translated. */
function shapePathData(cell: Cell, dx: number, dy: number): string {
  if (cell.polygon.length > 0) {
    const commands: string[] = [];
    for (let i = 0; i < cell.polygon.length; i += 2) {
      const x = fmt(cell.polygon[i] + dx);
      const y = fmt(cell.polygon[i + 1] + dy);
      commands.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
    }
    return `${commands.join(" ")} Z`;
  }
  if (cell.radius >= 0.5 - EPS) {
    return `M${fmt(0.5 + dx)},${fmt(dy)} a0.5,0.5 0 1 1 0,1 a0.5,0.5 0 1 1 0,-1 Z`;
  }
  if (cell.radius > EPS) {
    const r = cell.radius;
    return [
      `M${fmt(r + dx)},${fmt(dy)}`,
      `H${fmt(1 - r + dx)}`,
      `A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(1 + dx)},${fmt(r + dy)}`,
      `V${fmt(1 - r + dy)}`,
      `A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(1 - r + dx)},${fmt(1 + dy)}`,
      `H${fmt(r + dx)}`,
      `A${fmt(r)},${fmt(r)} 0 0 0 ${fmt(dx)},${fmt(1 - r + dy)}`,
      `V${fmt(r + dy)}`,
      `A${fmt(r)},${fmt(r)} 0 0 0 ${fmt(r + dx)},${fmt(dy)}`,
      "Z"
    ].join(" ");
  }
  return `M${fmt(dx)},${fmt(dy)} h1 v1 h-1 Z`;
}

const isConstant = (values: number[]) => values.every((value) => Math.abs(value - values[0]) < EPS);

/**
 * Interpolation span for a value sequence: normally last-first. When the first
 * and last values coincide, an artificial nonzero span is chosen so the
 * animator still has a value range; the staircase compensates exactly.
 */
function computeSpan(values: number[]): number {
  const first = values[0];
  const last = values[values.length - 1];
  const natural = last - first;
  if (Math.abs(natural) >= EPS) {
    return natural;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(max - min, EPS);
  return max - first >= first - min ? range : -range;
}

/** Staircase pathInterpolator data holding v[k] during [k/N, (k+1)/N). */
function staircasePathData(values: number[], frameCount: number): string {
  const first = values[0];
  const last = values[values.length - 1];
  const span = computeSpan(values);
  const y = (value: number) => (value - first) / span;
  const delta = 0.05 / frameCount;

  const points: string[] = ["M0,0"];
  for (let k = 1; k < frameCount; k += 1) {
    points.push(`L${fmt(Math.max(0, k / frameCount - delta))},${fmt(y(values[k - 1]))}`);
    points.push(`L${fmt(k / frameCount)},${fmt(y(values[k]))}`);
  }
  points.push(`L1,${fmt(y(last))}`);
  return points.join(" ");
}

function staircaseAnimator(
  name: string,
  property: string,
  values: number[],
  frameCount: number,
  durationMs: number,
  loop: boolean
): string {
  const first = values[0];
  const valueTo = first + computeSpan(values);
  const repeat = loop ? ' android:repeatCount="infinite"' : "";
  return [
    `      <target android:name="${name}">`,
    `        <aapt:attr name="android:animation">`,
    `          <objectAnimator`,
    `            android:propertyName="${property}"`,
    `            android:duration="${Math.max(1, Math.round(durationMs))}"${repeat}`,
    `            android:valueFrom="${fmt(first)}"`,
    `            android:valueTo="${fmt(valueTo)}">`,
    `            <aapt:attr name="android:interpolator">`,
    `              <pathInterpolator xmlns:android="http://schemas.android.com/apk/res/android"`,
    `                android:pathData="${staircasePathData(values, frameCount)}"/>`,
    `            </aapt:attr>`,
    `          </objectAnimator>`,
    `        </aapt:attr>`,
    `      </target>`
  ].join("\n");
}

/** Interpolated sample from one cell's sample track. */
function sampleCell(cell: Cell, phase: number): [number, number, number] {
  const samples = cell.samples;
  const position = phase * (samples.length - 1);
  const index = Math.min(samples.length - 2, Math.floor(position));
  const mix = position - index;
  const a = samples[index];
  const b = samples[Math.min(samples.length - 1, index + 1)];
  return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
}

/** One visual variant of one cell across the whole loop. */
type CellVisualTrack = {
  alphas: number[];
  scales: number[];
  backgrounds: number[];
  cell: Cell;
};

function visualKey(cell: Cell) {
  return `${hexColor(cell.color)}|${cell.polygon.join(",")}|${cell.radius}`;
}

function collectCellTracks(data: MotionData, frameCount: number): CellVisualTrack[][] {
  const scenes = data.scenes;
  const cellCount = scenes[0]?.cells.length ?? 0;
  const result: CellVisualTrack[][] = [];

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    // Discover distinct visuals (color/shape) across frames — usually one.
    const keys: string[] = [];
    const cellsByKey = new Map<string, Cell>();
    for (let frame = 0; frame < frameCount; frame += 1) {
      const globalPhase = frame / frameCount;
      const scene = data.discrete
        ? scenes[Math.min(scenes.length - 1, Math.floor(globalPhase * scenes.length))]
        : scenes[0];
      const cell = scene.cells[cellIndex];
      const key = visualKey(cell);
      if (!cellsByKey.has(key)) {
        cellsByKey.set(key, cell);
        keys.push(key);
      }
    }

    const tracks: CellVisualTrack[] = keys.map((key) => {
      const alphas: number[] = [];
      const scales: number[] = [];
      const backgrounds: number[] = [];
      for (let frame = 0; frame < frameCount; frame += 1) {
        const globalPhase = frame / frameCount;
        const scene = data.discrete
          ? scenes[Math.min(scenes.length - 1, Math.floor(globalPhase * scenes.length))]
          : scenes[0];
        const cell = scene.cells[cellIndex];
        const v = sampleCell(cell, globalPhase);
        const isActiveVisual = visualKey(cell) === key;
        // Discrete sequences switch frames hard; opacity samples are constant 1
        // so the active flag provides the alpha. Continuous animations only
        // overlay ACTIVE cells (inactive cells keep their background layer),
        // mirroring the Web and SVG exporters. Background keeps its phase.
        const alpha = (cell.active && isActiveVisual ? (data.discrete ? 1 : v[0]) : 0) * cell.color[3];
        alphas.push(Math.max(0, Math.min(1, alpha)));
        scales.push(data.discrete ? 1 : Math.max(0, Math.min(1.3, v[1])));
        backgrounds.push(Math.max(0, Math.min(1, v[2] * scene.background[3])));
      }
      return { alphas, scales, backgrounds, cell: cellsByKey.get(key) as Cell };
    });

    result.push(tracks);
  }

  return result;
}

export function exportAvd(data: MotionData, name: string): ExportArtifact {
  const scene0 = data.scenes[0];
  if (!scene0) {
    throw new Error("no scenes to export");
  }

  const totalCells = scene0.cells.length;
  const frameCount = data.discrete
    ? data.scenes.length
    : totalCells <= 36 ? 24 : totalCells <= 64 ? 20 : totalCells <= 121 ? 14 : totalCells <= 196 ? 10 : 8;
  const durationMs = data.duration * 1000;

  const tracks = collectCellTracks(data, frameCount);
  const unit = scene0.cellSize > 0 ? scene0.cellSize : 1;
  const toUnit = (value: number) => value / unit;

  const paths: string[] = [];
  const targets: string[] = [];
  let nameCounter = 0;

  const bgAnimated = totalCells <= 196 && tracks.some((cellTracks) => cellTracks.some((track) => !isConstant(track.backgrounds)));
  const scaleAnimated = totalCells <= 196 && tracks.some((cellTracks) => cellTracks.some((track) => !isConstant(track.scales)));

  // Background layer: one path per cell position (uses the first scene's shape).
  for (let cellIndex = 0; cellIndex < scene0.cells.length; cellIndex += 1) {
    const cell = scene0.cells[cellIndex];
    const x = toUnit(cell.x);
    const y = toUnit(cell.y);
    const track = tracks[cellIndex][0];
    const fill = hexColor(scene0.background);
    const pathName = `b${cellIndex}`;

    if (!bgAnimated || isConstant(track.backgrounds)) {
      const alpha = track.backgrounds[0] ?? scene0.background[3];
      if (alpha > EPS) {
        paths.push(
          `      <path android:name="${pathName}" android:fillColor="${fill}" android:fillAlpha="${fmt(alpha)}" android:pathData="${shapePathData(cell, x, y)}"/>`
        );
      }
    } else {
      paths.push(
        `      <path android:name="${pathName}" android:fillColor="${fill}" android:fillAlpha="${fmt(track.backgrounds[0])}" android:pathData="${shapePathData(cell, x, y)}"/>`
      );
      targets.push(staircaseAnimator(pathName, "fillAlpha", track.backgrounds, frameCount, durationMs, data.loop));
    }
  }

  // Active overlay: one path (and optional scale group) per (cell, visual).
  for (let cellIndex = 0; cellIndex < scene0.cells.length; cellIndex += 1) {
    const cellTracks = tracks[cellIndex];
    const cell0 = scene0.cells[cellIndex];
    const x = toUnit(cell0.x);
    const y = toUnit(cell0.y);

    for (const track of cellTracks) {
      if (track.alphas.every((value) => value < EPS)) {
        continue;
      }

      const pathName = `p${nameCounter}`;
      const groupName = `g${nameCounter}`;
      nameCounter += 1;
      const color = hexColor(track.cell.color);
      const alphaConstant = isConstant(track.alphas);
      const scaleTrack = scaleAnimated && !isConstant(track.scales) ? track.scales : null;

      const pathAttrs = `android:name="${pathName}" android:fillColor="${color}" android:fillAlpha="${fmt(track.alphas[0])}" android:pathData="${shapePathData(track.cell, scaleTrack ? 0 : x, scaleTrack ? 0 : y)}"`;

      if (alphaConstant && track.alphas[0] < EPS) {
        continue;
      }

      if (scaleTrack) {
        paths.push(
          `      <group android:name="${groupName}" android:translateX="${fmt(x)}" android:translateY="${fmt(y)}" android:pivotX="0.5" android:pivotY="0.5">\n        <path ${pathAttrs}/>\n      </group>`
        );
        targets.push(staircaseAnimator(groupName, "scaleX", track.scales, frameCount, durationMs, data.loop));
        targets.push(staircaseAnimator(groupName, "scaleY", track.scales, frameCount, durationMs, data.loop));
      } else {
        paths.push(`      <path ${pathAttrs}/>`);
      }

      if (!alphaConstant) {
        targets.push(staircaseAnimator(pathName, "fillAlpha", track.alphas, frameCount, durationMs, data.loop));
      }
    }
  }

  const viewportWidth = Math.max(1, Number((scene0.width / unit).toFixed(3)));
  const viewportHeight = Math.max(1, Number((scene0.height / unit).toFixed(3)));
  const dpWidth = Math.max(8, Math.round(viewportWidth * 6));
  const dpHeight = Math.max(8, Math.round(viewportHeight * 6));

  const content = `<?xml version="1.0" encoding="utf-8"?>
<!-- ${sanitizeName(name)} · generated by dot-motion-builder (${frameCount} frames / ${Math.round(durationMs)}ms loop${data.loop ? "" : ", no loop"}) -->
<animated-vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="${dpWidth}dp"
    android:height="${dpHeight}dp">
  <aapt:attr name="android:drawable">
    <vector
        android:width="${dpWidth}dp"
        android:height="${dpHeight}dp"
        android:viewportWidth="${fmt(viewportWidth)}"
        android:viewportHeight="${fmt(viewportHeight)}">
${paths.join("\n")}
    </vector>
  </aapt:attr>
${targets.join("\n")}
</animated-vector>
`;

  return {
    format: "avd",
    filename: `${sanitizeName(name)}.xml`,
    mimeType: "application/xml;charset=utf-8",
    content
  };
}
