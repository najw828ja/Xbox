/** GET/HEAD /api/merge/jobs/<id>/video — بث الناتج مع دعم Range (206) و ?download=1 */
import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/merge/store";
import { applyCorsHeaders, handleOptions, sendError } from "@/lib/merge/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return serveVideo(req, ctx, false);
}

export async function HEAD(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return serveVideo(req, ctx, true);
}

async function serveVideo(req: NextRequest, ctx: { params: Promise<{ id: string }> }, headOnly: boolean) {
  const { id } = await ctx.params;
  const job = await store.getJob(id);
  if (!job) return sendError("المهمة غير موجودة", 404);
  if (String(job.status) !== "done") {
    return sendError("الفيديو غير متوفر بعد — المهمة ليست مكتملة", 404);
  }

  const total = Number(job.output_size || 0);
  if (!total) return sendError("الفيديو غير موجود", 404);

  const isDownload = new URL(req.url).searchParams.get("download") === "1";
  const contentType = String(job.output_mime || "video/mp4");
  const fname = `merged-${id}.mp4`;
  const rangeHeader = req.headers.get("range");

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="${fname}"`,
  };

  // بث كامل بدون Range
  if (!rangeHeader) {
    const res = new NextResponse(headOnly ? null : undefined, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
    if (headOnly) return applyCorsHeaders(res);
    const whole = await store.readOutputRange(id, 0, total - 1);
    return applyCorsHeaders(
      new NextResponse(whole ? new Uint8Array(whole.buf) : new Uint8Array(0), {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(total) },
      })
    );
  }

  // تحليل "bytes=start-end"
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m || (m[1] === "" && m[2] === "")) {
    const res = new NextResponse(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
    return applyCorsHeaders(res);
  }

  let start: number;
  let end: number;
  if (m[1] === "") {
    // لاحقة: bytes=-N → آخر N بايت
    const n = parseInt(m[2], 10);
    if (!n) {
      const res = new NextResponse(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
      return applyCorsHeaders(res);
    }
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }

  if (start > end || start >= total) {
    const res = new NextResponse(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
    return applyCorsHeaders(res);
  }

  const slice = await store.readOutputRange(id, start, end);
  const res = new NextResponse(headOnly ? null : new Uint8Array(slice ? slice.buf : Buffer.alloc(0)), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(end - start + 1),
    },
  });
  return applyCorsHeaders(res);
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}
