/** GET /api/merge/cron — حذف المهام المنتهية (Cron يومي في vercel.json) */
import { handleOptions, sendJson, sendError } from "@/lib/merge/http";
import { cleanupExpired } from "@/lib/merge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let deleted = 0;
  try {
    deleted = await cleanupExpired();
  } catch (e) {
    return sendError(`فشل التنظيف: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
  return sendJson({ deleted, at: new Date().toISOString() });
}

export function OPTIONS(): ReturnType<typeof handleOptions> {
  return handleOptions();
}
