import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentUser,
  unauthorized,
  forbidden,
  getProjectMembership,
} from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

const ACTOR_SELECT = { id: true, name: true, email: true } as const;

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();

  const { id: projectId } = await params;

  const membership = await getProjectMembership(user.id, projectId);
  if (!membership) return forbidden("you are not a member of this project");

  const activities = await prisma.activity.findMany({
    where:   { projectId },
    include: { actor: { select: ACTOR_SELECT } },
    orderBy: { createdAt: "desc" },
    take:    50,
  });

  return NextResponse.json({ activities });
}
