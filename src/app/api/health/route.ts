import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [db, merger] = await Promise.all([dbHealthy(), mergerHealthy()]);
  return NextResponse.json({
    ok: db,
    database: db ? "turso-connected" : "turso-unreachable",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerBase(), healthy: merger },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN?.trim()),
  });
}
