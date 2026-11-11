/**
 * اختبار سياسة «لا مفتاح يتوقف» النهائي عبر عميل MCP رسمي:
 * 1) إضافة مفتاح وهمي (سيحتل مقدمة الدورة كأقل استخدامًا)
 * 2) توليد صورة → الوهمي يفشل 401 → تبديل تلقائي للمفتاح الحقيقي → اكتمال بنفس task_id
 * 3) التحقق: المفتاح الوهمي ما زال «active»، لا ذِكر لأي خطأ مفتاح/رصيد للعميل
 * يُشغَّل: bun scripts/test-key-failover.ts (والسيرفر يعمل على :3000)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_TEST_URL || "http://localhost:3000/mcp";
const API = "http://localhost:3000/api";
const BOGUS = "sk-bogus-failover-test-key-000000000000";

async function main() {
  // 1) إضافة المفتاح الوهمي عبر REST
  const addRes = await fetch(`${API}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "kie", key: BOGUS, label: "FAKEOVERRIDE-TEST" }),
  });
  const added = (await addRes.json()) as { key?: { id: string; label: string; status: string } };
  const fake = added.key;
  if (!fake) throw new Error(`فشل إضافة المفتاح الوهمي: ${JSON.stringify(added).slice(0, 200)}`);
  console.log("1) أُضيف المفتاح الوهمي:", fake.id.slice(0, 8), "— الحالة:", fake.status);

  try {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const client = new Client({ name: "failover-test", version: "1.0.0" });
    await client.connect(transport);

    // 2) توليد صورة — المفتاح الوهمي أولًا ثم التبديل التلقائي
    console.log("2) generate_image (المفتاح الوهمي أولًا في الدورة)…");
    const t0 = Date.now();
    const res = await client.callTool(
      {
        name: "generate_image",
        arguments: {
          prompt: "a single small red circle centered on a plain white background, minimalist flat design",
          resolution: "1K",
          wait_seconds: 150,
        },
      },
      undefined,
      { onprogress: (p) => console.log("   PROGRESS:", JSON.stringify(p).slice(0, 160)), timeout: 200_000 }
    );
    const secs = Math.round((Date.now() - t0) / 1000);
    const text = (res.content as Array<{ text: string }>)[0].text;
    console.log(`3) النتيجة بعد ${secs} ثانية — isError:`, res.isError);
    console.log("---");
    console.log(text.slice(0, 700));
    console.log("---");

    // 3) التحققات
    if (res.isError) throw new Error("المهمة فشلت — التبديل التلقائي لم يعمل!");
    if (!text.includes("✅")) throw new Error("لا توجد علامة اكتمال");
    if (/balance|exhausted|insufficient|رصيد|خلص/i.test(text)) throw new Error("نص الاستجابة يذكر الرصيد/المفاتيح للعميل!");

    // 4) المفتاح الوهمي ما زال نشطًا (لم يُعطَّل تلقائيًا)
    await new Promise((r) => setTimeout(r, 1500));
    const list = (await (await fetch(`${API}/keys`)).json()) as {
      keys: Array<{ id: string; label: string; status: string; usageCount: number; failCount: number }>;
    };
    const fakeAfter = list.keys.find((k) => k.id === fake.id);
    console.log("4) المفتاح الوهمي بعد العملية — الحالة:", fakeAfter?.status, "| استخدامات:", fakeAfter?.usageCount, "| إخفاقات:", fakeAfter?.failCount);
    if (fakeAfter?.status !== "active") throw new Error(`المفتاح الوهمي تغيّرت حالته إلى ${fakeAfter?.status} — يجب أن يبقى نشطًا!`);

    // 5) التحقق من سجل المحاولات في قاعدة البيانات (وهمي فاشل + حقيقي ناجح)
    const tasks = (await (await fetch(`${API}/tasks?limit=3`)).json()) as {
      tasks: Array<{ id: string; status: string; attempts: Array<{ keyLabel: string; ok: boolean; errorClass?: string }> }>;
    };
    const t = tasks.tasks[0];
    console.log("5) آخر مهمة:", t.id.slice(0, 8), "— الحالة:", t.status, "— المحاولات:", t.attempts.map((a) => `${a.keyLabel}:${a.ok ? "ok" : "fail"}`).join(" → "));
    if (t.status !== "completed") throw new Error("المهمة ليست مكتملة");
    const labels = t.attempts.map((a) => a.keyLabel);
    const hasFakeFail = t.attempts.some((a) => a.keyLabel.includes("FAKEOVERRIDE") && !a.ok);
    const hasRealOk = t.attempts.some((a) => !a.keyLabel.includes("FAKEOVERRIDE") && a.ok);
    console.log("   سجل المحاولات الكامل:", t.attempts.map((a) => `${a.keyLabel}:${a.ok ? "ok" : "fail(" + a.errorClass + ")"}`).join(" → "));
    if (!hasFakeFail || !hasRealOk) {
      throw new Error("سجل المحاولات لا يُظهر التبديل من الوهمي (فاشل) إلى الحقيقي (ناجح)");
    }

    await client.close();
    console.log("KEY FAILOVER TEST PASSED ✓ — لا مفتاح يتوقف، والمهمة تكمل تلقائيًا");
  } finally {
    // تنظيف: حذف المفتاح الوهمي
    await fetch(`${API}/keys/${fake.id}`, { method: "DELETE" });
    console.log("(تنظيف) حُذف المفتاح الوهمي");
  }
}

main().catch((e) => {
  console.error("KEY FAILOVER TEST FAILED:", e);
  process.exit(1);
});
