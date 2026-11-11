"use client";

import { useState } from "react";
import {
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  Power,
  Ban,
  ShieldCheck,
  CircleAlert,
  ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { formatWhen } from "@/hooks/use-poll";
import type { KeyStatus, KeysResponse, PublicKey } from "@/lib/client-types";

const PROVIDERS = [
  {
    id: "kie" as const,
    name: "kie.ai",
    docs: "https://kie.ai",
    hint: "احصل على مفتاح من kie.ai → API Keys",
  },
  {
    id: "cometapi" as const,
    name: "CometAPI",
    docs: "https://api.cometapi.com",
    hint: "احصل على مفتاح من لوحة CometAPI",
  },
];

function StatusBadge({ status }: { status: KeyStatus }) {
  if (status === "active")
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400" variant="outline">
        نشط
      </Badge>
    );
  if (status === "exhausted")
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-400" variant="outline">
        خلص الرصيد
      </Badge>
    );
  return (
    <Badge className="border-red-500/40 bg-red-500/10 text-red-400" variant="outline">
      معطل
    </Badge>
  );
}

export function KeysManager({
  data,
  loading,
  refresh,
}: {
  data: KeysResponse | null;
  loading: boolean;
  refresh: () => void;
}) {
  async function mutate(url: string, init: RequestInit, successMsg: string) {
    try {
      const res = await fetch(url, init);
      const json = (await res.json()) as { error?: string; message?: string; ok?: boolean };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      refresh();
      if (json.message) {
        if (json.ok) toast.success(json.message);
        else toast.warning(json.message);
      } else {
        toast.success(successMsg);
      }
      return json;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل الإجراء");
      return null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
              <KeyRound className="size-5" />
            </span>
            <div>
              <CardTitle className="text-xl">إدارة المفاتيح</CardTitle>
              <CardDescription>
                أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> تحديث
          </Button>
        </div>

        {/* شريط الإحصاءات */}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatBox label="نشطة" value={data?.stats.active ?? 0} className="text-emerald-400 border-emerald-500/25 bg-emerald-500/5" />
          <StatBox label="خلص رصيدها" value={data?.stats.exhausted ?? 0} className="text-amber-400 border-amber-500/25 bg-amber-500/5" />
          <StatBox label="معطلة" value={data?.stats.disabled ?? 0} className="text-red-400 border-red-500/25 bg-red-500/5" />
          <StatBox label="إجمالي الاستخدام" value={data?.stats.totalUsage ?? 0} className="text-primary border-primary/25 bg-primary/5" />
        </div>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-2">
        {PROVIDERS.map((p) => (
          <ProviderPanel key={p.id} providerId={p.id} name={p.name} docs={p.docs} hint={p.hint} keys={data?.keys ?? []} onMutate={mutate} />
        ))}

        <p className="text-xs leading-6 text-muted-foreground lg:col-span-2">
          سياسة «لا مفتاح يتوقف»: عند فشل أي مفتاح (رصيد · رفض · ضغط · انقطاع) ينتقل السيرفر تلقائيًا للمفتاح التالي
          ويُكمل المهمة على نفس المعرّف حتى في منتصف التوليد، وإن فشلت كلها تبقى المهمة بانتظار وتُعاد المحاولة تلقائيًا
          مع كل استعلام — فور شحن أي مفتاح تكمل من حيث توقفت. خطأ المعطيات فقط يوقف العملية لأن التبديل لن يحله.
          التعطيل اليدوي (زر الإيقاف) هو الطريقة الوحيدة لإخراج مفتاح من الدورة.
        </p>
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className={`rounded-lg border p-3 ${className ?? ""}`}>
      <div className="text-2xl font-extrabold leading-none">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ProviderPanel({
  providerId,
  name,
  docs,
  hint,
  keys,
  onMutate,
}: {
  providerId: "kie" | "cometapi";
  name: string;
  docs: string;
  hint: string;
  keys: PublicKey[];
  onMutate: (url: string, init: RequestInit, msg: string) => Promise<unknown>;
}) {
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adding, setAdding] = useState(false);
  const mine = keys.filter((k) => k.provider === providerId);
  const activeCount = mine.filter((k) => k.status === "active").length;

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) {
      toast.error("أدخل مفتاح API أولًا");
      return;
    }
    setAdding(true);
    const ok = await onMutate(
      "/api/keys",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, key: apiKey.trim(), label: label.trim() }),
      },
      "تمت إضافة المفتاح وفعّال من الآن ✓"
    );
    setAdding(false);
    if (ok) {
      setApiKey("");
      setLabel("");
    }
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 border-b p-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{name}</CardTitle>
          <Badge variant="outline" className="border-primary/30 text-primary">
            {activeCount}/{mine.length} نشط
          </Badge>
          <a href={docs} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary" aria-label={`توثيق ${name}`}>
            <ExternalLink className="size-3.5" />
          </a>
        </div>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>

      {/* نموذج الإضافة */}
      <form onSubmit={addKey} className="space-y-2 p-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <div className="space-y-1">
            <Label htmlFor={`${providerId}-label`} className="text-xs">وسم (اختياري)</Label>
            <Input id={`${providerId}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="مثل: حساب رئيسي" maxLength={60} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${providerId}-key`} className="text-xs">مفتاح API</Label>
            <Input
              id={`${providerId}-key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              className="font-mono text-xs"
              dir="ltr"
              autoComplete="off"
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={adding} className="w-full sm:w-auto">
              <Plus className="size-4" /> إضافة
            </Button>
          </div>
        </div>
      </form>

      <Separator />

      {/* قائمة المفاتيح */}
      <ScrollArea className="nice-scroll">
        <div className="max-h-96 space-y-2 overflow-y-auto p-4">
          {mine.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              لا توجد مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد
            </p>
          )}
          {mine.map((k) => (
            <KeyRow key={k.id} k={k} onMutate={onMutate} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function KeyRow({
  k,
  onMutate,
}: {
  k: PublicKey;
  onMutate: (url: string, init: RequestInit, msg: string) => Promise<unknown>;
}) {
  const [checking, setChecking] = useState(false);
  const [acting, setActing] = useState(false);

  async function check() {
    setChecking(true);
    await onMutate(`/api/keys/${k.id}/check`, { method: "POST" }, "تم الفحص");
    setChecking(false);
  }
  async function patch(action: "activate" | "disable" | "markExhausted", msg: string) {
    setActing(true);
    await onMutate(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }, msg);
    setActing(false);
  }
  async function remove() {
    setActing(true);
    await onMutate(`/api/keys/${k.id}`, { method: "DELETE" }, "حُذف المفتاح");
    setActing(false);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="rounded-lg border p-3 transition-colors hover:bg-muted/30">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge status={k.status} />
              <span className="truncate text-sm font-semibold">{k.label || "بدون وسم"}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" dir="ltr">
              <code className="font-mono">{k.keyMasked}</code>
              <span dir="rtl">استُخدم {k.usageCount}×</span>
              <span dir="rtl" className="text-emerald-500">نجح {k.successCount}</span>
              <span dir="rtl" className="text-red-400">فشل {k.failCount}</span>
              <span dir="rtl">آخر استخدام: {formatWhen(k.lastUsedAt)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="size-8" onClick={check} disabled={checking || acting} aria-label="فحص مجاني">
                  <ShieldCheck className={`size-4 ${checking ? "animate-pulse" : ""}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>فحص مجاني (بدون استهلاك رصيد التوليد) — يعيد تفعيل المفتاح بعد الشحن</TooltipContent>
            </Tooltip>
            {k.status !== "active" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" className="size-8 text-emerald-500" onClick={() => patch("activate", "عاد المفتاح نشطًا ✓")} disabled={acting} aria-label="تنشيط">
                    <Power className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>تنشيط (بعد شحن الرصيد)</TooltipContent>
              </Tooltip>
            )}
            {k.status === "active" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" className="size-8 text-amber-500" onClick={() => patch("disable", "عُطِّل المفتاح")} disabled={acting} aria-label="تعطيل">
                    <Ban className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>تعطيل يدوي</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="size-8 text-red-400" onClick={remove} disabled={acting} aria-label="حذف">
                  <Trash2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>حذف نهائي</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {k.lastError && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md bg-red-500/5 p-2 text-[11px] text-red-300/90">
            <CircleAlert className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2 break-all">{k.lastError}</span>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
