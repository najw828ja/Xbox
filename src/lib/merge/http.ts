/** مساعدات HTTP لمسارات الدمج — CORS + استجابات JSON موحّدة */
import { NextResponse } from "next/server";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function applyCorsHeaders(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function handleOptions(): NextResponse {
  const res = new NextResponse(null, { status: 204 });
  return applyCorsHeaders(res);
}

export function sendJson(data: unknown, status = 200): NextResponse {
  const res = NextResponse.json(data, { status });
  return applyCorsHeaders(res);
}

export function sendError(message: string, status: number): NextResponse {
  const res = NextResponse.json({ error: message }, { status });
  return applyCorsHeaders(res);
}

/** عنوان الموقع الحالي — لبناء روابط الفيديو المطلقة في الاستجابات */
export function requestOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}
