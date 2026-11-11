/**
 * ترحيل لمرة واحدة وفق سياسة «لا مفتاح يتوقف»:
 * إعادة كل المفاتيح الموسومة تلقائيًا (exhausted/disabled من المنطق القديم) إلى active
 * لتعود للدورة. من الآن فصاعدًا لا يوجد أي تعطيل تلقائي — اليدوي فقط.
 */
import { getTurso, ensureSchema } from "../src/lib/turso";

async function main() {
  await ensureSchema();
  const before = await getTurso().execute("SELECT id, provider, status FROM api_keys");
  console.log("قبل:", before.rows.map((r) => `${String(r.provider)}:${String(r.status)}`).join(", ") || "(لا مفاتيح)");
  const res = await getTurso().execute({
    sql: `UPDATE api_keys SET status = 'active', last_error = NULL WHERE status IN ('exhausted', 'disabled') RETURNING id`,
  });
  console.log(`أُعيد تنشيط ${res.rows.length} مفتاحًا`);
  const after = await getTurso().execute("SELECT provider, status, COUNT(*) AS n FROM api_keys GROUP BY provider, status");
  console.log("بعد:", after.rows.map((r) => `${String(r.provider)}:${String(r.status)}=${Number(r.n)}`).join(", ") || "(لا مفاتيح)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
