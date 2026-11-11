/**
 * اختبار أداة merge_videos عبر عميل MCP رسمي:
 * 1) رفض أقل من مقطعَين   2) task_ids غير موجودة   3) مسار الفشل الشبكي (إنشاء مهمة في Turso ثم فشل الخدمة)
 * يُشغَّل: bun scripts/test-merge-tool.ts (والسيرفر يعمل على :3000)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_TEST_URL || "http://localhost:3000/mcp";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "merge-tool-test", version: "1.0.0" });
  await client.connect(transport);

  // 1) تحقق: رابط واحد فقط → رفض فوري بدون لمس الخدمة
  const tooFew = await client.callTool({ name: "merge_videos", arguments: { urls: ["https://x.com/a.mp4"] } });
  console.log("1) urls=1 → isError:", tooFew.isError, "|", (tooFew.content as Array<{ text: string }>)[0].text.split("\n")[0].slice(0, 100));

  // 2) task_ids غير موجودة → رفض مع تفاصيل
  const badIds = await client.callTool({
    name: "merge_videos",
    arguments: { task_ids: ["00000000-0000-0000-0000-000000000000", "11111111-1111-1111-1111-111111111111"] },
  });
  console.log("2) task_ids غير موجودة → isError:", badIds.isError, "|", (badIds.content as Array<{ text: string }>)[0].text.split("\n").slice(0, 4).join(" | ").slice(0, 220));

  // 3) مسار الفشل الشبكي: روابط صالحة شكلًا → مهمة تُسجَّل في Turso ثم تفشل بخطأ واضح
  const attempt = await client.callTool(
    { name: "merge_videos", arguments: { urls: ["https://example.com/clip1.mp4", "https://example.com/clip2.mp4"], resolution: "720p", fps: 30, wait_seconds: 4 } },
    undefined,
    { timeout: 90_000 }
  );
  const txt = (attempt.content as Array<{ text: string }>)[0].text;
  console.log("3) محاولة دمج → isError:", attempt.isError);
  console.log("--- نص الاستجابة ---");
  console.log(txt.slice(0, 500));
  const taskIdMatch = txt.match(/task_id:\s*([0-9a-f-]{36})/);

  // 4) get_task على مهمة الدمج الناتجة (تعمل حتى بعد الفشل — حالة نهائية من Turso)
  if (taskIdMatch) {
    const follow = await client.callTool({ name: "get_task", arguments: { task_id: taskIdMatch[1] } });
    const ftxt = (follow.content as Array<{ text: string }>)[0].text;
    console.log("4) get_task للمهمة → isError:", follow.isError, "|", ftxt.split("\n")[0].slice(0, 140));
    if (!ftxt.includes("Merged video")) throw new Error("get_task لم يعرض تسمية Merged video");
  } else {
    throw new Error("لم يُعثر على task_id في استجابة الدمج");
  }

  // 5) list_media مع فلتر type=merge
  const listing = await client.callTool({ name: "list_media", arguments: { type: "merge", limit: 5 } });
  console.log("5) list_media type=merge →", (listing.content as Array<{ text: string }>)[0].text.split("\n")[0].slice(0, 100));

  await client.close();
  console.log("MERGE TOOL TESTS PASSED");
}

main().catch((e) => {
  console.error("MERGE TOOL TEST FAILED:", e);
  process.exit(1);
});
