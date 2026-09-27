import { MotionData } from "./motion-data";
import { sanitizeName } from "./utils";
import { ExportArtifact } from "@/types/dot-motion";

// Self-contained SVG export. The animation is expressed with CSS keyframes
// embedded in a <style> element, so the file animates when inlined, opened
// directly, or referenced via <img>/<object> — no JavaScript required.
//
// Rendering mirrors the Web exporter: an inactive-color base cell under every
// grid position, plus an active-color overlay on selected cells whose opacity
// and scale follow the shared deterministic samples. Sequence exports switch
// frame groups with step-end timing while inactive-cell effects stay
// continuous, matching the Web and SwiftUI runtimes.

const KEYFRAME_STEPS = 20;
const TOLERANCE = 0.004;

type Scene = MotionData["scenes"][number];
type Cell = Scene["cells"][number];

const fmt = (n: number) => {
  const v = Number(n.toFixed(3));
  return Object.is(v, -0) ? "0" : String(v);
};

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rgb(color: number[]) {
  return `rgb(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)})`;
}

/** Downsample one sampled track to at most KEYFRAME_STEPS + 1 values. */
function track(samples: number[][], pick: (sample: number[]) => number): number[] {
  const values = samples.map(pick);
  if (values.length <= 1) return values.length ? values : [0];
  const stride = Math.max(1, Math.ceil((values.length - 1) / KEYFRAME_STEPS));
  const picked: number[] = [];
  for (let index = 0; index < values.length; index += stride) picked.push(values[index]);
  if (picked[picked.length - 1] !== values[values.length - 1]) picked.push(values[values.length - 1]);
  return picked;
}

const isConstant = (values: number[]) => values.every((value) => Math.abs(value - values[0]) < TOLERANCE);

/** Deduplicating keyframes registry: identical tracks share one rule. */
class KeyframeBag {
  private rules = new Map<string, string>();
  private counter = 0;

  add(opacity: number[], scale: number[] | null): string {
    const signature = `${opacity.map(fmt).join(",")}|${scale ? scale.map(fmt).join(",") : ""}`;
    const existing = this.rules.get(signature);
    if (existing) return existing;

    const name = `a${this.counter++}`;
    const frames = opacity.map((value, index) => {
      const pct = fmt((index / (opacity.length - 1)) * 100);
      const props = [`opacity:${fmt(value)}`];
      if (scale) props.push(`transform:scale(${fmt(scale[index])})`);
      return `${pct}%{${props.join(";")}}`;
    });
    this.rules.set(signature, `@keyframes ${name}{${frames.join("")}}`);
    return name;
  }

  get css() {
    return Array.from(this.rules.values()).join("");
  }
}

/** Cell shape as an SVG element; scale transforms stay on the caller. */
function cellElement(scene: Scene, cell: Cell, attrs: string): string {
  const size = scene.cellSize;
  if (cell.polygon.length > 0) {
    const points: string[] = [];
    for (let index = 0; index < cell.polygon.length; index += 2) {
      points.push(`${fmt(cell.polygon[index] * size)},${fmt(cell.polygon[index + 1] * size)}`);
    }
    return `<polygon points="${points.join(" ")}" ${attrs}/>`;
  }
  if (cell.radius * 2 >= size - TOLERANCE) {
    const r = fmt(size / 2);
    return `<circle cx="${r}" cy="${r}" r="${r}" ${attrs}/>`;
  }
  return `<rect width="${fmt(size)}" height="${fmt(size)}" rx="${fmt(cell.radius)}" ${attrs}/>`;
}

/** Hard-cut frame switching for sequence exports. */
function frameSwitchRule(index: number, count: number): string {
  const start = (index / count) * 100;
  const end = ((index + 1) / count) * 100;
  const frames: string[] = [];
  if (index === 0) {
    frames.push("0%{opacity:1}");
  } else {
    frames.push("0%{opacity:0}", `${fmt(start)}%{opacity:1}`);
  }
  frames.push(index === count - 1 ? "100%{opacity:1}" : `${fmt(end)}%{opacity:0}`);
  return `@keyframes f${index}{${frames.join("")}}`;
}

