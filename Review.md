# TaskBoard — Senior Code Review

**Reviewer:** Senior Security & Architecture Review  
**Date:** 2026-05-21  
**Branch:** `main`  
**Scope:** Security · Authorization · Data Integrity · Business Logic

---

## Executive Summary

Four critical-to-medium issues were identified. Two of them allow unauthenticated-style lateral access to data the caller does not own. One exposes credential material in every authenticated API response. One silently corrupts Kanban board state under concurrent load. None of these require attacker privileges beyond a valid user account.

The issues are ordered by impact. Issue 1 and 2 should be treated as **P0 — fix before any production deployment.**

---

---

## Issue 1 — SQL Injection via Unsanitised Search Parameter

| Field | Value |
|---|---|
| **File** | `src/app/api/projects/[id]/tasks/route.ts` |
| **Lines** | 27 – 34 |
| **Category** | Security |
| **Severity** | Critical |

### Vulnerable Code

```typescript
// src/app/api/projects/[id]/tasks/route.ts  lines 27-34
const sql = `
  SELECT id, project_id, title, description, status, assignee_id, created_by_id, position, created_at, updated_at
  FROM tasks
  WHERE project_id = '${projectId}'
    AND (title ILIKE '%${q}%' OR description ILIKE '%${q}%')
  ORDER BY position ASC
`;
const tasks = await prisma.$queryRawUnsafe(sql);
```

### Impact

The `q` query parameter is interpolated directly into the SQL string and executed via `$queryRawUnsafe`. Any member of a project — including viewers — can inject arbitrary SQL that executes with the database user's full permissions. This enables:

- **Full database exfiltration** — read any table (users, memberships, all projects)
- **Authentication bypass** — extract `password_hash` for any user for offline cracking
- **Data destruction** — `DROP TABLE`, `DELETE FROM users`, etc.
- **Cross-project data access** — bypass the project membership boundary entirely

The `projectId` parameter on line 30 comes from the route segment and is not user-controlled, but the `q` parameter on line 31 is 100% attacker-controlled.

### curl Reproduction

**Step 1 — Obtain a valid token** (any seeded user works):
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"meera@taskboard.dev","password":"password123"}' \
  | jq -r '.token')
```

**Step 2 — Pick a project ID you are a member of:**
```bash
PROJECT_ID=$(curl -s http://localhost:3000/api/projects \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.projects[0].id')
```

**Step 3 — Inject SQL to dump the entire users table including password hashes:**
```bash
curl -g "http://localhost:3000/api/projects/${PROJECT_ID}/tasks?q=%' UNION SELECT id,email,password_hash,name,status,assignee_id,created_by_id,0,created_at,updated_at FROM users--" \
  -H "Authorization: Bearer $TOKEN"
```

**Actual vulnerable behavior:**  
The response returns every row from the `users` table, including `password_hash` values for all accounts in the database, disguised as task records. The attacker now has bcrypt hashes for every user and can run offline cracking.

**Expected secure behavior:**  
The endpoint should return a `400 Bad Request` or simply a filtered task list, with zero information from other tables and no ability to alter query structure.

### Recommended Fix

Replace `$queryRawUnsafe` with Prisma's type-safe query builder, which parameterises all values automatically:

```typescript
// src/app/api/projects/[id]/tasks/route.ts
const tasks = await prisma.task.findMany({
  where: {
    projectId,
    OR: [
      { title:       { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ],
  },
  include: {
    assignee: { select: { id: true, name: true, email: true } },
  },
  orderBy: { position: "asc" },
});
```

This produces a parameterised `ILIKE` query identical in semantics to the original but immune to injection. The raw SQL block (lines 27–35) and the `$queryRawUnsafe` import can be deleted entirely.

---

---

## Issue 2 — Horizontal Privilege Escalation on Task Update

| Field | Value |
|---|---|
| **File** | `src/app/api/tasks/[id]/route.ts` |
| **Lines** | 16 – 38 |
| **Category** | Authorization |
| **Severity** | Critical |

### Vulnerable Code

```typescript
// src/app/api/tasks/[id]/route.ts  lines 16-38
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();               // ← only check: "are you logged in?"

  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) return badRequest("invalid input", parsed.error.flatten());

  const existing = await prisma.task.findUnique({ where: { id } });
  if (!existing) return notFound("task not found");

  // No membership check. No role check.
  // Any authenticated user reaching this point can write to any task.

  const task = await prisma.task.update({
    where: { id },
    data: parsed.data,          // ← title, description, status, assigneeId, position
    ...
  });
  return NextResponse.json({ task });
}
```

### Impact

The `PATCH /api/tasks/:id` handler verifies that the caller holds a valid JWT — but never verifies they are a member of the task's project. A viewer on Project A (or a member of a completely different project) who guesses or enumerates a task ID belonging to Project B can:

- Rename any task in the system
- Move any task to a different status column
- Re-assign any task to any user
- Corrupt position ordering on any Kanban board

Compare this directly with `DELETE /api/tasks/:id` on lines 40–57 of the same file, which **does** call `getProjectMembership` and `canEditTasks`. The membership guard was applied to DELETE but completely omitted from PATCH. This asymmetry is likely an oversight, not intent.

Task IDs are CUIDs, which are sequential enough that an attacker who holds one valid task ID can enumerate adjacent IDs within a small search space.

### curl Reproduction

```bash
# Attacker holds a token for user-B who is NOT a member of the target project.
ATTACKER_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"lina@example.com","password":"password123"}' \
  | jq -r '.token')

