import { NextRequest, NextResponse } from "next/server";
import { getKey, markKeyChecked, setKeyStatus, toPublic, classifyProviderError } from "@/lib/keys";
import { adapters } from "@/lib/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * الفحص المجاني: يتحقق من صلاحية المفتاح دون استهلاك رصيد التوليد.
 * - kie.ai   : GET /api/v1/chat/credit (يعيد الرصيد المتاح)
 * - CometAPI : /v1/dashboard/billing/credit_grants ثم /v1/models كبديل
 * نجاح الفحص يعيد تفعيل المفتاح تلقائيًا (يشمل المفاتيح المستنزفة بعد الشحن).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const key = await getKey(id);
    if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });

    try {
      const result = await adapters[key.provider].checkKey(key.apiKey);
      if (result.ok) {
        await markKeyChecked(id, true, result.message);
        await setKeyStatus(id, "active", null);
      } else {
        await markKeyChecked(id, false, result.message);
      }
      const updated = await getKey(id);
      return NextResponse.json({
        ok: result.ok,
        message: result.message,
        balance: result.balance ?? null,
        key: updated ? toPublic(updated) : null,
      });
    } catch (err) {
      const { cls, message } = classifyProviderError(err);
      await markKeyChecked(id, false, message);
      if (cls === "disabled") await setKeyStatus(id, "disabled", message);
      if (cls === "exhausted") await setKeyStatus(id, "exhausted", message);
      const updated = await getKey(id);
      return NextResponse.json(
        {
          ok: false,
          message: `فشل الفحص (${cls === "disabled" ? "مفتاح غير صالح" : cls === "exhausted" ? "خلص الرصيد" : cls === "temporary" ? "خطأ شبكة/سيرفر مؤقت" : "خطأ غير متوقع"}): ${message}`,
          key: updated ? toPublic(updated) : null,
        },
        { status: 200 }
      );
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "check failed" }, { status: 500 });
  }
}
