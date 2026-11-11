import { NextRequest, NextResponse } from "next/server";
import { addKey, findDuplicateKey, listKeys, toPublic, type ApiKeyRow } from "@/lib/keys";
import { taskStats } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = ["kie", "cometapi"];

export async function GET() {
  try {
    const keys: ApiKeyRow[] = await listKeys();
    const publicKeys = keys.map(toPublic);
    const stats = {
      total: publicKeys.length,
      active: publicKeys.filter((k) => k.status === "active").length,
      exhausted: publicKeys.filter((k) => k.status === "exhausted").length,
      disabled: publicKeys.filter((k) => k.status === "disabled").length,
      byProvider: {
        kie: publicKeys.filter((k) => k.provider === "kie").length,
        cometapi: publicKeys.filter((k) => k.provider === "cometapi").length,
      },
      totalUsage: publicKeys.reduce((s, k) => s + k.usageCount, 0),
      totalSuccess: publicKeys.reduce((s, k) => s + k.successCount, 0),
      totalFail: publicKeys.reduce((s, k) => s + k.failCount, 0),
    };
    const tasks = await taskStats();
    return NextResponse.json({ keys: publicKeys, stats, tasks });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to list keys" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { provider?: string; key?: string; label?: string };
    const provider = (body.provider ?? "").trim();
    const apiKey = (body.key ?? "").trim();
    const label = (body.label ?? "").trim().slice(0, 60);

    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json({ error: "المزود غير صالح — القيم المسموحة: kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey || apiKey.length < 8) {
      return NextResponse.json({ error: "أدخل مفتاح API صالحًا (8 أحرف على الأقل)" }, { status: 400 });
    }
    if (await findDuplicateKey(provider as "kie" | "cometapi", apiKey)) {
      return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
    }

    const created = await addKey(provider as "kie" | "cometapi", apiKey, label);
    return NextResponse.json({ key: toPublic(created) }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to add key" }, { status: 500 });
  }
}
