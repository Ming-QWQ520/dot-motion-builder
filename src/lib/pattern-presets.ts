import { PatternPreset, PatternPresetId } from "@/types/dot-motion";

export const patternPresets: PatternPreset[] = [
  {
    id: "spinner",
    name: "Spinner",
    description: "An X-shaped spinner that reads clearly at small grid sizes."
  },
  {
    id: "checker",
    name: "Checker",
    description: "A matrix checkerboard for thinking and pulse states."
  },
  {
    id: "ring",
    name: "Ring",
    description: "A hollow frame/ring suited for scanning and analysing states."
  },
  {
    id: "wave-diagonal",
    name: "Wave Diagonal",
    description: "A diagonal band used for debugging and progress wave effects."
  },
  {
    id: "cross",
    name: "Cross",
    description: "A centered plus sign that reads clearly at any grid size."
  },
  {
    id: "corners",
    name: "Corners",
    description: "Four corner blocks suited for framing and focus states."
  }
];

export function buildPatternCells(presetId: PatternPresetId, rows: number, cols: number) {
  const activeCells: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;

      if (presetId === "checker" && (row + col) % 2 === 0) {
        activeCells.push(index);
      }

      if (presetId === "spinner" && (row === col || row + col === cols - 1)) {
        activeCells.push(index);
      }

      if (presetId === "ring") {
        const onOuterEdge = row === 0 || col === 0 || row === rows - 1 || col === cols - 1;
        const omitCornerInset = rows > 4 && cols > 4 && row > 0 && row < rows - 1 && col > 0 && col < cols - 1;
        if (onOuterEdge && !omitCornerInset) {
          activeCells.push(index);
        }
      }

      if (presetId === "wave-diagonal") {
        const diagonalBand = row + col >= rows - 2 && row + col <= rows + 1;
        const lowerLeftBias = row >= col - 1;
        if (diagonalBand && lowerLeftBias) {
          activeCells.push(index);
        }
      }

      if (presetId === "cross") {
        const midRow = Math.floor((rows - 1) / 2);
        const midCol = Math.floor((cols - 1) / 2);
        if (row === midRow || col === midCol) {
          activeCells.push(index);
        }
      }

      if (presetId === "corners") {
        const inset = Math.min(2, Math.max(1, Math.floor(Math.min(rows, cols) / 3)));
        const inCorner =
          (row < inset || row >= rows - inset) &&
          (col < inset || col >= cols - inset);
        if (inCorner) {
          activeCells.push(index);
        }
      }
    }
  }

  return [...new Set(activeCells)].sort((left, right) => left - right);
}
