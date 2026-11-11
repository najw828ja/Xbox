/**
 * POST /api/merge/jobs — إنشاء مهمة دمج
 * يقبل {"videos":[...]} (روابط) أو {"sources":[{kind,url|name,size,mime}]}
 */
import { NextRequest } from "next/server";
import * as store from "@/lib/merge/store";
import { mergeConfig } from "@/lib/merge/config";
import { handleOptions, sendJson, sendError } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawSource {
  kind?: string;
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
}

export async function POST(req: NextRequest) {
  let body: { videos?: unknown; sources?: unknown };
  try {
    const text = await req.text();
    if (text.length > 256 * 1024) return sendError("جسم الطلب كبير جدًا", 413);
    body = JSON.parse(text);
  } catch {
    return sendError("جسم الطلب مطلوب بصيغة JSON", 400);
  }

  // تقبل {"videos":[...]} أو {"sources":[{kind,url|name,size,mime}]}
  let sources: store.NewSource[] = [];
  try {
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: "url" as const, url: String(u) }));
    } else if (Array.isArray(body.sources)) {
      for (const s of body.sources as RawSource[]) {
        if (!s || typeof s !== "object") throw new Error("عنصر مصدر تالف");
        if (s.kind === "url" || (typeof s.url === "string" && !s.kind)) {
          sources.push({ kind: "url", url: String(s.url) });
        } else if (s.kind === "file") {
          sources.push({
            kind: "file",
            name: s.name ? String(s.name) : "file",
            size: Number(s.size),
            mime: s.mime ? String(s.mime) : "video/mp4",
          });
        } else {
          throw new Error('نوع مصدر غير مدعوم — استخدم "url" أو "file"');
        }
      }
    }
  } catch (e) {
    return sendError(`مدخلات تالفة: ${e instanceof Error ? e.message : String(e)}`, 400);
  }

  if (!sources.length) {
    return sendError("قائمة المصادر فارغة — أضف رابطًا واحدًا على الأقل أو ملفًا", 400);
  }
  if (sources.length > mergeConfig.maxSources) {
    return sendError(`عدد المصادر يتجاوز الحد المسموح (${mergeConfig.maxSources})`, 400);
  }
  for (const s of sources) {
    if (s.kind === "url") {
      try {
        const u = new URL(s.url!);
        if (!["http:", "https:"].includes(u.protocol)) throw new Error("بروتوكول غير مدعوم");
      } catch {
        return sendError(`رابط غير صالح: ${s.url}`, 400);
      }
    } else {
      if (!Number.isFinite(s.size) || s.size! <= 0) {
        return sendError(`حجم الملف "${s.name}" غير صالح`, 400);
      }
      if (s.size! > mergeConfig.sourceMaxBytes) {
        return sendError(
          `حجم الملف "${s.name}" (${(s.size! / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${mergeConfig.sourceMaxBytes / 1048576}MB)`,
          413
        );
      }
    }
  }

  // تنظيف كسول عند كل إنشاء (تحذير الـ 24 ساعة)
  try {
    await store.cleanupExpired();
  } catch {
    /* تجاهل */
  }

  const job = await store.createJob(sources);

  const fileSources = sources
    .map((s, seq) => ({ s, seq }))
    .filter(({ s }) => s.kind === "file")
    .map(({ s, seq }) => ({
      seq,
      name: s.name,
      size: s.size,
      mime: s.mime || "video/mp4",
      chunks: Math.ceil(s.size! / mergeConfig.uploadChunkBytes),
      uploadUrl: `/api/merge/upload?job=${job.id}&seq=${seq}`,
    }));

  const payload: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    statusUrl: `/api/merge/jobs/${job.id}`,
    processUrl: `/api/merge/jobs/${job.id}/process`,
    expiresAt: job.expiresAt.toISOString(),
  };
  if (fileSources.length) {
    payload.uploads = fileSources;
    payload.uploadChunkBytes = mergeConfig.uploadChunkBytes;
  }

  return sendJson(payload, 201);
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}

export async function GET() {
  return sendError("طريقة غير مسموحة لهذه النقطة — استخدم POST لإنشاء مهمة", 405);
}
