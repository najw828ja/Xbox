/** حذف مهام الدمج التجريبية (مقاطع w3schools التجريبية) من Turso */
import { getTurso, ensureSchema } from "../src/lib/turso";

async function main() {
  await ensureSchema();
  const res = await getTurso().execute({
    sql: `DELETE FROM tasks WHERE type = 'merge' AND prompt LIKE '%دمج 2 مقاطع%' RETURNING id`,
  });
  console.log(`deleted ${res.rows.length} test merge task(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
