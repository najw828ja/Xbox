/** فحص سبب فشل آخر المهام — قراءة attempts_json من قاعدة البيانات */
import { getTurso, ensureSchema } from "../src/lib/turso";

async function main() {
  await ensureSchema();
  const res = await getTurso().execute(
    "SELECT id, model, provider, status, error_message, attempts_json, created_at FROM tasks ORDER BY created_at DESC LIMIT 6"
  );
  for (const r of res.rows) {
    console.log("──────────────────────────────");
    console.log("id:", String(r.id).slice(0, 8), "| model:", String(r.model), "| status:", String(r.status));
    console.log("error:", String(r.error_message ?? "-").slice(0, 200));
    try {
      const attempts = JSON.parse(String(r.attempts_json ?? "[]"));
      for (const a of attempts) {
        console.log(`  attempt → provider=${a.provider} ok=${a.ok} class=${a.errorClass ?? "-"}`);
        console.log(`  error: ${String(a.error ?? "-").slice(0, 400)}`);
      }
    } catch { /* ignore */ }
  }
  const keys = await getTurso().execute("SELECT provider, label, status, usage_count, fail_count, last_error FROM api_keys");
  console.log("══════════════ KEYS ══════════════");
  for (const k of keys.rows) {
    console.log(`[${k.provider}] ${k.label} status=${k.status} used=${k.usage_count} fails=${k.fail_count}`);
    console.log("  last_error:", String(k.last_error ?? "-").slice(0, 400));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
