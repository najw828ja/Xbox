"use client";

import { useSyncExternalStore } from "react";
import { Palette, Moon, Sun, Database, Zap } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ServerConnection } from "@/components/server-connection";
import { KeysManager } from "@/components/keys-manager";
import { TasksPanel } from "@/components/tasks-panel";
import { usePoll } from "@/hooks/use-poll";
import type { HealthResponse, KeysResponse, TasksResponse } from "@/lib/client-types";

const noopSubscribe = () => () => {};

export default function Home() {
  const keys = usePoll<KeysResponse>("/api/keys", 5000);
  const tasks = usePoll<TasksResponse>("/api/tasks?limit=10", 6000);
  const health = usePoll<HealthResponse>("/api/health", 20000);

  return (
    <div className="page-bg flex min-h-screen flex-col">
      <Header dbOk={health.data?.ok} tasksTotal={tasks.data?.stats.total} />

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 pb-10 sm:px-6">
        <Hero />

        <ServerConnection health={health.data} />
        <KeysManager data={keys.data} loading={keys.loading} refresh={keys.refresh} />
        <TasksPanel data={tasks.data} loading={tasks.loading} />
      </main>

      <Footer />
    </div>
  );
}

function Header({ dbOk, tasksTotal }: { dbOk?: boolean; tasksTotal?: number }) {
  const { theme, setTheme } = useTheme();
  // صالح للترطيب: false على السيرفر، true بعد الترطيب
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  return (
    <header className="sticky top-0 z-40 border-b bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-primary/15 text-primary">
            <Palette className="size-5" />
          </span>
          <div>
            <h1 className="text-base font-extrabold leading-tight sm:text-lg">مولد الصور والفيديو عبر MCP</h1>
            <p className="text-[11px] text-muted-foreground">kie.ai + CometAPI — تبديل تلقائي بين المفاتيح · تخزين في Turso</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              dbOk === undefined
                ? "hidden sm:inline-flex"
                : dbOk
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-red-500/40 bg-red-500/10 text-red-400"
            }
          >
            <Database className="size-3.5" />
            {dbOk === undefined ? "جارٍ الفحص…" : dbOk ? "Turso متصل" : "Turso غير متصل"}
          </Badge>
          {typeof tasksTotal === "number" && tasksTotal > 0 && (
            <Badge variant="outline" className="hidden border-primary/30 text-primary sm:inline-flex">
              <Zap className="size-3.5" /> {tasksTotal} مهمة
            </Badge>
          )}
          {mounted && (
            <Button variant="outline" size="icon" className="size-9" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="تبديل المظهر">
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="pt-6">
      <h2 className="text-2xl font-extrabold leading-snug sm:text-3xl">
        ولّد الصور والفيديو <span className="text-primary">من داخل الدردشة</span> — والسيرفر يتولى الباقي
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base">
        واجهة بسيطة لإدارة المفاتيح فقط: أضف مفاتيح kie.ai و CometAPI، واربط الدردشة برابط MCP أدناه.
        التوليد يحدث في الخلفية مع تبديل تلقائي بين المفاتيح عند أي خطأ، وكل روابط النتائج والحالات تُخزَّن في قاعدة بيانات Turso
        ليتمكن النموذج من جلبها ومتابعتها بسهولة.
      </p>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-auto border-t bg-background/60 py-4">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 text-xs text-muted-foreground sm:px-6">
        <span>سيرفر MCP بمعمارية Streamable HTTP — متوافق مع Claude Desktop و ChatGPT و GPT Agents SDK و Cursor و Windsurf و Cline</span>
        <code className="font-mono" dir="ltr">POST /mcp</code>
      </div>
    </footer>
  );
}
