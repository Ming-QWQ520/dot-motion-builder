import { buildMotionData } from "./motion-data";
import { exportWeb } from "./web";
import { exportSwift } from "./swift";
import { exportSvg } from "./svg";
import { exportAvd } from "./avd";
import { ExportArtifact, ExportFormat, LoaderComponent, Project } from "@/types/dot-motion";

/** Generate a text artifact. GIF is binary and rendered on demand by the export panel. */
export function generateExportArtifact(format: ExportFormat, project: Project, loader: LoaderComponent): ExportArtifact {
  const data = buildMotionData(project, loader);
  if (format === "swift") return exportSwift(data, loader.name);
  if (format === "svg") return exportSvg(data, loader.name);
  if (format === "avd") return exportAvd(data, loader.name);
  return exportWeb(data, loader.name);
}
