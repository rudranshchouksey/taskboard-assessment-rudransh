import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── constants ────────────────────────────────────────────────────────────────
const PROJECT_ID = "proj_xyz";
const USER_ID    = "user_1";

// ─── vi.mock factories: inline literals only (hoisting rule) ──────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: {
    activity: { findMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser:       vi.fn().mockResolvedValue({ id: "user_1", email: "a@b.com", name: "Meera" }),
  getProjectMembership: vi.fn().mockResolvedValue({ role: "member" }),
  unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  forbidden:    (m?: string) => new Response(JSON.stringify({ error: m ?? "forbidden" }), { status: 403 }),
}));

import { GET } from "@/app/api/projects/[id]/activity/route";
import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, getProjectMembership } from "@/lib/auth";

// ─── shared fixture ───────────────────────────────────────────────────────────
const fakeActivity = {
  id:        "act_1",
  projectId: PROJECT_ID,
  taskId:    "task_abc",
  actorId:   USER_ID,
  type:      "task_created",
  meta:      { taskTitle: "Fix bug" },
  createdAt: new Date().toISOString(),
  actor:     { id: USER_ID, name: "Meera", email: "a@b.com" },
};

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/activity`, {
    headers: { Authorization: "Bearer fake" },
  });
}

function makeParams(id = PROJECT_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.activity.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fakeActivity]);
  (prisma.activity.create  as ReturnType<typeof vi.fn>).mockResolvedValue(fakeActivity);
  (getCurrentUser            as ReturnType<typeof vi.fn>).mockResolvedValue({ id: USER_ID, email: "a@b.com", name: "Meera" });
  (getProjectMembership      as ReturnType<typeof vi.fn>).mockResolvedValue({ role: "member" });
});

// ─── GET /api/projects/:id/activity ──────────────────────────────────────────

describe("GET /api/projects/:id/activity", () => {
  it("returns 200 with activities array", async () => {
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0].id).toBe("act_1");
  });

  it("queries most-recent-first with a limit of 50", async () => {
    await GET(makeRequest(), makeParams());
    expect(prisma.activity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where:   { projectId: PROJECT_ID },
        orderBy: { createdAt: "desc" },
        take:    50,
      })
    );
  });

  it("includes actor in the query", async () => {
    await GET(makeRequest(), makeParams());
    const [call] = (prisma.activity.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(call[0].include?.actor?.select).toMatchObject({ id: true, name: true, email: true });
  });

  it("returns 401 when unauthenticated", async () => {
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a project member", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
  });

  it("allows viewers to read the feed", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ role: "viewer" });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });
});

// ─── recordActivity helper ────────────────────────────────────────────────────

describe("recordActivity", () => {
  it("calls prisma.activity.create with the supplied data", async () => {
    recordActivity({
      projectId: PROJECT_ID,
      taskId:    "task_abc",
      actorId:   USER_ID,
      type:      "task_created",
      meta:      { taskTitle: "Fix bug" },
    });

    // Fire-and-forget: flush the microtask queue so the void promise resolves.
    await Promise.resolve();

    expect(prisma.activity.create).toHaveBeenCalledWith({
      data: {
        projectId: PROJECT_ID,
        taskId:    "task_abc",
        actorId:   USER_ID,
        type:      "task_created",
        meta:      { taskTitle: "Fix bug" },
      },
    });
  });

  it("does not throw when prisma.activity.create rejects", async () => {
    (prisma.activity.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db is down")
    );

    // Must not throw — fire-and-forget swallows the error.
    expect(() =>
      recordActivity({
        projectId: PROJECT_ID,
        taskId:    null,
        actorId:   USER_ID,
        type:      "comment_added",
        meta:      { taskTitle: "x", preview: "hi" },
      })
    ).not.toThrow();

    // Flush microtasks — error is caught internally, no unhandled rejection.
    await Promise.resolve();
  });

  it("maps status_changed metadata correctly", async () => {
    recordActivity({
      projectId: PROJECT_ID,
      taskId:    "task_abc",
      actorId:   USER_ID,
      type:      "status_changed",
      meta:      { taskTitle: "Deploy", from: "todo", to: "in_progress" },
    });

    await Promise.resolve();

    const [call] = (prisma.activity.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(call[0].data.meta).toEqual({ taskTitle: "Deploy", from: "todo", to: "in_progress" });
    expect(call[0].data.type).toBe("status_changed");
  });
});
