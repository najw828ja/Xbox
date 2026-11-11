/** GET /api/merge/config — الحدود العامة + version */
import { mergeConfig } from "@/lib/merge/config";
import { handleOptions, sendJson, sendError } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return sendJson({
    version: mergeConfig.version,
    maxSources: mergeConfig.maxSources,
    sourceMaxMb: Math.round(mergeConfig.sourceMaxBytes / 1048576),
    outputMaxMb: Math.round(mergeConfig.outputMaxBytes / 1048576),
    maxTotalDurationSec: mergeConfig.maxTotalDurationSec,
    uploadChunkBytes: mergeConfig.uploadChunkBytes,
    expireHours: mergeConfig.expireHours,
    maxResolution: `${mergeConfig.maxResW}x${mergeConfig.maxResH}`,
    fps: mergeConfig.fps,
    preset: mergeConfig.ffmpegPreset,
  });
}

export async function POST() {
  return sendError("طريقة غير مسموحة لهذه النقطة — استخدم GET", 405);
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}
