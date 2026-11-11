"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Link2, Terminal, Bot, MonitorSmartphone, Info } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/copy-button";
import type { HealthResponse } from "@/lib/client-types";

const TOOL_CHIPS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة — gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو — grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج عدة فيديوهات في مقطع واحد — بروابط أو task_ids" },
  { name: "get_task", desc: "متابعة حالة المهمة من قاعدة البيانات (كل ~10 ثوانٍ)" },
  { name: "list_media", desc: "جلب أحدث الروابط المخزنة في قاعدة البيانات" },
];

const noopSubscribe = () => () => {};

export function ServerConnection({ health }: { health: HealthResponse | null }) {
  // قراءة آمنة للترطيب: قيمة العميل فقط بعد الترطيب، والسيرفر يرى ""
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");

  const mcpUrl = origin ? `${origin}/mcp` : "";
  const authRequired = health?.authRequired ?? false;

  const chatgptConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            "media-generator": {
              url: mcpUrl || "https://YOUR-DOMAIN/mcp",
              ...(authRequired ? { headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } : {}),
            },
          },
        },
        null,
        2
      ),
    [mcpUrl, authRequired]
  );

  const claudeConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            "media-generator": {
              type: "http",
              url: mcpUrl || "https://YOUR-DOMAIN/mcp",
              ...(authRequired ? { headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } : {}),
            },
          },
        },
        null,
        2
      ),
    [mcpUrl, authRequired]
  );

  const cursorConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            "media-generator": {
              url: mcpUrl || "https://YOUR-DOMAIN/mcp",
              ...(authRequired ? { headers: { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } } : {}),
            },
          },
        },
        null,
        2
      ),
    [mcpUrl, authRequired]
  );

  return (
    <Card className="border-primary/25 shadow-lg shadow-primary/5">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
              <Link2 className="size-5" />
            </span>
            <div>
              <CardTitle className="text-xl">ربط السيرفر</CardTitle>
            </div>
          </div>
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
            Streamable HTTP · مواصفات MCP
          </Badge>
        </div>
        <CardDescription>
          انسخ الرابط أدناه وأضفه لأي أداة تدعم MCP — Claude Desktop، ChatGPT (Custom MCP servers)، GPT Agents SDK، Cursor، Windsurf، Cline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* رابط MCP جاهز للنسخ */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-muted-foreground">رابط خادم MCP</label>
          <div className="flex gap-2" dir="ltr">
            <Input
              readOnly
              value={mcpUrl || "…"}
              className="font-mono text-sm bg-muted/40 select-all"
              aria-label="MCP server URL"
            />
            <CopyButton value={mcpUrl} label="نسخ الرابط" />
          </div>
        </div>

        {/* إعدادات JSON */}
        <Tabs defaultValue="chatgpt">
          <TabsList className="flex h-auto w-full flex-col items-stretch gap-1 sm:h-9 sm:w-fit sm:flex-row">
            <TabsTrigger value="chatgpt" className="gap-1.5 sm:w-auto">
              <Bot className="size-4" /> ChatGPT / GPT Agents
            </TabsTrigger>
            <TabsTrigger value="claude" className="gap-1.5 sm:w-auto">
              <Terminal className="size-4" /> Claude Desktop
            </TabsTrigger>
            <TabsTrigger value="ide" className="gap-1.5 sm:w-auto">
              <MonitorSmartphone className="size-4" /> Cursor / Windsurf / Cline
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chatgpt" className="space-y-2 pt-3">
            <p className="text-sm text-muted-foreground">
              في ChatGPT: <span className="text-foreground font-medium">Settings → Connectors → Create → Custom MCP server</span> وضع نفس الرابط في «Server URL». ولعملاء GPT Agents SDK استخدم الـ JSON التالي كما هو:
            </p>
            <JsonBlock value={chatgptConfig} />
          </TabsContent>

          <TabsContent value="claude" className="space-y-2 pt-3">
            <p className="text-sm text-muted-foreground">
              ضع الـ JSON في <span className="font-mono text-xs" dir="ltr">claude_desktop_config.json</span> أو أضف الرابط من Connectors مباشرة:
            </p>
            <JsonBlock value={claudeConfig} />
          </TabsContent>

          <TabsContent value="ide" className="space-y-2 pt-3">
            <p className="text-sm text-muted-foreground">
              نفس الصيغة تعمل مع Cursor (mcp.json) و Windsurf و Cline:
            </p>
            <JsonBlock value={cursorConfig} />
          </TabsContent>
        </Tabs>

        {/* الأدوات المتاحة */}
        <div className="space-y-2">
          <p className="text-sm font-semibold text-muted-foreground">الأدوات المتاحة للنموذج</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {TOOL_CHIPS.map((t) => (
              <div key={t.name} className="flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5">
                <code className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-semibold text-primary" dir="ltr">
                  {t.name}
                </code>
                <span className="text-xs text-muted-foreground leading-5">{t.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ملاحظة متابعة ChatGPT */}
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            الفيديو يحتاج دقائق: يعيد السيرفر <code className="font-mono text-xs" dir="ltr">task_id</code> فورًا،
            ويتابَع تلقائيًا بـ <code className="font-mono text-xs" dir="ltr">get_task</code> كل 10 ثوانٍ —
            وعند اكتمال المهمة يعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function JsonBlock({ value }: { value: string }) {
  return (
    <div className="relative rounded-lg border bg-muted/40 p-3">
      <pre className="json-block nice-scroll max-h-64 overflow-auto pt-10" aria-label="MCP configuration JSON">
        {value}
      </pre>
      <div className="absolute left-2 top-2">
        <CopyButton value={value} size="sm" variant="secondary" label="نسخ JSON" />
      </div>
    </div>
  );
}
