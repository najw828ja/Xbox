// اختبار سريع للاتصال بـ Turso وkie.ai قبل البناء
import { createClient } from "@libsql/client";

const TURSO_URL = process.env.T1!;
const TURSO_TOKEN = process.env.T2!;

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const r = await db.execute("SELECT 1 AS one");
console.log("turso ok:", r.rows[0].one === 1);

const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
console.log("tables:", tables.rows.map(t => t.name).join(", ") || "(none)");

// اختبار kie.ai: فحص الرصيد (نداء خفيف)
const KIE = process.env.K1!;
const rr = await fetch("https://api.kie.ai/api/v1/generate/balance", { headers: { Authorization: `Bearer ${KIE}` } });
const txt = await rr.text();
console.log("kie balance:", rr.status, txt.slice(0, 300));
