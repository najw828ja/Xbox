// تنظيف بيانات الاختبار من Turso (مهام الدمج + صفوف tasks الخاصة بالدمج)
import { createClient } from "@libsql/client";
import fs from "fs";

// قراءة .env يدويًا
const env = fs.readFileSync("/home/z/my-project/.env", "utf-8");
const vars = {};
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) vars[m[1]] = m[2].trim();
}

const db = createClient({
  url: vars.TURSO_DATABASE_URL,
  authToken: vars.TURSO_AUTH_TOKEN,
});

// مهام دمج اليوم فقط (الاختبارات كلها اليوم)
const jobs = await db.execute("SELECT id FROM merge_jobs WHERE created_at >= '2026-11-10'");
for (const row of jobs.rows) {
  const id = String(row.id);
  await db.batch(
    [
      { sql: "DELETE FROM merge_jobs WHERE id = ?", args: [id] },
      { sql: "DELETE FROM merge_sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM merge_source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM merge_output_chunks WHERE job_id = ?", args: [id] },
    ],
    "write"
  );
  console.log("deleted merge job:", id);
}

// صفوف tasks الخاصة بمهام الدمج التجريبية (provider = merger)
const tasks = await db.execute({ sql: "SELECT id FROM tasks WHERE provider = 'merger' AND created_at >= '2026-11-10'", args: [] });
for (const row of tasks.rows) {
  await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [String(row.id)] });
  console.log("deleted task:", String(row.id));
}

// تأكيد نهائي: لا بقايا اختبارية
const left1 = await db.execute("SELECT COUNT(*) AS n FROM merge_jobs");
const left2 = await db.execute("SELECT COUNT(*) AS n FROM merge_output_chunks");
const left3 = await db.execute("SELECT COUNT(*) AS n FROM tasks WHERE provider='merger'");
console.log("remaining merge_jobs:", Number(left1.rows[0].n), "| output_chunks:", Number(left2.rows[0].n), "| merger tasks:", Number(left3.rows[0].n));
console.log("keys preserved:");
const keys = await db.execute("SELECT id, provider, status, usage_count FROM api_keys");
for (const k of keys.rows) console.log(" ", k.id, k.provider, k.status, k.usage_count);
