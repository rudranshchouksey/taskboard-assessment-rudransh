import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── vi.mock factories: inline literals only (hoisting rule) ──────────────────
vi.mock("@/lib/airtable", () => ({
  getAirtableTable: vi.fn(),
}));

import { exportTasksToAirtable } from "@/services/airtable-export.service";
import { getAirtableTable } from "@/lib/airtable";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRecord(taskId: string) {
  return {
    id:     `rec_${taskId}`,
    fields: { externalTaskId: taskId },
    get:    (field: string) => field === "externalTaskId" ? taskId : undefined,
  };
}

function makeMockTable(existingRecords: ReturnType<typeof makeRecord>[] = []) {
  return {
    select: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue(existingRecords) }),
    create: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue([]),
  };
}

function makeTask(id: string, overrides: Partial<{ status: string; assignee: { name: string } | null }> = {}) {
  return {
    id,
    title:       `Task ${id}`,
    description: null,
    status:      "todo",
    assignee:    null,
    ...overrides,
  };
}

const THREE_TASKS = ["t1", "t2", "t3"].map((id) => makeTask(id));

beforeEach(() => vi.clearAllMocks());

// ─── upsert routing ───────────────────────────────────────────────────────────

describe("exportTasksToAirtable — upsert routing", () => {
  it("creates all tasks when the table is empty", async () => {
    const table = makeMockTable([]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable(THREE_TASKS);

    expect(s.created).toBe(3);
    expect(s.updated).toBe(0);
    expect(s.exported).toBe(3);
    expect(s.failed).toBe(0);
    expect(table.create).toHaveBeenCalled();
    expect(table.update).not.toHaveBeenCalled();
  });

  it("updates all tasks when all already exist", async () => {
    const table = makeMockTable(THREE_TASKS.map((t) => makeRecord(t.id)));
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable(THREE_TASKS);

    expect(s.created).toBe(0);
    expect(s.updated).toBe(3);
    expect(s.exported).toBe(3);
    expect(table.update).toHaveBeenCalled();
    expect(table.create).not.toHaveBeenCalled();
  });

  it("mixes creates and updates correctly", async () => {
    // t1 exists, t2 and t3 are new
    const table = makeMockTable([makeRecord("t1")]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable(THREE_TASKS);

    expect(s.created).toBe(2);
    expect(s.updated).toBe(1);
    expect(s.exported).toBe(3);
  });
});

// ─── batching ─────────────────────────────────────────────────────────────────

describe("exportTasksToAirtable — batching", () => {
  it("splits 25 tasks into 3 create batches (10 + 10 + 5)", async () => {
    const tasks = Array.from({ length: 25 }, (_, i) => makeTask(`t${i}`));
    const table = makeMockTable([]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    await exportTasksToAirtable(tasks);

    expect(table.create).toHaveBeenCalledTimes(3);
    const batchSizes = (table.create as ReturnType<typeof vi.fn>).mock.calls.map(
      ([arr]: [unknown[]]) => arr.length
    );
    expect(batchSizes).toEqual([10, 10, 5]);
  });

  it("sends the correct field mapping in each create payload", async () => {
    const task = makeTask("t1", { status: "in_progress", assignee: { name: "Meera" } });
    task.description = "A description";
    const table = makeMockTable([]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    await exportTasksToAirtable([task]);

    const [[batch]] = (table.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(batch[0].fields).toEqual({
      externalTaskId: "t1",
      Name:           "Task t1",
      Description:    "A description",
      Status:         "in_progress",
      Assignee:       "Meera",
    });
  });
});

// ─── retry ────────────────────────────────────────────────────────────────────

describe("exportTasksToAirtable — retry", () => {
  it("retries on 429 and succeeds on the second attempt", async () => {
    const table = makeMockTable([]);
    (table.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ statusCode: 429, message: "rate limited" })
      .mockResolvedValueOnce([]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable([makeTask("t1")]);

    expect(table.create).toHaveBeenCalledTimes(2);
    expect(s.created).toBe(1);
    expect(s.failed).toBe(0);
  });

  it("retries on 500 and succeeds on the third attempt", async () => {
    const table = makeMockTable([]);
    (table.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ statusCode: 500, message: "server error" })
      .mockRejectedValueOnce({ statusCode: 500, message: "server error" })
      .mockResolvedValueOnce([]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable([makeTask("t1")]);

    expect(table.create).toHaveBeenCalledTimes(3);
    expect(s.created).toBe(1);
  });

  it("does NOT retry on permanent errors (400)", async () => {
    const table = makeMockTable([]);
    (table.create as ReturnType<typeof vi.fn>).mockRejectedValue({
      statusCode: 400,
      message: "unknown field",
    });
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable([makeTask("t1")]);

    expect(table.create).toHaveBeenCalledTimes(1); // no retry
    expect(s.failed).toBe(1);
    expect(s.created).toBe(0);
  });

  it("exhausts retries after 3 attempts on persistent 503", async () => {
    const table = makeMockTable([]);
    (table.create as ReturnType<typeof vi.fn>).mockRejectedValue({
      statusCode: 503,
      message: "service unavailable",
    });
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable([makeTask("t1")]);

    expect(table.create).toHaveBeenCalledTimes(3); // 3 total attempts
    expect(s.failed).toBe(1);
  });
});

// ─── error isolation ──────────────────────────────────────────────────────────

describe("exportTasksToAirtable — error isolation", () => {
  it("records per-task errors but continues processing remaining batches", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => makeTask(`t${i}`));
    const table = makeMockTable([]);
    // First batch of 10 fails; second batch succeeds
    (table.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ statusCode: 400, message: "bad field" })
      .mockResolvedValue([]);
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable(tasks);

    expect(s.created).toBe(10);
    expect(s.failed).toBe(10);
    expect(s.errors).toHaveLength(10);
    // All 10 tasks in the failed batch have error entries
    expect(s.errors.map((e) => e.taskId)).toEqual(tasks.slice(0, 10).map((t) => t.id));
  });

  it("returns exported = created + updated even when some fail", async () => {
    const tasks = Array.from({ length: 3 }, (_, i) => makeTask(`t${i}`));
    const table = makeMockTable([]);
    (table.create as ReturnType<typeof vi.fn>).mockRejectedValue({
      statusCode: 400,
      message: "err",
    });
    (getAirtableTable as ReturnType<typeof vi.fn>).mockReturnValue(table);

    const s = await exportTasksToAirtable(tasks);

    expect(s.exported).toBe(s.created + s.updated);
    expect(s.failed).toBe(3);
    expect(s.errors).toHaveLength(3);
  });
});
