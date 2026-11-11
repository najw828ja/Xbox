/** أنواع مشتركة للعميل — مطابقة لاستجابات واجهات REST */

export type KeyStatus = "active" | "exhausted" | "disabled";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface PublicKey {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  keyMasked: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface KeysResponse {
  keys: PublicKey[];
  stats: {
    total: number;
    active: number;
    exhausted: number;
    disabled: number;
    byProvider: { kie: number; cometapi: number };
    totalUsage: number;
    totalSuccess: number;
    totalFail: number;
  };
  tasks: { total: number; completed: number; failed: number; processing: number };
  error?: string;
}

export interface TaskItem {
  id: string;
  provider: "kie" | "cometapi" | "merger" | null;
  providerTaskId: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: Array<{ provider: string; keyLabel: string; ok: boolean; errorClass?: string; error?: string; at: string }>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TasksResponse {
  tasks: TaskItem[];
  stats: { total: number; completed: number; failed: number; processing: number };
}

export interface HealthResponse {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: "image" | "video"; providers: string[] }>;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}
