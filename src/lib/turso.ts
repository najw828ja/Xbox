import { createClient, type Client } from "@libsql/client";

/**
 * Turso (libSQL) — تخزين روابط الصور/الفيديو وتتبع المهام.
 * لا نحمّل أي وسائط على السيرفر؛ نخزن الروابط فقط + كل معلومات المهمة.
 */

declare global {
  var __tursoClient: Client | undefined;
  var __tursoSchemaReady: Promise<void> | undefined;
}

function normalizeTursoUrl(raw: string): string {
  const url = raw.trim();
  if (url.startsWith("turso://")) return url.replace("turso://", "https://");
  return url;
}

export function getTurso(): Client {
  if (!globalThis.__tursoClient) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Turso is not configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env"
      );
    }
    globalThis.__tursoClient = createClient({
      url: normalizeTursoUrl(url),
      authToken: token,
    });
  }
  return globalThis.__tursoClient;
}

/** إنشاء الجداول إن لم تكن موجودة (يُنفَّذ مرة واحدة لكل عملية) */
export function ensureSchema(): Promise<void> {
  if (!globalThis.__tursoSchemaReady) {
    globalThis.__tursoSchemaReady = (async () => {
      const db = getTurso();
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          usage_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          fail_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_keys_provider_status ON api_keys(provider, status);
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          params_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          progress INTEGER NOT NULL DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      `);
    })().catch((err) => {
      globalThis.__tursoSchemaReady = undefined;
      throw err;
    });
  }
  return globalThis.__tursoSchemaReady;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
