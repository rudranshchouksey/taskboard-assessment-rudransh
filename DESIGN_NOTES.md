# Design Notes — Activity Feed

## Architecture overview

Activity events are written by the same API process that handles task and comment
mutations. There is no separate service, queue, or worker. Three routes emit events:

| Route | Event |
|---|---|
| `POST /api/projects/:id/tasks` | `task_created` |
| `PATCH /api/tasks/:id` | `status_changed`, `assignee_changed` (one per changed field) |
| `POST /api/tasks/:id/comments` | `comment_added` |

Each event is stored as a row in the `activities` table with a `meta: JSONB` column
that holds event-specific data (task title, old/new values). The task title is
denormalised into `meta.taskTitle` so the feed remains readable after a task is deleted.

---

## Non-blocking writes

Activity writes use **fire-and-forget**:

```typescript
// src/lib/activity.ts
export function recordActivity(data: ActivityData): void {
  void prisma.activity
    .create({ data })
    .catch((err) => console.error("[activity] write failed:", err));
}
```

`void` discards the Promise. The HTTP response is returned before the activity write
settles. If the write fails the error is logged but never surfaced to the caller.

**Trade-off accepted:** events can be silently lost on DB failure. For a project
management tool this is acceptable — a missing feed entry is far less disruptive than
a failed task update. If guaranteed delivery is required later, replace the
`prisma.activity.create` call with a queue write (see upgrade path below).

---

## Rollback strategy

### Remove the activity feed entirely

```sql
-- 1. Drop the table and enum (no other table references activities)
DROP TABLE IF EXISTS "activities";
DROP TYPE IF EXISTS "ActivityType";
```

Then:
- Delete `prisma/migrations/20260103000000_add_activity/`
- Remove the `Activity` model and `ActivityType` enum from `prisma/schema.prisma`
- Remove the `activities` / `activity` back-relations from `User` and `Project` models
- Delete `src/lib/activity.ts`
- Remove the three `recordActivity(...)` call sites from the task and comment routes
- Delete `src/app/api/projects/[id]/activity/route.ts`
- Remove the `["activity", id]` query and the feed section from the project page
- Remove `ActivityType` and `ApiActivity` from `src/types/index.ts`

Because `activities` has no inbound foreign keys from other tables, the drop is safe
and requires no cascade handling.

### Roll back just the schema (keep code, disable feature)

Comment out the `recordActivity` call sites and delete the route. The table can
remain in the DB unused until a clean migration window is available.

---

## Upgrade path: guaranteed delivery

Replace the fire-and-forget write with a durable queue enqueue:

```typescript
// src/lib/activity.ts (upgraded)
import { queue } from "@/lib/queue"; // e.g. BullMQ

export function recordActivity(data: ActivityData): void {
  void queue.add("activity", data).catch((err) =>
    console.error("[activity] enqueue failed:", err)
  );
}
```

A separate worker process dequeues and writes to the DB with retries. The call sites
in the route handlers do not change — they remain fire-and-forget from their perspective.

---

## Authorization

The feed is **read-only** and scoped to a project. All roles (admin, member, viewer)
can read. No role can write to the feed directly — events are system-generated only.

`GET /api/projects/:id/activity` enforces:
1. Valid JWT (`getCurrentUser`)
2. Caller holds a `Membership` row for the project (`getProjectMembership`)

---

## Data model decisions

| Decision | Rationale |
|---|---|
| `taskId` has no FK constraint | Activities survive task deletion; `meta.taskTitle` preserves readability |
| `meta: JSONB` (not typed columns) | Four event shapes without four separate tables or nullable columns |
| `@@index([projectId, createdAt(sort: Desc)])` | Covers the only query: latest 50 for a project |
| `take: 50` hard limit | Avoids unbounded scans; pagination can be added without changing the schema |
| Denormalise actor name via `include` at read time | Avoids stale names if user renames; join cost is negligible at 50 rows |
