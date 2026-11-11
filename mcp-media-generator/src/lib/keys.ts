/**
 * إدارة مفاتيح المزودين + منطق التبديل التلقائي:
 * - ترتيب تسلسلي: أول مفتاح أُضيف يُجرَّب أولًا، ثم التالي ثم التالي (created_at ASC) —
 *   كل مهمة جديدة تبدأ من أول المجموعة، وأي مفتاح يُرفض ينتقل العمل فورًا للمفتاح التالي.
 * - تصنيف ذكي للأخطاء:
 *     401/403 أو "invalid api key"  → disabled  (مفتاح غلط — يُعطَّل تلقائيًا)
 *     402 / insufficient / quota    → exhausted (خلص الرصيد — ينتقل للتالي)
 *     429 / 5xx / شبكة / ضغط        → temporary (ينتقل للتالي ويرجع له لاحقًا)
 *     400/422 (معطيات الطلب)        → params    (يتوقف فورًا — التبديل لن يحلها)
 */
import { randomUUID } from "crypto";
import { ensureSchema, getTurso } from "./turso";
import { ProviderError } from "./providers/base";
import type { ProviderId } from "./models";

export type KeyStatus = "active" | "exhausted" | "disabled";
export type ErrorClass = "disabled" | "exhausted" | "temporary" | "params" | "provider";

export interface ApiKeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  apiKey: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface PublicApiKey extends Omit<ApiKeyRow, "apiKey"> {
  keyMasked: string;
}

export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) return `${k.slice(0, 3)}••••`;
  return `${k.slice(0, 7)}••••••••${k.slice(-4)}`;
}

function toRow(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id),
    provider: r.provider as ProviderId,
    label: String(r.label ?? ""),
    apiKey: String(r.api_key),
    status: r.status as KeyStatus,
    usageCount: Number(r.usage_count ?? 0),
    successCount: Number(r.success_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    lastUsedAt: (r.last_used_at as string) ?? null,
    lastCheckedAt: (r.last_checked_at as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    createdAt: String(r.created_at),
  };
}

export function toPublic(row: ApiKeyRow): PublicApiKey {
  const { apiKey, ...rest } = row;
  return { ...rest, keyMasked: maskKey(apiKey) };
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const res = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => toRow(r as unknown as Record<string, unknown>));
}

export async function addKey(provider: ProviderId, apiKey: string, label: string): Promise<ApiKeyRow> {
  await ensureSchema();
  const id = randomUUID();
  await getTurso().execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)",
    args: [id, provider, label.trim(), apiKey.trim()],
  });
  const row = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return toRow(row.rows[0] as unknown as Record<string, unknown>);
}

export async function findDuplicateKey(provider: ProviderId, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const res = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey.trim()],
  });
  return res.rows.length > 0;
}

export async function getKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const res = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return res.rows.length ? toRow(res.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function setKeyStatus(id: string, status: KeyStatus, lastError?: string | null): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error) WHERE id = ?",
    args: [status, lastError === undefined ? null : lastError, id],
  });
}

export async function markKeyChecked(id: string, ok: boolean, note: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET last_checked_at = datetime('now'), last_error = ?, status = CASE WHEN ? THEN 'active' ELSE status END WHERE id = ?`,
    args: [ok ? null : note, ok ? 1 : 0, id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

/** استُخدم المفتاح في محاولة (زيادة العدّاد + وقت آخر استخدام) */
export async function touchKeyUsage(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?`,
    args: [id],
  });
}

export async function recordKeyOutcome(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (error ?? "unknown error"), id],
  });
}

export interface KeyCandidate {
  row: ApiKeyRow;
}

/**
 * يجمع كل المفاتيح القادرة على خدمة الموديل من المزودين المعنيين
 * ويرتبها تسلسليًا حسب ترتيب الإضافة: أول مفتاح ثم التالي ثم التالي.
 * سياسة «لا مفتاح يتوقف»: المفاتيح تبقى في الدورة دائمًا حتى مع نفاد الرصيد —
 * الاستثناء الوحيد هو التعطيل اليدوي من الواجهة (status = 'disabled').
 */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(",");
  const res = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC,
                   id ASC`,
    args: providers,
  });
  return res.rows.map((r) => toRow(r as unknown as Record<string, unknown>));
}

/** تصنيف أي خطأ يرد من المزود إلى فئة موحّدة */
export function classifyProviderError(err: unknown): { cls: ErrorClass; status: number; message: string } {
  if (err instanceof ProviderError) {
    const s = err.status;
    const m = err.message || "";
    const ml = m.toLowerCase();
    if (s === 401 || s === 403 || /invalid api key|invalid_api_key|unauthorized|forbidden|authentication|مفتاح غير صالح/.test(ml))
      return { cls: "disabled", status: s, message: m };
    // نفاد الرصيد/الحصة — قبل فحص المعطيات لأن بعض المزودين يرسلونه بحالة 400
    if (s === 402 || /insufficient|quota|exceeded|balance|credit|arrears|充值|out of credits|exhausted|resource.?exhausted/.test(ml))
      return { cls: "exhausted", status: s, message: m };
    if (/model.*(not|un).*found|not.*support|unsupported model|unknown model/.test(ml) && (s === 400 || s === 404 || s === 422))
      return { cls: "provider", status: s, message: m };
    if (s === 400 || s === 422) return { cls: "params", status: s, message: m };
    if (s === 429 || s === 0 || s >= 500)
      return { cls: "temporary", status: s, message: m };
    return { cls: "temporary", status: s, message: m };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const ml = msg.toLowerCase();
  if (/abort/i.test(ml)) return { cls: "temporary", status: 0, message: "aborted" };
  return { cls: "temporary", status: 0, message: msg };
}

export const CLASS_MESSAGES: Record<ErrorClass, string> = {
  disabled: "المفتاح مرفوض من المزود — انتقال تلقائي للمفتاح التالي",
  exhausted: "المفتاح غير متاح حاليًا — انتقال تلقائي للمفتاح التالي",
  temporary: "ضغط مؤقت أو خطأ شبكة/سيرفر — انتقال تلقائي للمفتاح التالي",
  params: "خطأ في معطيات الطلب — إيقاف فوري (التبديل لن يحلها)",
  provider: "المزود لا يدعم هذا الموديل أو رفض الطلب — انتقال تلقائي للتالي",
};
