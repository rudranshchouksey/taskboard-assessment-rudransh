import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── vi.mock factories: inline literals only (hoisting rule) ──────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser:       vi.fn().mockResolvedValue({ id: "user_1", email: "a@b.com", name: "Meera" }),
  getProjectMembership: vi.fn().mockResolvedValue({ role: "member" }),
  canEditTasks:         (role: string) => role === "admin" || role === "member",
  unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  forbidden:    (m?: string) => new Response(JSON.stringify({ error: m ?? "forbidden" }), { status: 403 }),
}));

vi.mock("@/lib/airtable", () => ({
  isAirtableConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock("@/services/airtable-export.service", () => ({
  exportTasksToAirtable: vi.fn().mockResolvedValue({
    exported: 2,
    created:  1,
    updated:  1,
    failed:   0,
    errors:   [],
  }),
}));

import { POST } from "@/app/api/projects/[id]/export/route";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, getProjectMembership } from "@/lib/auth";
import { isAirtableConfigured } from "@/lib/airtable";
import { exportTasksToAirtable } from "@/services/airtable-export.service";

const PROJECT_ID = "proj_abc";
const FAKE_TASKS = [{ id: "t1", title: "Fix bug", status: "todo" }];

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/export`, {
    method: "POST",
    headers: { Authorization: "Bearer fake" },
  });
}
function makeParams(id = PROJECT_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.task.findMany          as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_TASKS);
  (getCurrentUser                as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "user_1", email: "a@b.com", name: "Meera" });
  (getProjectMembership          as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "member" });
  (isAirtableConfigured          as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (exportTasksToAirtable         as ReturnType<typeof vi.fn>).mockResolvedValue({
    exported: 2, created: 1, updated: 1, failed: 0, errors: [],
  });
});

describe("POST /api/projects/:id/export", () => {
  it("returns 200 with the export summary", async () => {
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ exported: 2, created: 1, updated: 1, failed: 0 });
  });

  it("fetches tasks for the correct project, capped at 1000", async () => {
    await POST(makeRequest(), makeParams());
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: PROJECT_ID },
        take:  1000,
      })
    );
  });

  it("passes fetched tasks directly to exportTasksToAirtable", async () => {
    await POST(makeRequest(), makeParams());
    expect(exportTasksToAirtable).toHaveBeenCalledWith(FAKE_TASKS);
  });

  it("returns 401 when unauthenticated", async () => {
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(exportTasksToAirtable).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a project member", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(exportTasksToAirtable).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a viewer", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ role: "viewer" });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(exportTasksToAirtable).not.toHaveBeenCalled();
  });

  it("returns 501 when Airtable is not configured", async () => {
    (isAirtableConfigured as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
    expect(exportTasksToAirtable).not.toHaveBeenCalled();
  });

  it("allows admin to export", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ role: "admin" });
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });
});
