import { CellShape, CellStyleOverride, LoaderComponent } from "@/types/dot-motion";

export const shapeOptions = [
  { value: "rectangle" },
  { value: "square" },
  { value: "circle" },
  { value: "diamond" },
  { value: "hexagon" },
  { value: "star" },
  { value: "triangle" },
  { value: "heart" }
] as const satisfies ReadonlyArray<{ value: CellShape }>;

export function isValidCellShape(value: unknown): value is CellShape {
  return value === "rectangle" || value === "triangle" || value === "star" ||
    value === "diamond" || value === "hexagon" || value === "heart" ||
    value === "square" || value === "rounded-rect" || value === "circle" || value === "pill";
}

export function normalizeCellShape(value: unknown): CellShape {
  return isValidCellShape(value) ? value : "rectangle";
}

function formatPoint(value: number) {
  return `${Number(value.toFixed(2))}%`;
}

function buildStarPolygon(innerRadius = 0.48) {
  const points: string[] = [];
  const center = 50;
  const outer = 47;
  const inner = Math.max(18, Math.min(38, innerRadius * 50));

  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? outer : inner;
    const x = center + Math.cos(angle) * radius;
    const y = center + Math.sin(angle) * radius;
    points.push(`${formatPoint(x)} ${formatPoint(y)}`);
  }

  return `polygon(${points.join(", ")})`;
}

export function getCellClipPath(shape: CellShape, innerRadius?: number) {
  switch (normalizeCellShape(shape)) {
    case "triangle":
      return "polygon(50% 0%, 100% 100%, 0% 100%)";
    case "star":
      return buildStarPolygon(innerRadius);
    case "diamond":
      return "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)";
    case "hexagon":
      return "polygon(25% 6.7%, 75% 6.7%, 100% 50%, 75% 93.3%, 25% 93.3%, 0% 50%)";
    case "heart":
      return "polygon(50% 94%, 11% 58%, 4% 48%, 1% 35%, 5% 21%, 15% 10%, 29% 6%, 40% 10%, 50% 22%, 60% 10%, 71% 6%, 85% 10%, 95% 21%, 99% 35%, 96% 48%, 89% 58%)";
    case "rectangle":
    default:
      return undefined;
  }
}

export function getCellShapeClassName(loader: LoaderComponent) {
  return cellShapeClassName(normalizeCellShape(loader.style.cellShape));
}

/** Shape class for a single cell (per-cell overrides aware). */
export function cellShapeClassName(shape: CellShape) {
  return `cell-shape cell-shape--${normalizeCellShape(shape)}`;
}

export function cellShapeStyle(
  shape: CellShape,
  innerRadius: number | undefined,
  renderedCellSize: number
): Record<string, string | number | undefined> {
  const normalized = normalizeCellShape(shape);
  const clipPath = getCellClipPath(normalized, innerRadius);
  const radius = normalized === "circle"
    ? renderedCellSize / 2
    : normalized === "rectangle" || normalized === "rounded-rect" || normalized === "pill"
      ? renderedCellSize * 0.22
      : 0;

  return {
    borderRadius: radius,
    clipPath,
    ["--cell-clip-path"]: clipPath
  };
}

export function getCellShapeStyle(loader: LoaderComponent, renderedCellSize: number): Record<string, string | number | undefined> {
  return cellShapeStyle(loader.style.cellShape, loader.style.innerRadius, renderedCellSize);
}

/** Effective visual style of one cell after merging per-cell overrides. */
export function resolveCellVisualStyle(
  loader: LoaderComponent,
  cellIndex: number
): { color: string; shape: CellShape; override: CellStyleOverride | undefined } {
  const override = loader.pattern.cellStyles?.[String(cellIndex)];
  return {
    color: isValidHexColor(override?.color) ? (override as CellStyleOverride).color as string : loader.style.primaryColor,
    shape: override?.shape !== undefined && isValidCellShape(override.shape)
      ? override.shape
      : normalizeCellShape(loader.style.cellShape),
    override
  };
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