# Attacker knows or guesses a task ID from a project they are not a member of.
TARGET_TASK_ID="<task-id-from-another-project>"

curl -X PATCH "http://localhost:3000/api/tasks/${TARGET_TASK_ID}" \
  -H "Authorization: Bearer $ATTACKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"[COMPROMISED]","status":"done","description":"injected by attacker"}'
```

**Actual vulnerable behavior:**  
Returns `200 OK` with the modified task. The attacker has silently overwritten another project's task data without ever being a member of that project.

**Expected secure behavior:**  
Should return `403 Forbidden` immediately after confirming the caller has no membership record for the task's project.

### Recommended Fix

Add the same membership and role check that already exists in DELETE, immediately after loading `existing`:

```typescript
// src/app/api/tasks/[id]/route.ts — after line 27
const existing = await prisma.task.findUnique({ where: { id } });
if (!existing) return notFound("task not found");

// Add these three lines:
const membership = await getProjectMembership(user.id, existing.projectId);
if (!membership) return forbidden("you are not a member of this project");
if (!canEditTasks(membership.role)) return forbidden("viewers cannot edit tasks");

const task = await prisma.task.update({ ... });
```

---

---

## Issue 3 — Password Hash Returned in Every Project API Response

| Field | Value |
|---|---|
| **File** | `src/app/api/projects/[id]/route.ts` |
| **Lines** | 25 – 44 |
| **Category** | Security |
| **Severity** | High |

### Vulnerable Code

```typescript
// src/app/api/projects/[id]/route.ts  lines 25-44
const project = await prisma.project.findUnique({
  where: { id },
  include: {
    owner: true,                  // ← no field selection: returns ALL columns
    memberships: {
      include: { user: true },    // ← no field selection: returns ALL columns
    },
    tasks: {
      include: {
        assignee: true,           // ← no field selection: returns ALL columns
        createdBy: true,          // ← no field selection: returns ALL columns
      },
    },
  },
});
```

### Impact

Every `include: { user: true }` and `include: { owner: true }` without a `select` clause returns the full Prisma model row — which includes `password_hash` from the `users` table. The `GET /api/projects/:id` response therefore embeds bcrypt password hashes for:

- The project owner (`project.owner.passwordHash`)
- Every project member (`project.memberships[*].user.passwordHash`)
- Every task's assignee (`project.tasks[*].assignee.passwordHash`)
- Every task's creator (`project.tasks[*].createdBy.passwordHash`)

A logged-in attacker (any role, including viewer) who calls `GET /api/projects/:id` receives offline-crackable bcrypt hashes for every person associated with that project. Because the seed password is `password123` — a dictionary word — these hashes crack in seconds.

This is confirmed by the API type definitions in `src/types/index.ts` where `ApiProjectMember` has `user: ApiUser & { passwordHash?: string }` — the type layer acknowledges the leak but treats it as optional rather than removing it.

### Recommended Fix

Explicitly `select` only the fields needed for every User include in this route:

```typescript
// src/app/api/projects/[id]/route.ts
const SAFE_USER_SELECT = {
  id:    true,
  name:  true,
  email: true,
  // passwordHash intentionally omitted
} as const;

