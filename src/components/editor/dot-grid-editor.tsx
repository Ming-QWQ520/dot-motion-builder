"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cellShapeClassName,
  cellShapeStyle,
  normalizeCellShape,
  resolveCellVisualStyle,
  shapeOptions
} from "@/lib/cell-shapes";
import { getCanvasGridMetrics } from "@/lib/canvas-grid-metrics";
import { rgbaWithOpacity } from "@/lib/colors";
import { CellShape, LoaderComponent } from "@/types/dot-motion";

/** Brush used while drawing: null fields follow the loader-wide style. */
export type CellBrush = {
  color: string | null;
  shape: CellShape | null;
};

/** Shared quick palette for the brush and the single-cell editor. */
export const brushPalette = [
  "#66BDFF", "#FF6B81", "#FFD166", "#06D6A0",
  "#9B5DE5", "#F15BB5", "#00E5FF", "#FF8C42",
  "#FFFFFF", "#94A7B7"
];

type DotGridEditorProps = {
  loader: LoaderComponent;
  onToggleCell: (cellIndex: number) => void;
  onSetCellActive?: (cellIndex: number, active: boolean) => void;
  /** Brush painting: activates the cell and merges a per-cell style override. */
  onPaintCell?: (cellIndex: number, style: { color?: string; shape?: CellShape } | null) => void;
  /** Single-cell popover editing (does not change activation). */
  onSetCellOverride?: (cellIndex: number, patch: { color?: string; shape?: CellShape } | null) => void;
  brush?: CellBrush | null;
  language?: "cn" | "en";
  variant?: "default" | "canvas";
};

type CellEditState = {
  cellIndex: number;
  x: number;
  y: number;
};

function CellStylePopover({
  loader,
  cellIndex,
  x,
  y,
  language,
  onApply,
  onReset,
  onDeactivate,
  onClose
}: {
  loader: LoaderComponent;
  cellIndex: number;
  x: number;
  y: number;
  language: "cn" | "en";
  onApply: (cellIndex: number, patch: { color?: string; shape?: CellShape } | null) => void;
  onReset: (cellIndex: number) => void;
  onDeactivate: (cellIndex: number) => void;
  onClose: () => void;
}) {
  const override = loader.pattern.cellStyles?.[String(cellIndex)] ?? {};
  const [color, setColor] = useState<string | null>(override.color ?? null);
  const [shape, setShape] = useState<CellShape | null>(override.shape ?? null);
  const cn = language === "cn";
  const row = Math.floor(cellIndex / loader.pattern.grid.cols) + 1;
  const col = (cellIndex % loader.pattern.grid.cols) + 1;

  const style = {
    left: Math.min(x, Math.max(16, window.innerWidth - 244)),
    top: Math.min(y, Math.max(16, window.innerHeight - 320))
  };

  function applyColor(next: string | null) {
    setColor(next);
    onApply(cellIndex, next ? { color: next } : null);
  }

  function applyShape(next: CellShape | null) {
    setShape(next);
    onApply(cellIndex, next ? { shape: next } : null);
  }

  return createPortal(
    <>
      <div className="cell-style-popover__backdrop" onPointerDown={onClose} />
      <div className="cell-style-popover" style={style} role="dialog" aria-label={cn ? "单格样式" : "Cell style"}>
        <div className="cell-style-popover__header">
          <span>{cn ? `单格样式 · 第 ${row} 行 ${col} 列` : `Cell style · R${row}C${col}`}</span>
          <button type="button" className="cell-style-popover__close" onClick={onClose} aria-label={cn ? "关闭" : "Close"}>✕</button>
        </div>
        <div className="cell-style-popover__group">
          <span className="cell-style-popover__label">{cn ? "颜色" : "Color"}</span>
          <div className="cell-style-popover__swatches">
            <button
              type="button"
              className={`cell-style-popover__swatch${color === null ? " is-none" : ""}`}
              onClick={() => applyColor(null)}
              title={cn ? "跟随全局颜色" : "Follow global color"}
              aria-label={cn ? "跟随全局颜色" : "Follow global color"}
            >
              <span className="cell-style-popover__swatch-none" aria-hidden="true" />
            </button>
            {brushPalette.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`cell-style-popover__swatch${color?.toUpperCase() === swatch ? " is-selected" : ""}`}
                style={{ background: swatch }}
                onClick={() => applyColor(swatch)}
                title={swatch}
                aria-label={swatch}
              />
            ))}
            <label className="cell-style-popover__custom" title={cn ? "自定义颜色" : "Custom color"}>
              <input
                type="color"
                value={color ?? "#66BDFF"}
                onChange={(event) => applyColor(event.target.value.toUpperCase())}
                aria-label={cn ? "自定义颜色" : "Custom color"}
              />
              <span>{cn ? "自定义" : "Custom"}</span>
            </label>
          </div>
        </div>
        <div className="cell-style-popover__group">
          <span className="cell-style-popover__label">{cn ? "形状" : "Shape"}</span>
          <div className="cell-style-popover__shapes">
            <button
              type="button"
              className={`cell-style-popover__shape${shape === null ? " is-selected" : ""}`}
              onClick={() => applyShape(null)}
            >
              {cn ? "跟随全局" : "Global"}
            </button>
            {shapeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`cell-style-popover__shape${shape === option.value ? " is-selected" : ""}`}
                onClick={() => applyShape(option.value)}
              >
                <span
                  className={`cell-style-popover__shape-preview cell-shape cell-shape--${option.value}`}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </div>
        <div className="cell-style-popover__actions">
          <button
            type="button"
            className="cell-style-popover__button"
            onClick={() => {
              onReset(cellIndex);
              onClose();
            }}
          >
            {cn ? "恢复默认样式" : "Reset style"}
          </button>
          <button
            type="button"
            className="cell-style-popover__button cell-style-popover__button--danger"
            onClick={() => {
              onDeactivate(cellIndex);
              onClose();
            }}
          >
            {cn ? "熄灭此格" : "Turn off"}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

