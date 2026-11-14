/**
 * POST /api/merge/upload?job=<id>&seq=<n>&chunk=<i> — رفع أجزاء ملف مصدر (ثنائي ≤4MB لكل جزء)
 *
 * يستعيد المسار المفقود في تدفق رفع الملفات المصمم أصلًا:
 * - POST /api/merge/jobs يقبل مصادر {kind:"file"} ويعيد uploads[] مع uploadUrl وأعداد الأجزاء.
 * - هذا المسار يستقبل كل جزء بجسم ثنائي خام (Content-Type: application/octet-stream)
 *   ويخزنه في Turso عبر store.saveSourceChunk (INSERT OR REPLACE → إعادة رفع نفس الجزء آمنة).
 * - التحقق الصارم: طول كل جزء مطابق للمتوقع (chunkBytes للأجزاء الكاملة، والباقي للجزء الأخير).
 * - `received` يتقدم مع كل جزء (لا يتراجع) — بوابة التنفيذ في /process تشترط received ≥ size لكل ملف.
 * - عند اكتمال كل مصادر الملفات تنتقل المهمة من uploading إلى queued تلقائيًا.
 * - بعد نجاح الدمج تحذف أجزاء المصادر تلقائيًا (engine → deleteSourceChunks).
 *
 * ملاحظة: حد جسم الطلب في Vercel ≈ 4.5MB — لذلك حجم الجزء 4MB (uploadChunkBytes).
 */
import { NextRequest } from "next/server";
import * as store from "@/lib/merge/store";
import { mergeConfig as config } from "@/lib/merge/config";
import { handleOptions, sendJson, sendError } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 1) معطيات المسار: job + seq + chunk
  const url = new URL(req.url);
  const jobId = (url.searchParams.get("job") ?? "").trim();
  const seq = Number(url.searchParams.get("seq"));
  const idx = Number(url.searchParams.get("chunk"));
  if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(idx) || idx < 0) {
    return sendError("معطيات ناقصة أو تالفة — المطلوب: job و seq و chunk (أعداد صحيحة ≥ 0)", 400);
  }

  // 2) المهمة: يجب أن تكون قابلة للرفع (وليست منتهية)
  const job = await store.getJob(jobId);
  if (!job) return sendError("المهمة غير موجودة", 404);
  const jobStatus = String(job.status);
  if (jobStatus === "done" || jobStatus === "failed") {
    return sendError(`المهمة ${jobStatus === "done" ? "مكتملة" : "فاشلة"} — لا يمكن رفع أجزاء إليها`, 409);
  }

  // 3) المصدر: يجب أن يكون مصدر ملف ضمن هذه المهمة
  const sources = await store.getSources(jobId);
  const source = sources.find((s) => Number(s.seq) === seq);
  if (!source) return sendError(`لا يوجد مصدر برقم ${seq} في هذه المهمة`, 404);
  if (String(source.kind) !== "file") {
    return sendError(`المصدر ${seq} من نوع رابط (url) — الرفع بالأجزاء للملفات فقط`, 400);
  }
  const size = Number(source.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return sendError("حجم الملف المعلن لهذا المصدر غير صالح", 400);
  }

  const chunkBytes = config.uploadChunkBytes;
  const chunks = Math.ceil(size / chunkBytes);
  if (idx >= chunks) {
    return sendError(`رقم الجزء ${idx} خارج النطاق — هذا الملف مقسم إلى ${chunks} جزء`, 400);
  }

  // 4) الجسم الثنائي: غير فارغ، ضمن حد الجزء، وطوله مطابق للمتوقع تمامًا
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) return sendError("الجزء فارغ — الجسم الثنائي مطلوب", 400);
  if (buf.length > chunkBytes) {
    return sendError(
      `حجم الجزء (${buf.length} بايت) يتجاوز حد الجزء (${chunkBytes} بايت) — ارفع بأجزاء ${chunkBytes} بايت`,
      413
    );
  }
  const expectedLen = idx === chunks - 1 ? size - idx * chunkBytes : chunkBytes;
  if (buf.length !== expectedLen) {
    return sendError(`طول الجزء ${idx} غير مطابق — المتوقع ${expectedLen} بايت والواصل ${buf.length} بايت`, 400);
  }

  // 5) الحفظ (إعادة رفع نفس الجزء تستبدله بأمان) + تقدم المستلم دون تراجع
  await store.saveSourceChunk(jobId, seq, idx, buf);
  const received = Math.min(size, Math.max(Number(source.received || 0), idx * chunkBytes + buf.length));
  const sourceDone = received >= size;
  await store.updateSource(jobId, seq, { received, status: sourceDone ? "ready" : "pending" });

  // 6) اكتمال كل مصادر الملفات → المهمة تصبح جاهزة للتنفيذ (queued)
  let currentStatus = jobStatus;
  if (sourceDone && jobStatus === "uploading") {
    const all = await store.getSources(jobId);
    const allDone = all.every(
      (s) => String(s.kind) !== "file" || Number(s.received || 0) >= Number(s.size || 0)
    );
    if (allDone) {
      await store.updateJob(jobId, { status: "queued" });
      currentStatus = "queued";
    }
  }

  return sendJson({
    ok: true,
    seq,
    chunk: idx,
    received,
    size,
    chunks,
    done: sourceDone,
    jobStatus: currentStatus,
  });
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}

export async function GET() {
  return sendError("طريقة غير مسموحة لهذه النقطة — استخدم POST لرفع جزء بجسم ثنائي", 405);
}
