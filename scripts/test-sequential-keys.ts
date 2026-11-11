/**
 * اختبار الترتيب التسلسلي للمفاتيح:
 * - الترتيب حسب الإضافة (أول مفتاح ثم التالي) وليس الأقل استخدامًا
 * - المفاتيح المنتهية (exhausted) تبقى في المجموعة (لا مفتاح يتوقف)
 * - المعطّلة يدويًا فقط تُستبعد
 */
import { ensureSchema, getTurso } from "../src/lib/turso";
import { getKeyPool } from "../src/lib/keys";
import { randomUUID } from "crypto";

async function main() {
  await ensureSchema();
  const db = getTurso();
  const stamp = Date.now();
  const ids: string[] = [];

  // نضيف 3 مفاتيح kie بالترتيب: الثاني أقل استخدامًا لكن الأول يبقى أولًا (ترتيب تسلسلي)
  const inserts: Array<{ label: string; usage: number; status: string }> = [
    { label: `seq-A-${stamp}`, usage: 50, status: "active" },    // أُضيف أولًا ورصيد استخدام مرتفع
    { label: `seq-B-${stamp}`, usage: 0, status: "exhausted" },  // أُضيف ثانيًا ومنتهي الرصيد
    { label: `seq-C-${stamp}`, usage: 10, status: "active" },    // أُضيف ثالثًا
    { label: `seq-D-${stamp}`, usage: 0, status: "disabled" },   // معطّل يدويًا — يجب استبعاده
  ];
  for (const it of inserts) {
    const id = randomUUID();
    ids.push(id);
    await db.execute({
      sql: `INSERT INTO api_keys (id, provider, label, api_key, status, usage_count) VALUES (?, 'kie', ?, 'test-key-xxxx', ?, ?)`,
      args: [id, it.label, it.status, it.usage],
    });
  }

  const pool = (await getKeyPool(["kie"])).filter((k) => ids.includes(k.id));
  const order = pool.map((k) => k.label.split("-")[1]);

  let pass = true;
  // 1) الترتيب التسلسلي: A ثم B ثم C
  if (order.join(",") !== "A,B,C") {
    console.error(`FAIL: الترتيب غير تسلسلي: ${order.join(",")} (المتوقع A,B,C)`);
    pass = false;
  } else {
    console.log("PASS: الترتيب تسلسلي حسب الإضافة (A → B → C)");
  }
  // 2) المفتاح المنتهي (B) موجود في المجموعة
  if (!order.includes("B")) { console.error("FAIL: المفتاح المنتهي استُبعد — يجب أن يبقى"); pass = false; }
  else console.log("PASS: المفتاح المنتهي (exhausted) يبقى في المجموعة");
  // 3) المعطّل (D) مستبعد
  if (order.includes("D")) { console.error("FAIL: المفتاح المعطّل يدويًا موجود في المجموعة"); pass = false; }
  else console.log("PASS: المفتاح المعطّل يدويًا (disabled) مستبعد");

  // تنظيف
  for (const id of ids) await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  console.log("cleanup ok");

  if (!pass) process.exit(1);
  console.log("ALL SEQUENTIAL-POOL TESTS PASSED");
}

main().catch((e) => { console.error("TEST FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
