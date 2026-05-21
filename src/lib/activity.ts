import { prisma } from "./prisma";

export type ActivityType =
  | "task_created"
  | "status_changed"
  | "assignee_changed"
  | "comment_added";

export interface ActivityData {
  projectId: string;
  taskId?: string | null;
  actorId: string;
  type: ActivityType;
  meta: Record<string, unknown>;
}

/**
 * Write an activity record without blocking the caller.
 *
 * Uses void + .catch so that a DB failure here never affects the HTTP response
 * that has already been returned. Events may be lost if the write fails —
 * acceptable for a feed; see DESIGN_NOTES.md for the trade-off and rollback plan.
 */
export function recordActivity(data: ActivityData): void {
  void prisma.activity
    .create({
      data: {
        projectId: data.projectId,
        taskId:    data.taskId ?? null,
        actorId:   data.actorId,
        type:      data.type,
        meta:      data.meta,
      },
    })
    .catch((err: unknown) => {
      console.error("[activity] write failed:", err);
    });
}
