import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Hoisted mocks — vi.mock is moved above imports by vitest automatically.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Presence of this spy lets tests assert it is NEVER called.
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser:      vi.fn().mockResolvedValue({ id: "u_1", email: "a@b.com", name: "Test" }),
  getProjectMembership:vi.fn().mockResolvedValue({ role: "member" }),
  canEditTasks:        vi.fn().mockReturnValue(true),
  unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  forbidden:    (m?: string) => new Response(JSON.stringify({ error: m ?? "forbidden" }), { status: 403 }),
  badRequest:   (m?: string) => new Response(JSON.stringify({ error: m ?? "bad request" }), { status: 400 }),
}));

import { GET } from "@/app/api/projects/[id]/tasks/route";
import { prisma } from "@/lib/prisma";

const PROJECT_ID = "proj_abc123";

function makeRequest(q?: string): NextRequest {
  const url = q
    ? `http://localhost/api/projects/${PROJECT_ID}/tasks?q=${encodeURIComponent(q)}`
    : `http://localhost/api/projects/${PROJECT_ID}/tasks`;
  return new NextRequest(url, {
    headers: { Authorization: "Bearer fake-jwt" },
  });
}

function makeParams(id = PROJECT_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to empty array for each test.
  (prisma.task.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("GET /api/projects/:id/tasks — search safety", () => {
  it("calls findMany without a filter when no q param is provided", async () => {
    await GET(makeRequest(), makeParams());

    expect(prisma.task.findMany).toHaveBeenCalledOnce();
    const [call] = (prisma.task.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(call[0].where).toEqual({ projectId: PROJECT_ID });
  });

  it("calls findMany with an ORM contains filter when q is provided", async () => {
    await GET(makeRequest("design"), makeParams());

    expect(prisma.task.findMany).toHaveBeenCalledOnce();
    const [call] = (prisma.task.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(call[0].where).toEqual({
      projectId: PROJECT_ID,
      OR: [
        { title:       { contains: "design", mode: "insensitive" } },
        { description: { contains: "design", mode: "insensitive" } },
      ],
    });
  });

  it("never calls $queryRawUnsafe regardless of q value", async () => {
    await GET(makeRequest("anything"), makeParams());
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("treats a SQL injection payload as a literal string — not executed SQL", async () => {
    const injection = "' UNION SELECT id,email,password_hash FROM users--";
    await GET(makeRequest(injection), makeParams());

    // Raw SQL must never be called.
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();

    // The payload must appear verbatim inside the ORM contains filter.
    const [call] = (prisma.task.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(call[0].where.OR[0].title.contains).toBe(injection);
    expect(call[0].where.OR[1].description.contains).toBe(injection);
  });

  it("returns 200 with the tasks returned by findMany", async () => {
    const fakeTask = { id: "t_1", title: "Write tests", status: "todo" };
    (prisma.task.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([fakeTask]);

    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("t_1");
  });

  it("returns 403 when the caller is not a member of the project", async () => {
    const { getProjectMembership } = await import("@/lib/auth");
    (getProjectMembership as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await GET(makeRequest("x"), makeParams());
    expect(res.status).toBe(403);
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });
});
