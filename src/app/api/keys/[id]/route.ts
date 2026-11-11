import { NextRequest, NextResponse } from "next/server";
import { deleteKey, getKey, setKeyStatus, toPublic, type KeyStatus } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH: { action: "activate" | "disable" | "markExhausted" } */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { action?: string };
    const actions: Record<string, { status: KeyStatus; error: string | null }> = {
      activate: { status: "active", error: null },
      disable: { status: "disabled", error: "عُطِّل يدويًا من الواجهة" },
      markExhausted: { status: "exhausted", error: "وُسم مستنزفًا يدويًا" },
    };
    const action = actions[body.action ?? ""];
    if (!action) {
      return NextResponse.json({ error: "action غير صالح — القيم: activate | disable | markExhausted" }, { status: 400 });
    }
    const existing = await getKey(id);
    if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });

    await setKeyStatus(id, action.status, action.error);
    const updated = await getKey(id);
    return NextResponse.json({ key: updated ? toPublic(updated) : null });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to update key" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const existing = await getKey(id);
    if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
    await deleteKey(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed to delete key" }, { status: 500 });
  }
}
