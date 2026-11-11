/** GET /api/merge/jobs/<id> — الحالة والتقدم | DELETE — حذف فوري شامل */
import { NextRequest } from "next/server";
import * as store from "@/lib/merge/store";
import { handleOptions, sendJson, sendError, requestOrigin } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jobView(
  job: store.MergeJobRow,
  sources: store.MergeSourceRow[],
  origin: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    jobId: job.id,
    status: String(job.status),
    progress: Number(job.progress || 0),
    createdAt: job.created_at,
    expiresAt: job.expires_at,
    sources: sources.map((s) => ({
      seq: Number(s.seq),
      kind: String(s.kind),
      name: s.name || s.url || null,
      size: s.size === null ? null : Number(s.size),
      status: String(s.status),
    })),
  };
  if (job.error) payload.error = String(job.error);
  if (String(job.status) === "done") {
    payload.videoUrl = `${origin}/api/merge/jobs/${job.id}/video`;
    payload.downloadUrl = `${origin}/api/merge/jobs/${job.id}/video?download=1`;
    payload.size = job.output_size === null ? null : Number(job.output_size);
    payload.duration = job.output_duration === null ? null : Number(job.output_duration);
    payload.resolution =
      job.output_width && job.output_height
        ? `${Number(job.output_width)}x${Number(job.output_height)}`
        : null;
  }
  return payload;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await store.getJob(id);
  if (!job) return sendError("المهمة غير موجودة", 404);
  const sources = await store.getSources(id);
  return sendJson(jobView(job, sources, requestOrigin(req)));
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await store.getJob(id);
  if (!job) return sendError("المهمة غير موجودة", 404);
  await store.deleteJob(id);
  return sendJson({ deleted: true, jobId: id });
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}
