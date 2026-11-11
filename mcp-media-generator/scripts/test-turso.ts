/** اختبار سريع: الاتصال بـ Turso + إنشاء الجداول + كتابة وقراءة ثم تنظيف */
import { ensureSchema, getTurso, dbHealthy } from "../src/lib/turso";

async function main() {
  console.log("healthy:", await dbHealthy());
  await ensureSchema();

  // كتابة اختبارية
  const id = `test-${Date.now()}`;
  await getTurso().execute({
    sql: "INSERT INTO tasks (id, provider, model, type, prompt, status) VALUES (?, 'kie', 'gpt-image-2-6/flare-text-to-image', 'image', 'اختبار اتصال', 'completed')",
    args: [id],
  });
  const read = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  console.log("insert+select ok, rows:", read.rows.length, "prompt:", String(read.rows[0]?.prompt));

  await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
  console.log("cleanup ok");

  const keys = await getTurso().execute("SELECT COUNT(*) AS n FROM api_keys");
  console.log("api_keys count:", Number((keys.rows[0] as Record<string, unknown>).n));
  console.log("ALL TURSO TESTS PASSED");
}

main().catch((e) => {
  console.error("TURSO TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
