export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export function clampAlpha(value: number | undefined, fallback = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, value));
}

export function normalizeHexColor(input: string | undefined, fallback = "#000000") {
  const raw = (input ?? fallback).trim().replace("#", "");
  const safe = raw.length === 3
    ? raw.split("").map((part) => `${part}${part}`).join("")
    : raw.padEnd(6, "0").slice(0, 6);

  if (!/^[0-9a-fA-F]{6}$/.test(safe)) {
    return fallback;
  }

  return `#${safe.toUpperCase()}`;
}

export function hexToRgb(hex: string | undefined): RgbColor {
  const safe = normalizeHexColor(hex).replace("#", "");

  return {
    r: Number.parseInt(safe.slice(0, 2), 16),
    g: Number.parseInt(safe.slice(2, 4), 16),
    b: Number.parseInt(safe.slice(4, 6), 16)
  };
}

export function rgbToHex(color: RgbColor) {
  const toHex = (value: number) => Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

export function rgbaWithOpacity(hex: string | undefined, opacity: number, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  const resolvedOpacity = clampAlpha(opacity) * clampAlpha(alpha);

  return `rgba(${r}, ${g}, ${b}, ${resolvedOpacity.toFixed(3)})`;
}

export function formatAlphaPercent(alpha: number | undefined) {
  return Math.round(clampAlpha(alpha) * 100);
}

/** Linear interpolation between two hex colors (RGB space). */
export function mixHexColors(from: string, to: string, t: number) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const clamped = Math.min(1, Math.max(0, t));
  return rgbToHex({
    r: a.r + (b.r - a.r) * clamped,
    g: a.g + (b.g - a.g) * clamped,
    b: a.b + (b.b - a.b) * clamped
  });
}

/** HSL (h: 0-360, s/l: 0-1) to hex, used by the rainbow brush. */
export function hslToHex(h: number, s: number, l: number) {
  const hue = ((h % 360) + 360) % 360;
  const saturation = Math.min(1, Math.max(0, s));
  const lightness = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  const segment = Math.floor(hue / 60) % 6;
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]
  ];
  const [r, g, b] = table[segment];
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}
