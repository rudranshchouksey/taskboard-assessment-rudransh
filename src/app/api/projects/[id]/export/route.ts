import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentUser,
  unauthorized,
  forbidden,
  getProjectMembership,
  canEditTasks,
} from "@/lib/auth";
import { isAirtableConfigured } from "@/lib/airtable";
import { exportTasksToAirtable } from "@/services/airtable-export.service";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();

  const { id: projectId } = await params;

  const membership = await getProjectMembership(user.id, projectId);
  if (!membership) return forbidden("you are not a member of this project");
  if (!canEditTasks(membership.role)) return forbidden("viewers cannot export tasks");

  if (!isAirtableConfigured()) {
    return NextResponse.json(
      { error: "Airtable is not configured on this server" },
      { status: 501 }
    );
  }

  const tasks = await prisma.task.findMany({
    where:   { projectId },
    include: { assignee: { select: { id: true, name: true, email: true } } },
    orderBy: { position: "asc" },
    take:    1000,
  });

  const summary = await exportTasksToAirtable(tasks);

  return NextResponse.json({ summary });
}
