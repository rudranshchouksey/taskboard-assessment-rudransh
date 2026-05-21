-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('task_created', 'status_changed', 'assignee_changed', 'comment_added');

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "meta" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Supports the feed query: WHERE project_id = ? ORDER BY created_at DESC LIMIT 50
CREATE INDEX "activities_project_id_created_at_idx" ON "activities"("project_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Note: task_id has no FK intentionally.
-- Activities are durable historical records; the task title is stored in meta.taskTitle
-- so the feed remains readable even after a task is deleted.