function renderScene(scene: Scene, offsetX: number, offsetY: number, bag: KeyframeBag): string {
  const baseFill = `fill="${rgb(scene.background)}" fill-opacity="${fmt(scene.background[3])}"`;
  const bases: string[] = [];
  const overlays: string[] = [];

  for (const cell of scene.cells) {
    const wrapper = `translate(${fmt(cell.x + offsetX)},${fmt(cell.y + offsetY)})`;

    // Inactive-color base under every cell.
    const background = track(cell.samples, (sample) => sample[2]);
    if (isConstant(background)) {
      if (background[0] >= TOLERANCE) {
        const attrs = [baseFill];
        if (Math.abs(background[0] - 1) >= TOLERANCE) attrs.push(`opacity="${fmt(background[0])}"`);
        bases.push(`<g transform="${wrapper}">${cellElement(scene, cell, attrs.join(" "))}</g>`);
      }
    } else {
      bases.push(
        `<g transform="${wrapper}">${cellElement(scene, cell, `${baseFill} class="a" style="animation-name:${bag.add(background, null)}"`)}</g>`
      );
    }

    // Active-color overlay on selected cells (per-cell resolved color).
    if (!cell.active) continue;
    const activeFill = `fill="${rgb(cell.color)}" fill-opacity="${fmt(cell.color[3])}"`;
    const opacity = track(cell.samples, (sample) => sample[0]);
    const scale = track(cell.samples, (sample) => sample[1]);
    const opacityStatic = isConstant(opacity);
    const scaleStatic = isConstant(scale) && Math.abs(scale[0] - 1) < TOLERANCE;

    if (opacityStatic && scaleStatic) {
      if (opacity[0] < TOLERANCE) continue;
      const attrs = [activeFill];
      if (Math.abs(opacity[0] - 1) >= TOLERANCE) attrs.push(`opacity="${fmt(opacity[0])}"`);
      overlays.push(`<g transform="${wrapper}">${cellElement(scene, cell, attrs.join(" "))}</g>`);
      continue;
    }
    if (opacityStatic && opacity[0] < TOLERANCE) continue;

    const scaleTrack = isConstant(scale) && Math.abs(scale[0] - 1) < TOLERANCE ? null : scale;
    overlays.push(
      `<g transform="${wrapper}">${cellElement(scene, cell, `${activeFill} class="a" style="animation-name:${bag.add(opacity, scaleTrack)}"`)}</g>`
    );
  }

  const glowGroup = scene.glow > 0 ? `<g filter="url(#glow)">` : "<g>";
  const label = scene.label
    ? `<text x="${fmt(scene.width / 2)}" y="${fmt(scene.labelY)}" text-anchor="middle" dominant-baseline="text-before-edge" font-family="system-ui,sans-serif" font-size="${fmt(scene.fontSize)}" font-weight="${scene.fontWeight}" letter-spacing="${fmt(scene.letterSpacing * scene.fontSize)}" fill="${rgb(scene.textColor)}">${escapeXml(scene.label)}</text>`
    : "";

  return `<g transform="translate(${fmt(offsetX)},${fmt(offsetY)})"><g>${bases.join("")}</g>${glowGroup}${overlays.join("")}</g>${label}`;
}

export function exportSvg(data: MotionData, name: string): ExportArtifact {
  const bag = new KeyframeBag();
  const sceneCount = data.scenes.length;
  const discrete = data.discrete && sceneCount > 1;
  const duration = Math.max(0.01, data.duration);

  const body = data.scenes
    .map((scene, index) => {
      const offsetX = (data.width - scene.width) / 2;
      const offsetY = (data.height - scene.height) / 2;
      const markup = renderScene(scene, offsetX, offsetY, bag);
      if (!discrete) return markup;
      const attrs = [
        `class="f"`,
        `style="animation-name:f${index}"`,
        ...(index > 0 ? [`opacity="0"`] : [])
      ];
      return `<g ${attrs.join(" ")}>${markup}</g>`;
    })
    .join("");

  const frameRules = discrete
    ? data.scenes.map((_, index) => frameSwitchRule(index, sceneCount)).join("")
    : "";

  const style = [
    `.a,.f{animation-duration:${fmt(duration)}s;animation-iteration-count:${data.loop ? "infinite" : "1"};animation-fill-mode:both}`,
    `.a{animation-timing-function:linear;transform-box:fill-box;transform-origin:50% 50%}`,
    `.f{animation-timing-function:step-end}`,
    "@media (prefers-reduced-motion:reduce){.a,.f{animation:none}.f~.f{visibility:hidden}}",
    bag.css,
    frameRules
  ].join("");

  const height = (48 * data.height) / Math.max(1, data.width);
  const glow = Math.max(...data.scenes.map((scene) => scene.glow));
  const defs = glow > 0
    ? `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${fmt(glow / 2)}" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`
    : "";

  const content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(data.width)} ${fmt(data.height)}" width="48" height="${fmt(height)}" role="img" aria-label="${escapeXml(name)}"><title>${escapeXml(name)}</title>${defs}<style>${style}</style>${body}</svg>`;

  return {
    format: "svg",
    filename: `${sanitizeName(name)}.svg`,
    mimeType: "image/svg+xml;charset=utf-8",
    content
  };
}
