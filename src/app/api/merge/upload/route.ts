/** POST /api/merge/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB) */
import { NextRequest } from "next/server";
import * as store from "@/lib/merge/store";
import { mergeConfig } from "@/lib/merge/config";
import { handleOptions, sendJson, sendError } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const jobId = String(q.get("job") || "");
  const seq = parseInt(q.get("seq") ?? "", 10);
  const chunk = parseInt(q.get("chunk") ?? "", 10);

  if (!jobId || !Number.isFinite(seq) || !Number.isFinite(chunk) || seq < 0 || chunk < 0) {
    return sendError("معاملات الرفع مطلوبة: job و seq و chunk", 400);
  }

  const job = await store.getJob(jobId);
  if (!job) return sendError("المهمة غير موجودة", 404);
  if (["processing", "done", "failed"].includes(String(job.status))) {
    return sendError("المهمة لم تعد في حالة الرفع — لا يمكن استقبال أجزاء جديدة", 409);
  }

  const sources = await store.getSources(jobId);
  const src = sources.find((s) => Number(s.seq) === seq);
  if (!src) return sendError("المصدر المحدد غير موجود في هذه المهمة", 404);
  if (String(src.kind) !== "file") {
    return sendError("هذا المصدر رابط وليس ملفًا — لا يحتاج رفعًا", 400);
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > mergeConfig.uploadChunkBytes) {
    return sendError(`حجم الجزء يتجاوز الحد المسموح (${mergeConfig.uploadChunkBytes / 1048576}MB)`, 413);
  }
  if (!buf.length) return sendError("الجزء المرفوع فارغ", 400);

  await store.saveSourceChunk(jobId, seq, chunk, buf);

  const received = Number(src.received || 0) + buf.length;
  const expectedChunks = Math.ceil(Number(src.size) / mergeConfig.uploadChunkBytes);
  const size = Number(src.size);
  const done = chunk + 1 >= expectedChunks || received >= size;

  await store.updateSource(jobId, seq, {
    received,
    status: done ? "ready" : "receiving",
  });

  return sendJson({
    ok: true,
    seq,
    chunk,
    receivedBytes: received,
    expectedBytes: size,
    expectedChunks,
    done,
  });
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}

export async function GET() {
  return sendError("طريقة غير مسموحة لهذه النقطة — استخدم POST لرفع الأجزاء", 405);
}
