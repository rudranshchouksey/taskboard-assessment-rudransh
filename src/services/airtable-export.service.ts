import { getAirtableTable } from "@/lib/airtable";

// ─── types ────────────────────────────────────────────────────────────────────

/** Minimal task shape the service requires — avoids coupling to Prisma or ApiTask. */
export interface TaskInput {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: { name: string } | null;
}

export type ExportSummary = {
  exported: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ taskId: string; message: string }>;
};

// ─── constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;
/** HTTP status codes that indicate a transient failure worth retrying. */
const RETRYABLE_CODES = new Set([429, 500, 502, 503]);

// ─── helpers ──────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  const code = (err as { statusCode?: number }).statusCode;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
      await sleep(300 * attempt); // 300 ms, 600 ms on subsequent retries
    }
  }
  throw lastErr;
}

function taskToFields(task: TaskInput): Record<string, unknown> {
  return {
    externalTaskId: task.id,
    Name:           task.title,
    Description:    task.description ?? "",
    Status:         task.status,
    Assignee:       task.assignee?.name ?? "",
  };
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function exportTasksToAirtable(
  tasks: TaskInput[]
): Promise<ExportSummary> {
  const table = getAirtableTable();

  // Fetch all existing records once to build the upsert map.
  // Only retrieve the externalTaskId field to keep the payload small.
  const existing = await table.select({ fields: ["externalTaskId"] }).all();
  const recordMap = new Map<string, string>(); // externalTaskId → airtable record id
  for (const rec of existing) {
    const extId = rec.get("externalTaskId") as string | undefined;
    if (extId) recordMap.set(extId, rec.id);
  }

  const toCreate = tasks.filter((t) => !recordMap.has(t.id));
  const toUpdate = tasks.filter((t) =>  recordMap.has(t.id));

  const summary: ExportSummary = {
    exported: 0,
    created:  0,
    updated:  0,
    failed:   0,
    errors:   [],
  };

  // ── creates ──────────────────────────────────────────────────────────────
  for (const batch of chunk(toCreate, BATCH_SIZE)) {
    try {
      await withRetry(() =>
        table.create(batch.map((t) => ({ fields: taskToFields(t) })))
      );
      summary.created  += batch.length;
      summary.exported += batch.length;
    } catch (err) {
      // Batch failed after retries — record every task in the batch and continue.
      const message = err instanceof Error ? err.message : String(err);
      for (const t of batch) summary.errors.push({ taskId: t.id, message });
      summary.failed += batch.length;
    }
  }

  // ── updates ──────────────────────────────────────────────────────────────
  for (const batch of chunk(toUpdate, BATCH_SIZE)) {
    try {
      await withRetry(() =>
        table.update(
          batch.map((t) => ({
            id:     recordMap.get(t.id)!,
            fields: taskToFields(t),
          }))
        )
      );
      summary.updated  += batch.length;
      summary.exported += batch.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const t of batch) summary.errors.push({ taskId: t.id, message });
      summary.failed += batch.length;
    }
  }

  return summary;
}