export function DotGridEditor({
  loader,
  onToggleCell,
  onSetCellActive,
  onPaintCell,
  onSetCellOverride,
  brush = null,
  language = "cn",
  variant = "default"
}: DotGridEditorProps) {
  const { rows, cols, cellSize, gap } = loader.pattern.grid;
  const cells = Array.from({ length: rows * cols }, (_, index) => index);
  const canvasMetrics = useMemo(() => getCanvasGridMetrics(loader), [loader]);
  const [editing, setEditing] = useState<CellEditState | null>(null);
  const dragStateRef = useRef<{
    nextValue: boolean;
    visited: Set<number>;
  } | null>(null);
  const renderGap = useMemo(() => {
    if (variant === "canvas") {
      return canvasMetrics.gap;
    }

    return gap;
  }, [canvasMetrics.gap, gap, variant]);

  const renderCellSize = useMemo(() => {
    if (variant === "canvas") {
      return canvasMetrics.cellSize;
    }

    return cellSize;
  }, [canvasMetrics.cellSize, cellSize, variant]);

  useEffect(() => {
    function endDrag() {
      dragStateRef.current = null;
    }

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  const hasBrush = Boolean(brush && (brush.color || brush.shape));

  function applyCell(cellIndex: number, active: boolean) {
    if (active && hasBrush && onPaintCell) {
      onPaintCell(cellIndex, {
        color: brush?.color ?? undefined,
        shape: brush?.shape ?? undefined
      });
      return;
    }

    if (onSetCellActive) {
      onSetCellActive(cellIndex, active);
      return;
    }

    const isActive = loader.pattern.activeCells.includes(cellIndex);
    if (isActive !== active) {
      onToggleCell(cellIndex);
    }
  }

  function handlePointerDown(cellIndex: number) {
    const isActive = loader.pattern.activeCells.includes(cellIndex);
    const nextValue = !isActive;
    dragStateRef.current = {
      nextValue,
      visited: new Set([cellIndex])
    };
    applyCell(cellIndex, nextValue);
  }

  function handlePointerEnter(cellIndex: number) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.visited.has(cellIndex)) {
      return;
    }

    dragState.visited.add(cellIndex);
    applyCell(cellIndex, dragState.nextValue);
  }

  function handleContextMenu(event: React.MouseEvent, cellIndex: number) {
    if (!onSetCellOverride) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setEditing({ cellIndex, x: event.clientX + 8, y: event.clientY + 8 });
  }

  return (
    <div className={`dot-grid-editor-shell${variant === "canvas" ? " dot-grid-editor-shell--canvas" : ""}`}>
      <div
        className={`dot-grid${variant === "canvas" ? " dot-grid--canvas" : ""}`}
        style={{
          gridTemplateColumns: `repeat(${cols}, ${renderCellSize}px)`,
          gap: renderGap,
          padding:
            variant === "canvas"
              ? `${canvasMetrics.padding}px`
              : undefined
        }}
      >
        {cells.map((cellIndex) => {
          const active = loader.pattern.activeCells.includes(cellIndex);
          const visual = resolveCellVisualStyle(loader, cellIndex);
          return (
            <button
              key={cellIndex}
              type="button"
              data-dot-cell="true"
              className={`dot-grid__cell ${cellShapeClassName(visual.shape)}${active ? " is-active" : ""}${variant === "canvas" ? " dot-grid__cell--canvas" : ""}`}
              onClick={(event) => event.preventDefault()}
              onPointerDown={() => handlePointerDown(cellIndex)}
              onPointerEnter={() => handlePointerEnter(cellIndex)}
              onContextMenu={(event) => handleContextMenu(event, cellIndex)}
              title={onSetCellOverride ? (language === "cn" ? "右键编辑单格样式" : "Right-click to edit this cell") : undefined}
              style={{
                width: renderCellSize,
                height: renderCellSize,
                ...cellShapeStyle(visual.shape, loader.style.innerRadius, renderCellSize),
                background: active
                  ? undefined
                  : rgbaWithOpacity(loader.style.backgroundColor ?? "#2D3743", 1, loader.style.backgroundAlpha ?? 1),
                ["--cell-color" as string]: rgbaWithOpacity(visual.color, 1, loader.style.primaryAlpha ?? 1),
                ["--cell-glow-color" as string]: rgbaWithOpacity(
                  visual.color,
                  1,
                  loader.style.primaryAlpha ?? 1
                ),
                ["--cell-glow-size" as string]: `${loader.style.shadow ? loader.style.glow : 0}px`
              }}
              aria-label={`Toggle cell ${cellIndex + 1}`}
            />
          );
        })}
      </div>
      {editing && onSetCellOverride ? (
        <CellStylePopover
          loader={loader}
          cellIndex={editing.cellIndex}
          x={editing.x}
          y={editing.y}
          language={language}
          onApply={(cellIndex, patch) => onSetCellOverride(cellIndex, patch)}
          onReset={(cellIndex) => onSetCellOverride(cellIndex, null)}
          onDeactivate={(cellIndex) => {
            if (onSetCellActive) {
              onSetCellActive(cellIndex, false);
            } else {
              onToggleCell(cellIndex);
            }
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

export { normalizeCellShape };
