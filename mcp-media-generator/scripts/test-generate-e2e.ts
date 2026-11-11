/**
 * اختبار E2E حقيقي عبر عميل MCP الرسمي — نفس مسار Claude/ChatGPT:
 * 1) generate_image (gpt-image-2-6/flare-text-to-image عبر kie) مع onprogress
 * 2) get_task كل 10 ثوانٍ لو عادت مهمة قيد المعالجة
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_TEST_URL || "http://localhost:3000/mcp";
const kind = (process.argv[2] || "image") as "image" | "video";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  await client.connect(transport);
  console.log("connected");

  const args =
    kind === "image"
      ? {
          prompt: "A tiny red apple on a plain white background, minimal, clean studio photo",
          wait_seconds: 90,
        }
      : {
          prompt: "A small orange tabby kitten playing with a ball of yarn, cozy warm light",
          duration: 1,
          resolution: "480p",
          wait_seconds: 30,
        };

  let progressCount = 0;
  const result = await client.callTool(
    { name: kind === "image" ? "generate_image" : "generate_video", arguments: args },
    undefined,
    {
      timeout: 200_000,
      onprogress: (p) => {
        progressCount++;
        console.log(`  [progress #${progressCount}]`, JSON.stringify(p));
      },
    }
  );
  console.log("progress notifications received:", progressCount);
  console.log("isError:", result.isError === true);
  console.log("---- RESULT TEXT ----");
  for (const c of result.content as Array<{ type: string; text: string }>) {
    console.log(c.text);
  }

  // لو ما زالت قيد المعالجة — تابع كل 10 ثوانٍ مثل ChatGPT
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  const match = text.match(/task_id[":\s]+([0-9a-f-]{36})/i);
  if (match && !result.isError && /PROCESSING|PENDING/i.test(text)) {
    const taskId = match[1];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const t = await client.callTool({ name: "get_task", arguments: { task_id: taskId } });
      const tt = (t.content as Array<{ text: string }>)[0].text;
      console.log(`[poll ${i + 1}]`, tt.split("\n")[0]);
      if (/✅|❌/.test(tt)) {
        console.log(tt);
        break;
      }
    }
  }

  await client.close();
  console.log("E2E TEST DONE");
}

main().catch((e) => {
  console.error("E2E TEST FAILED:", e);
  process.exit(1);
});