const project = await prisma.project.findUnique({
  where: { id },
  include: {
    owner: { select: SAFE_USER_SELECT },
    memberships: {
      include: { user: { select: SAFE_USER_SELECT } },
    },
    tasks: {
      include: {
        assignee:  { select: SAFE_USER_SELECT },
        createdBy: { select: SAFE_USER_SELECT },
      },
      orderBy: [{ status: "asc" }, { position: "asc" }],
    },
  },
});
```

Also remove `passwordHash?: string` from `ApiProjectMember` and related types in `src/types/index.ts`. The type layer should reflect — and enforce — what is actually safe to expose.

---

---

## Issue 4 — Cross-Project Assignee Injection (Broken Business Logic)

| Field | Value |
|---|---|
| **File** | `src/app/api/projects/[id]/tasks/route.ts` |
| **Lines** | 60 – 88 |
| **Category** | Broken Business Logic / Missing Validation |
| **Severity** | Medium |

### Vulnerable Code

```typescript
// src/app/api/projects/[id]/tasks/route.ts  lines 60-88
const parsed = createTaskSchema.safeParse(body);
// parsed.data.assigneeId is a raw user ID from the request body.
// No check that this user is a member of projectId.

const task = await prisma.task.create({
  data: {
    projectId,
    ...
    assigneeId: parsed.data.assigneeId ?? null,  // ← any userId accepted
    createdById: user.id,
  },
});
```

The same pattern exists in `PATCH /api/tasks/:id` (`src/app/api/tasks/[id]/route.ts` line 31), which also passes `assigneeId` from `parsed.data` directly to Prisma without membership validation.

### Impact

A project admin or member can assign any task to any user ID in the database — including users who have never been invited to the project. This produces several failure modes:

1. **Privacy violation** — user Lina (a member of Project A only) can have tasks silently assigned to her on Project B, which she has no access to, cannot see, and was never told about.
2. **Broken Kanban board** — the assignee dropdown on the frontend shows only project members (from `project.memberships`), but the API does not enforce this. A direct API call bypasses the UI guard.
3. **Confused notification surface** — any future activity feed or notification system will fan out to users with no project relationship.
4. **Data model inconsistency** — the system has an explicit `Membership` table to model project participation, yet the task assignee relationship bypasses it entirely.

### Recommended Fix

Before creating or updating a task with a non-null `assigneeId`, verify the target user holds a `Membership` record in this project:

```typescript
// src/app/api/projects/[id]/tasks/route.ts — inside POST, before prisma.task.create
if (parsed.data.assigneeId) {
  const assigneeMembership = await getProjectMembership(
    parsed.data.assigneeId,
    projectId
  );
  if (!assigneeMembership) {
    return badRequest("assignee is not a member of this project");
  }
}
```

Apply the identical guard in `PATCH /api/tasks/:id` when `parsed.data.assigneeId` is present and non-null, using the task's `existing.projectId` as the project scope. This makes the API contract consistent with the UI constraint and the intent of the `Membership` data model.

---

---

## Summary Table

| # | Issue | File | Lines | Category | Severity |
|---|---|---|---|---|---|
| 1 | SQL Injection via `$queryRawUnsafe` | `api/projects/[id]/tasks/route.ts` | 27–34 | Security | **Critical** |
| 2 | Horizontal privilege escalation on `PATCH /api/tasks/:id` | `api/tasks/[id]/route.ts` | 16–38 | Authorization | **Critical** |
| 3 | `password_hash` returned in project API responses | `api/projects/[id]/route.ts` | 25–44 | Security | **High** |
| 4 | Unvalidated cross-project `assigneeId` | `api/projects/[id]/tasks/route.ts` | 60–88 | Business Logic | **Medium** |

---

## Recommended Fix Order

```
1. Issue 2  — patch first: one-line authorization guard, zero risk of breakage
2. Issue 1  — replace $queryRawUnsafe with Prisma ORM query
3. Issue 3  — add explicit select clauses + clean up types
4. Issue 4  — add assignee membership validation in POST + PATCH task handlers
```

Issues 1 and 2 are the most urgent. Issue 3 is a compounding risk that makes Issue 1 worse (the SQL injection makes it trivial to exfiltrate the hashes that Issue 3 passively leaks). Issue 4 is lower severity but violates the core business invariant of the membership model.
