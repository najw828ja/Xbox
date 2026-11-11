/**
 * تخزين المهام في Turso — كل معلومات المهمة + روابط النتائج (بدون تنزيل أي وسائط للسيرفر)
 * الحالات: pending → processing → completed | failed
 */
import { randomUUID } from "crypto";
import { ensureSchema, getTurso } from "./turso";
import type { MediaType, ProviderId, TaskProvider } from "./models";

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskAttempt {
  provider: ProviderId;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: TaskProvider | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function toRow(r: Record<string, unknown>): TaskRow {
  let urls: string[] = [];
  try {
    const parsed = r.result_urls_json ? JSON.parse(String(r.result_urls_json)) : [];
    if (Array.isArray(parsed)) urls = parsed.filter((u): u is string => typeof u === "string");
  } catch { /* تجاهل */ }
  let attempts: TaskAttempt[] = [];
  try {
    const parsed = r.attempts_json ? JSON.parse(String(r.attempts_json)) : [];
    if (Array.isArray(parsed)) attempts = parsed as TaskAttempt[];
  } catch { /* تجاهل */ }
  return {
    id: String(r.id),
    provider: (r.provider as TaskProvider) ?? null,
    providerTaskId: (r.provider_task_id as string) ?? null,
    keyId: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as MediaType,
    prompt: String(r.prompt ?? ""),
    paramsJson: String(r.params_json ?? "{}"),
    status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0),
    resultUrls: urls,
    errorMessage: (r.error_message as string) ?? null,
    attempts,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: (r.completed_at as string) ?? null,
  };
}

export async function insertTask(t: {
  provider: TaskProvider | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  resultUrls?: string[];
  errorMessage?: string | null;
  progress?: number;
  attempts?: TaskAttempt[];
}): Promise<TaskRow> {
  await ensureSchema();
  const id = randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      t.provider,
      t.providerTaskId,
      t.keyId,
      t.model,
      t.type,
      t.prompt,
      JSON.stringify(t.params ?? {}),
      t.status,
      t.progress ?? (t.status === "completed" ? 100 : 0),
      t.resultUrls?.length ? JSON.stringify(t.resultUrls) : null,
      t.errorMessage ?? null,
      JSON.stringify(t.attempts ?? []),
    ],
  });
  return (await getTask(id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const res = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return res.rows.length ? toRow(res.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function updateTask(
  id: string,
  patch: Partial<{
    status: TaskStatus;
    progress: number;
    resultUrls: string[];
    errorMessage: string | null;
    provider: TaskProvider | null;
    providerTaskId: string | null;
    keyId: string | null;
    appendAttempt: TaskAttempt;
  }>
): Promise<TaskRow | null> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return null;

  const attempts = patch.appendAttempt ? [...current.attempts, patch.appendAttempt] : current.attempts;
  const urls = patch.resultUrls ?? current.resultUrls;
  const status = patch.status ?? current.status;
  // الحقول القابلة للمسح صراحةً (null) أو الإبقاء على القيمة الحالية عند عدم تمريرها
  const provider = patch.provider !== undefined ? patch.provider : current.provider;
  const providerTaskId = patch.providerTaskId !== undefined ? patch.providerTaskId : current.providerTaskId;
  const keyId = patch.keyId !== undefined ? patch.keyId : current.keyId;

  await getTurso().execute({
    sql: `UPDATE tasks SET
            provider = ?,
            provider_task_id = ?,
            key_id = ?,
            status = ?,
            progress = ?,
            result_urls_json = ?,
            error_message = ?,
            attempts_json = ?,
            updated_at = datetime('now'),
            completed_at = CASE WHEN ? = 'completed' AND completed_at IS NULL THEN datetime('now') ELSE completed_at END
          WHERE id = ?`,
    args: [
      provider,
      providerTaskId,
      keyId,
      status,
      patch.progress ?? current.progress,
      urls.length ? JSON.stringify(urls) : null,
      "errorMessage" in patch ? patch.errorMessage ?? null : current.errorMessage,
      JSON.stringify(attempts),
      status,
      id,
    ],
  });
  return getTask(id);
}

export async function listRecentTasks(limit = 12, filter?: { type?: MediaType; status?: TaskStatus }): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter?.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { where.push("status = ?"); args.push(filter.status); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const res = await getTurso().execute({
    sql: `SELECT * FROM tasks ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [...args, Math.max(1, Math.min(50, limit))],
  });
  return res.rows.map((r) => toRow(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const res = await getTurso().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = (res.rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    processing: Number(r.processing ?? 0),
  };
}
