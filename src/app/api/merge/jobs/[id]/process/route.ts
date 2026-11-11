/**
 * POST /api/merge/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن) | 202 لو جارية.
 * يتطلب Node runtime (ffmpeg) — أقصى مدة تنفيذ 300 ثانية على Vercel.
 */
import { NextRequest } from "next/server";
import * as store from "@/lib/merge/store";
import { processJob } from "@/lib/merge/engine";
import { handleOptions, sendJson, sendError, requestOrigin } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await store.getJob(id);
  if (!job) return sendError("المهمة غير موجودة", 404);

  const status = String(job.status);
  if (status === "processing") {
    return sendJson({ status: "processing", progress: Number(job.progress || 0) }, 202);
  }
  if (status === "done") {
    const origin = requestOrigin(_req);
    return sendJson({
      status: "done",
      videoUrl: `${origin}/api/merge/jobs/${id}/video`,
      downloadUrl: `${origin}/api/merge/jobs/${id}/video?download=1`,
      size: job.output_size === null ? null : Number(job.output_size),
      duration: job.output_duration === null ? null : Number(job.output_duration),
      resolution:
        job.output_width && job.output_height
          ? `${Number(job.output_width)}x${Number(job.output_height)}`
          : null,
      expiresAt: job.expires_at,
    });
  }
  if (status === "uploading") {
    // تأكد أن كل ملفات المصدر اكتمل رفعها
    const sources = await store.getSources(id);
    const missing = sources.filter(
      (s) => String(s.kind) === "file" && Number(s.received || 0) < Number(s.size || 0)
    );
    if (missing.length) {
      return sendError("لم يتم رفع جميع أجزاء الملفات بعد — أكمل الرفع أولًا", 409);
    }
  }

  try {
    const result = await processJob(id);
    const origin = requestOrigin(_req);
    const job2 = await store.getJob(id);
    return sendJson({
      status: "done",
      videoUrl: `${origin}/api/merge/jobs/${id}/video`,
      downloadUrl: `${origin}/api/merge/jobs/${id}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: job2 ? String(job2.expires_at) : undefined,
    });
  } catch (e) {
    const code = (e as { code?: number }).code || 500;
    const msg = e instanceof Error && e.message ? e.message : "فشل الدمج بسبب غير معروف";
    return sendError(msg, code);
  }
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}
