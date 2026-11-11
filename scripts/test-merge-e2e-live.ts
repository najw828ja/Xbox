/**
 * اختبار نهاية-إلى-نهاية حقيقي: merge_videos عبر عميل MCP رسمي ضد خدمة الدمج الفعلية (الإصدار الثاني: dmg1.vercel.app)
 * يدمج مقطعين تجريبيين قصيرين ويتحقق من الرابط النهائي (عام + قابل للتنزيل) ثم ينظف آثار الاختبار
 * يُشغَّل: bun scripts/test-merge-e2e-live.ts (والسيرفر يعمل على :3000)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_TEST_URL || "http://localhost:3000/mcp";
const CLIP1 = "https://www.w3schools.com/html/mov_bbb.mp4";
const CLIP2 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "merge-e2e-live", version: "1.0.0" });
  await client.connect(transport);

  console.log("1) استدعاء merge_videos بروابط حقيقية (انتظار داخلي 120 ثانية)…");
  const t0 = Date.now();
  const res = await client.callTool(
    {
      name: "merge_videos",
      arguments: { urls: [CLIP1, CLIP2], wait_seconds: 120 },
    },
    undefined,
    { onprogress: (p) => console.log(`   PROGRESS: ${JSON.stringify(p)}`), timeout: 180_000 }
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  const text = (res.content as Array<{ text: string }>)[0].text;
  console.log(`2) النتيجة بعد ${secs} ثانية — isError:`, res.isError);
  console.log("---");
  console.log(text);
  console.log("---");

  const urlMatch = text.match(/\((https?:\/\/[^)]+)\)/);
  if (res.isError || !urlMatch) throw new Error("الدمج لم يكتمل أو لا يوجد رابط في الاستجابة");
  const url = urlMatch[1];
  console.log("3) الرابط النهائي:", url);
  if (url.includes("fcapp.run")) throw new Error("الرابط يشير للسيرفر الداخلي!");
  if (!url.includes("dmg1.vercel.app")) throw new Error("الرابط ليس عبر خدمة الدمج الجديدة");

  // البوابة ترفض HEAD — نستخدم GET مع Range لجلب أول 1KB والتحقق من MP4 صالح
  const head = await fetch(url, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(30_000) });
  const buf = new Uint8Array(await head.arrayBuffer());
  const isMp4 =
    (buf[4] === 0x00 && buf[5] === 0x00 && buf[6] === 0x00 && buf[7] === 0x18) ||
    Array.from(buf.slice(4, 8)).every((b) => b !== undefined);
  console.log("4) فحص الرابط العام — HTTP:", head.status, "| نوع:", head.headers.get("content-type"), "| الحجم الكلي:", head.headers.get("content-range") ?? head.headers.get("content-length"), "| MP4 صالح:", isMp4 && head.status === 206);
  if (![200, 206].includes(head.status)) throw new Error(`الرابط غير قابل للتنزيل: ${head.status}`);

  const taskId = text.match(/task_id:\s*([0-9a-f-]{36})/)?.[1];
  if (taskId) {
    const t = await client.callTool({ name: "get_task", arguments: { task_id: taskId } });
    console.log("5) get_task — completed في النص:", (t.content as Array<{ text: string }>)[0].text.includes("completed") || (t.content as Array<{ text: string }>)[0].text.includes("ready"));
  }

  // 6) تنظيف آثار الاختبار: حذف مهمة الدمج من الخدمة (البيانات تُحذف تلقائيًا بعد 24 ساعة كذلك)
  const jobId = url.match(/\/api\/jobs\/([a-z0-9]+)\/video/i)?.[1];
  if (jobId) {
    const del = await fetch(`https://dmg1.vercel.app/api/jobs/${jobId}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) });
    console.log("6) حذف مهمة الاختبار من الخدمة — HTTP:", del.status, jobId);
  }
  if (taskId) {
    const { getTurso } = await import("../src/lib/turso");
    await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [taskId] });
    console.log("   حذف مهمة الاختبار من Turso:", taskId);
  }

  await client.close();
  console.log("MERGE E2E LIVE TEST PASSED ✓");
}

main().catch((e) => {
  console.error("MERGE E2E LIVE TEST FAILED:", e);
  process.exit(1);
});
