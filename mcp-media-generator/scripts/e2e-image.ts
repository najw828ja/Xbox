import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_TEST_URL || "http://localhost:3100/mcp";
const t = new StreamableHTTPClientTransport(new URL(url));
const c = new Client({ name: "e2e", version: "1.0.0" });
await c.connect(t);
console.log("calling generate_image (wait inline)...");
const r = await c.callTool(
  { name: "generate_image", arguments: { prompt: "a cute orange cat astronaut floating in space, digital art", wait_seconds: 150 } },
  undefined,
  { onprogress: (p) => console.log("progress:", Math.round((p.progress ?? 0)), "%"), timeout: 240_000 }
);
const text = (r.content as Array<{ text: string }>)[0].text;
console.log("isError:", r.isError);
console.log(text.slice(0, 600));
await c.close();
