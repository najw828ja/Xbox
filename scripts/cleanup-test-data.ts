// تنظيف آثار الاختبار من قاعدة Turso: حذف مهام الاختبار + المفتاح الوهمي فقط
// (يبقى المفتاح الحقيقي للمستخدم نشطًا وجاهزًا للاستخدام)
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.T1!, authToken: process.env.T2! });

const delTasks = await db.execute("DELETE FROM tasks");
console.log("deleted tasks rows:", delTasks.rowsAffected);
const delFake = await db.execute({ sql: "DELETE FROM api_keys WHERE api_key LIKE 'FAKEOVERRIDE%'", args: [] });
console.log("deleted fake keys:", delFake.rowsAffected);
const left = await db.execute("SELECT label, provider, status FROM api_keys ORDER BY created_at ASC");
console.log("remaining keys:", JSON.stringify(left.rows));
const t = await db.execute("SELECT COUNT(*) AS c FROM tasks");
console.log("tasks remaining:", t.rows[0].c);
