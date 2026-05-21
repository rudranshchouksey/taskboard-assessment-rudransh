import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const TASK_ID = "task_abc";
const PROJECT_ID = "proj_xyz";
const USER_ID = "user_1";

const fakeTask = { id: TASK_ID, projectId: PROJECT_ID };
const fakeComment = {
  id: "cmt_1",
  taskId: TASK_ID,
  authorId: USER_ID,
  body: "looks good",
  createdAt: new Date().toISOString(),
  author: { id: USER_ID, name: "Meera", email: "meera@taskboard.dev" },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task:    { findUnique: vi.fn() },
    comment: { findMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser:       vi.fn().mockResolvedValue({ id: USER_ID, email: "meera@taskboard.dev", name: "Meera" }),
  getProjectMembership: vi.fn().mockResolvedValue({ role: "member" }),
  canEditTasks:         (role: string) => role === "admin" || role === "member",
  unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  forbidden:    (m?: string) => new Response(JSON.stringify({ error: m ?? "forbidden" }), { status: 403 }),
  notFound:     (m?: string) => new Response(JSON.stringify({ error: m ?? "not found" }), { status: 404 }),
  badRequest:   (m?: string, d?: unknown) => new Response(JSON.stringify({ error: m, details: d }), { status: 400 }),
}));

import { GET, POST } from "@/app/api/tasks/[id]/comments/route";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, getProjectMembership } from "@/lib/auth";

function makeRequest(method: "GET" | "POST", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${TASK_ID}/comments`, {
    method,
    headers: { Authorization: "Bearer fake", "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeParams(id = TASK_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.task.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(fakeTask);
  (prisma.comment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fakeComment]);
  (prisma.comment.create as ReturnType<typeof vi.fn>).mockResolvedValue(fakeComment);
});

// ─── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/tasks/:id/comments", () => {
  it("returns comments ordered chronologically", async () => {
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].id).toBe("cmt_1");
  });

  it("queries with taskId and ascending createdAt order", async () => {
    await GET(makeRequest("GET"), makeParams());
    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where:   { taskId: TASK_ID },
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("returns 401 when unauthenticated", async () => {
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when task does not exist", async () => {
    (prisma.task.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not a project member", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(403);
    expect(prisma.comment.findMany).not.toHaveBeenCalled();
  });

  it("allows viewers to read comments", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ role: "viewer" });
    const res = await GET(makeRequest("GET"), makeParams());
    expect(res.status).toBe(200);
  });
});

// ─── POST ─────────────────────────────────────────────────────────────────────

describe("POST /api/tasks/:id/comments", () => {
  it("creates a comment and returns 201", async () => {
    const res = await POST(makeRequest("POST", { body: "looks good" }), makeParams());
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.comment.body).toBe("looks good");
  });

  it("persists the authenticated user as author", async () => {
    await POST(makeRequest("POST", { body: "nice" }), makeParams());
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorId: USER_ID, taskId: TASK_ID }),
      })
    );
  });

  it("returns 400 for an empty body string", async () => {
    const res = await POST(makeRequest("POST", { body: "" }), makeParams());
    expect(res.status).toBe(400);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("returns 400 when body field is missing", async () => {
    const res = await POST(makeRequest("POST", {}), makeParams());
    expect(res.status).toBe(400);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("returns 403 for viewers — they cannot post", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ role: "viewer" });
    const res = await POST(makeRequest("POST", { body: "hello" }), makeParams());
    expect(res.status).toBe(403);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a project member", async () => {
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await POST(makeRequest("POST", { body: "hello" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await POST(makeRequest("POST", { body: "hello" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when task does not exist", async () => {
    (prisma.task.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await POST(makeRequest("POST", { body: "hello" }), makeParams());
    expect(res.status).toBe(404);
  });
});
