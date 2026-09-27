"use client";

import { useEffect, useMemo, useState } from "react";
import { buildMotionData } from "@/lib/exporters/motion-data";
import { renderMotionGif } from "@/lib/exporters/gif";
import { generateExportArtifact } from "@/lib/exporters";
import { Language, uiCopy } from "@/lib/ui-copy";
import { useEditorStore, useSelectedLoader } from "@/stores/use-editor-store";
import { ExportFormat } from "@/types/dot-motion";
import { Button } from "@/toolcraft/ui/components/primitives/button";
import { SegmentedControl } from "@/toolcraft/ui/components/controls/segmented/segmented-control";
import { SwitchControl } from "@/toolcraft/ui/components/controls/boolean/boolean-controls";
import { SelectControl } from "@/toolcraft/ui/components/controls/select/select-control";

const formats: { value: ExportFormat; label: string }[] = [
  { value: "web", label: "JavaScript" },
  { value: "svg", label: "SVG" },
  { value: "gif", label: "GIF" },
  { value: "avd", label: "AVD" },
  { value: "swift", label: "Swift" }
];

const gifScaleOptions = [
  { value: "4", label: "4px" },
  { value: "6", label: "6px" },
  { value: "8", label: "8px" },
  { value: "12", label: "12px" },
  { value: "16", label: "16px" },
  { value: "24", label: "24px" }
];

type ExportPanelProps = {
  language: Language;
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportPanel({ language }: ExportPanelProps) {
  const project = useEditorStore((state) => state.project);
  const format = useEditorStore((state) => state.exportFormat);
  const setFormat = useEditorStore((state) => state.setExportFormat);
  const loader = useSelectedLoader();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [gifScale, setGifScale] = useState("8");
  const [gifTransparent, setGifTransparent] = useState(false);
  const t = uiCopy[language];
  const cn = language === "cn";
  const effectiveFormat = formats.some((item) => item.value === format) ? format : "web";

  const motionData = useMemo(() => buildMotionData(project, loader), [project, loader]);
  const artifact = useMemo(
    () => (effectiveFormat === "gif"
      ? null
      : generateExportArtifact(effectiveFormat, project, loader)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveFormat, motionData]
  );

  const gifResult = useMemo(() => {
    if (effectiveFormat !== "gif") {
      return null;
    }
    try {
      return renderMotionGif(motionData, loader.name, {
        cellPx: Number(gifScale),
        transparent: gifTransparent
      });
    } catch {
      return null;
    }
  }, [effectiveFormat, motionData, gifScale, gifTransparent, loader.name]);

  const gifDataUrl = useMemo(() => {
    if (!gifResult) {
      return null;
    }
    let binary = "";
    const bytes = gifResult.bytes;
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/gif;base64,${window.btoa(binary)}`;
  }, [gifResult]);

  const previewContent = effectiveFormat === "gif"
    ? (gifResult
      ? (cn
        ? `GIF 动画 · ${gifResult.width}×${gifResult.height}px · ${gifResult.frameCount} 帧 · ${Math.round(gifResult.delayMs)}ms/帧 · ${gifResult.colorCount} 色 · ${(gifResult.bytes.length / 1024).toFixed(1)} KB`
        : `GIF animation · ${gifResult.width}×${gifResult.height}px · ${gifResult.frameCount} frames · ${Math.round(gifResult.delayMs)}ms/frame · ${gifResult.colorCount} colors · ${(gifResult.bytes.length / 1024).toFixed(1)} KB`)
      : (cn ? "GIF 生成失败。" : "GIF generation failed."))
    : (artifact?.content ?? "");

  useEffect(() => { setCopied(false); setCopyError(false); }, [effectiveFormat, motionData]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    if (effectiveFormat === "gif") return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(previewContent);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  function handleDownload() {
    if (effectiveFormat === "gif") {
      if (gifResult) {
        downloadBlob(new Blob([gifResult.bytes as unknown as BlobPart], { type: "image/gif" }), gifResult.filename);
      }
      return;
    }
    if (artifact) {
      downloadBlob(new Blob([artifact.content], { type: artifact.mimeType }), artifact.filename);
    }
  }

  return (
    <section className="panel panel--export">
      <div className="panel__header">
        <div>
          <h2>{t.exportFile}</h2>
        </div>
      </div>
      <div className="export-platform-control export-platform-control--wrap">
        <SegmentedControl
          ariaLabel={cn ? "导出格式" : "Export format"}
          name={cn ? "格式" : "Format"}
          value={effectiveFormat}
          options={formats}
          onValueChange={(value) => {
            if (value === "web" || value === "swift" || value === "svg" || value === "gif" || value === "avd") {
              setFormat(value);
            }
          }}
        />
      </div>
      {effectiveFormat === "gif" ? (
        <div className="gif-options">
          <SelectControl
            name={cn ? "单格像素" : "Cell size"}
            value={gifScale}
            options={gifScaleOptions}
            onValueChange={(value) => setGifScale(String(value))}
          />
          <SwitchControl
            checked={gifTransparent}
            name={cn ? "透明背景" : "Transparent"}
            onCheckedChange={(value) => setGifTransparent(Boolean(value))}
          />
        </div>
      ) : null}
      {effectiveFormat === "gif" && gifDataUrl ? (
        <div className="gif-preview">
          <img src={gifDataUrl} alt={cn ? "GIF 预览" : "GIF preview"} />
        </div>
      ) : null}
      {effectiveFormat === "avd" ? (
        <p className="field-help">
          {cn
            ? "AnimatedVectorDrawable（Android 矢量动画，单文件自包含，放入 res/drawable/ 即可使用）。"
            : "AnimatedVectorDrawable (self-contained Android vector animation; drop into res/drawable/)."}
        </p>
      ) : null}
      <div className="export-meta">
        <span>{effectiveFormat === "gif" ? (gifResult?.filename ?? `${loader.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.gif`) : artifact?.filename}</span>
      </div>
      <pre className="export-code">{previewContent}</pre>
      <div className="panel__actions">
        {copyError ? <p role="alert">{cn ? "复制失败，请下载文件或手动复制。" : "Copy failed. Download the file or copy manually."}</p> : null}
        <Button type="button" variant="outline" onClick={handleCopy} disabled={effectiveFormat === "gif"}>
          {copied ? t.copied : t.copyOutput}
        </Button>
        <Button type="button" variant="default" onClick={handleDownload}>
          {t.downloadFile}
        </Button>
      </div>
    </section>
  );
}
