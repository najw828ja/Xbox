/**
 * نقطة نهاية MCP — Streamable HTTP عبر الـ SDK الرسمي @modelcontextprotocol/sdk
 *
 * وفق متطلبات المواصفة: نستخدم Server الرسمي + WebStandardStreamableHTTPServerTransport
 * (نسخة Web Standards تعمل مباشرة مع Request/Response في App Router) — بلا JSON-RPC يدوي.
 *
 * POST   /mcp : initialize | tools/list | tools/call | ping | notifications/*
 *        — استدعاءات الأدوات تُبَث عبر SSE مع notifications/progress أثناء التوليد
 *          (إن زوّد العميل الطلب بـ _meta.progressToken) مع keepalive كل 15 ثانية.
 * GET    /mcp : 405 (لا نوفر قنوات server-initiated في الوضع عديم الجلسة)
 * DELETE /mcp : 200 (إنهاء الجلسة)
 *
 * وضع stateless: كل طلب يستقل بخادم ونقله خاصين به — لا حالات في الذاكرة،
 * وهذا هو النمط المعتمد للعمل على Vercel serverless حيث لا تدوم الذاكرة بين الاستدعاءات.
 * حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يلزم Authorization: Bearer <token>.
 */
import { NextRequest } from "next/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, SERVER_INFO, SERVER_INSTRUCTIONS, callTool } from "@/lib/mcp/tools";
import type { ProgressCb } from "@/lib/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** على Vercel: أقصى مدة تنفيذ للدالة (استدعاءات الدمج/الفيديو الطويلة تحتاج وقتًا) */
export const maxDuration = 300;

/** مهلة تنظيف أمان: أقصى انتظار للأداة 240 ثانية + هامش للبث والاستجابة */
const SAFETY_CLEANUP_MS = 330_000;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkAuth(req: NextRequest): boolean {
  const token = process.env.MCP_ACCESS_TOKEN?.trim();
  if (!token) return true;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

/**
 * يبني خادم MCP رسميًا (Server من الـ SDK) ويسجّل معالجات tools/list و tools/call.
 * تُستدعى منطق الأدوات من callTool الموحّد في src/lib/mcp/tools.ts —
 * ونتائج الاستدعاء تُصاغ بالعربية هناك.
 */
function createMcpServer(): Server {
  const server = new Server(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: {
      tools: { listChanged: false },
      logging: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // إشعارات التقدم — فقط لو طلب العميل progressToken عبر _meta
    const progressToken = (request.params._meta as { progressToken?: string | number } | undefined)?.progressToken;
    const sendProgress: ProgressCb | undefined =
      progressToken === undefined
        ? undefined
        : async (info) => {
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: info.progress,
                  ...(info.total !== undefined ? { total: info.total } : {}),
                  ...(info.message
                    ? { message: `${info.message}${info.percent !== undefined ? ` (${info.percent}%)` : ""}` }
                    : {}),
                },
              });
            } catch {
              // العميل قطع الاتصال أو واجهة النقل مغلقة — نتجاهل بصمت
            }
          };

    try {
      // ToolCallResult يطابق CallToolResult بنيويًا — نقص في الادعاء الإلزامي «task» (خاص بالمهام الجارية في الـ SDK)
      return (await callTool(String(name ?? ""), (args as Record<string, unknown>) ?? {}, {
        sendProgress,
        signal: extra.signal,
      })) as unknown as ServerResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // أي انهيار غير متوقع يُعاد كخطأ أداة بالعربية — لا نُسقط الاتصال أبدًا
      return {
        content: [{ type: "text", text: `❌ خطأ داخلي غير متوقع: ${msg}` }],
        isError: true,
      } as unknown as ServerResult;
    }
  });

  return server;
}

/** يبني ثنائي (خادم + نقل) عديم الجلسة لطلب واحد مع تنظيف أمان مؤجّل */
function createStatelessPair() {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // وضع stateless: لا جلسات في الذاكرة — النمط المعتمد لبيئات serverless
    sessionIdGenerator: undefined,
  });
  const cleanup = () => {
    try {
      void transport.close();
    } catch { /* مغلق مسبقًا */ }
    try {
      void server.close();
    } catch { /* مغلق مسبقًا */ }
  };
  const timer = setTimeout(cleanup, SAFETY_CLEANUP_MS);
  // لا تُبقِ عملية Node حية لمجرد المؤقت (على Vercel الدالة تُجمَّد بعد الرد)
  (timer as { unref?: () => void }).unref?.();
  return { server, transport, cleanup, timer };
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return jsonResponse(
      { error: "unauthorized: set MCP_ACCESS_TOKEN on the server and send Authorization: Bearer <token>" },
      401
    );
  }

  const { server, transport, cleanup, timer } = createStatelessPair();
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    // تنظيف فوري عند إجهاض العميل للاتصال
    req.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        cleanup();
      },
      { once: true }
    );
    return response;
  } catch (err) {
    clearTimeout(timer);
    cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${msg}` } }, 400);
  }
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return jsonResponse({ error: "unauthorized" }, 401);
  // في الوضع عديم الجلسة لا نوفر قناة SSE يقودها السيرفر — الـ SDK يرد 405 وفق المواصفة
  const { server, transport, cleanup, timer } = createStatelessPair();
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return jsonResponse({ error: "unauthorized" }, 401);
  // إنهاء الجلسة — لا حالات نحذفها فعليًا في الوضع عديم الجلسة، نرد 200 لإنهاء نظيف
  return new Response(null, { status: 200 });
}
