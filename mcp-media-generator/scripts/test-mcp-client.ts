/**
 * اختبار توافق المواصفة: عميل MCP رسمي (@modelcontextprotocol/sdk)
 * يتصل عبر StreamableHTTPClientTransport — نفس مسار Claude/ChatGPT.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_TEST_URL || "http://localhost:3000/mcp";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "official-sdk-test", version: "1.0.0" });
  transport.onclose = () => console.log("[transport closed]");

  await client.connect(transport);
  console.log("1) CONNECTED — serverInfo:", JSON.stringify(client.getServerVersion()));

  const tools = await client.listTools();
  console.log("2) TOOLS:", tools.tools.map((t) => t.name).join(", "));

  // استدعاء مع تتبع إشعارات التقدم (كما يفعل Claude Desktop)
  const result = await client.callTool(
    { name: "get_task", arguments: { task_id: "probe-from-official-sdk" } },
    undefined,
    {
      onprogress: (p) => console.log("   PROGRESS:", JSON.stringify(p)),
      timeout: 60_000,
    }
  );
  console.log("3) get_task → isError:", result.isError, "| text:", (result.content as Array<{ text: string }>)[0].text.slice(0, 80));

  const listing = await client.callTool({ name: "list_media", arguments: { limit: 3 } });
  console.log("4) list_media →", (listing.content as Array<{ text: string }>)[0].text.split("\n")[0]);

  await client.close();
  console.log("5) CLOSED CLEANLY");
  console.log("OFFICIAL SDK CLIENT TEST PASSED");
}

main().catch((e) => {
  console.error("SDK TEST FAILED:", e);
  process.exit(1);
});
