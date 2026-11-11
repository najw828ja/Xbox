import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** أحدث المهام المخزنة في Turso (روابط + معرّفات + حالات) */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit") ?? 12) || 12));
    const [tasks, stats] = await Promise.all([listRecentTasks(limit), taskStats()]);
    return NextResponse.json({ tasks, stats });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to list tasks" }, { status: 500 });
  }
}
