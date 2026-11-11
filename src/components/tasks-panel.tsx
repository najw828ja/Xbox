"use client";

import { Database, ExternalLink, ImageIcon, Video, Merge } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatWhen } from "@/hooks/use-poll";
import type { TasksResponse } from "@/lib/client-types";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    completed: { label: "مكتملة", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" },
    failed: { label: "فاشلة", cls: "border-red-500/40 bg-red-500/10 text-red-400" },
    processing: { label: "قيد المعالجة", cls: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
    pending: { label: "منتظرة", cls: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
  };
  const s = map[status] ?? { label: status, cls: "" };
  return (
    <Badge variant="outline" className={s.cls}>
      {s.label}
    </Badge>
  );
}

export function TasksPanel({ data, loading }: { data: TasksResponse | null; loading: boolean }) {
  const tasks = data?.tasks ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
            <Database className="size-5" />
          </span>
          <div>
            <CardTitle className="text-xl">آخر المهام — من قاعدة بيانات Turso</CardTitle>
            <CardDescription>
              كل الروابط والمعلومات مخزنة في Turso (بدون تنزيل أي وسائط على السيرفر) — وهكذا يجلبها ChatGPT عبر get_task و list_media
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            لا توجد مهام بعد — أول عملية توليد من الدردشة (عبر MCP) ستظهر هنا فورًا مع رابطها ومعرّفها
          </p>
        ) : (
          <ScrollArea className="nice-scroll">
            <div className="max-h-96 space-y-2 overflow-y-auto">
              {tasks.map((t) => (
                <div key={t.id} className="rounded-lg border p-3 transition-colors hover:bg-muted/30">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {t.type === "image" ? (
                        <ImageIcon className="size-4 shrink-0 text-emerald-400" />
                      ) : t.type === "merge" ? (
                        <Merge className="size-4 shrink-0 text-sky-400" />
                      ) : (
                        <Video className="size-4 shrink-0 text-violet-300" />
                      )}
                      <StatusBadge status={t.status} />
                      <code className="truncate font-mono text-xs text-muted-foreground" dir="ltr" title={t.id}>
                        {t.id.slice(0, 8)}…
                      </code>
                      <span className="hidden truncate text-xs text-muted-foreground sm:inline" dir="ltr">
                        {t.model}
                      </span>
                      {t.provider && <Badge variant="secondary" className="text-[10px]">{t.provider}</Badge>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t.status === "processing" && <span>{t.progress}%</span>}
                      <span>{formatWhen(t.createdAt)}</span>
                      {t.status === "completed" && t.resultUrls[0] && (
                        <a
                          href={t.resultUrls[0]}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          فتح <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={t.prompt}>
                    {t.prompt}
                  </p>
                  {t.status === "failed" && t.errorMessage && (
                    <p className="mt-1 line-clamp-1 text-xs text-red-300/80" title={t.errorMessage}>
                      {t.errorMessage}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
