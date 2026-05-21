"use client";

import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, getStoredUser } from "@/lib/api-client";
import type { ApiComment, ApiTask, ApiProjectMember, TaskStatus } from "@/types";
import { STATUS_LABELS, STATUS_ORDER } from "@/types";

function formatRelative(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

type Props = {
  task: ApiTask;
  projectId: string;
  members: ApiProjectMember[];
  onClose: () => void;
};

export function TaskDetail({ task, projectId, members, onClose }: Props) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [assigneeId, setAssigneeId] = useState<string>(task.assigneeId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const commentListRef = useRef<HTMLDivElement>(null);

  const currentUser = getStoredUser();
  const myMembership = members.find((m) => m.user.id === currentUser?.id);
  const canComment = myMembership?.role === "admin" || myMembership?.role === "member";

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ["comments", task.id],
    queryFn: () => apiFetch<{ comments: ApiComment[] }>(`/api/tasks/${task.id}/comments`),
  });

  const postComment = useMutation({
    mutationFn: (body: string) =>
      apiFetch<{ comment: ApiComment }>(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setCommentBody("");
      queryClient.invalidateQueries({ queryKey: ["comments", task.id] });
      // Scroll to bottom after refetch settles
      setTimeout(() => {
        commentListRef.current?.scrollTo({ top: commentListRef.current.scrollHeight, behavior: "smooth" });
      }, 100);
    },
    onError: (err) => setCommentError(err instanceof Error ? err.message : "post failed"),
  });

  const updateTask = useMutation({
    mutationFn: (input: Partial<ApiTask>) =>
      apiFetch<{ task: ApiTask }>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "save failed"),
  });

  const deleteTask = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>(`/api/tasks/${task.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "delete failed"),
  });

  function onSave() {
    setError(null);
    updateTask.mutate({
      title,
      description,
      status,
      assigneeId: assigneeId || null,
    });
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center px-4 z-50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-surface border border-border rounded-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">edit task</h2>
          <button onClick={onClose} className="text-muted hover:text-white">
            ✕
          </button>
        </div>

        <label className="block mb-3">
          <span className="text-xs text-muted">title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 block w-full rounded-md bg-bg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        <label className="block mb-3">
          <span className="text-xs text-muted">description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="mt-1 block w-full rounded-md bg-bg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <label className="block">
            <span className="text-xs text-muted">status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="mt-1 block w-full rounded-md bg-bg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none"
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-muted">assignee</span>
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="mt-1 block w-full rounded-md bg-bg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none"
            >
              <option value="">unassigned</option>
              {members.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="text-sm text-red-400 mb-3" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => deleteTask.mutate()}
            disabled={deleteTask.isPending}
            className="text-sm text-red-400 hover:text-red-300"
          >
            delete task
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-sm px-4 py-2 rounded-md border border-border hover:border-muted"
            >
              cancel
            </button>
            <button
              onClick={onSave}
              disabled={updateTask.isPending}
              className="text-sm px-4 py-2 rounded-md bg-accent text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {updateTask.isPending ? "saving…" : "save"}
            </button>
          </div>
        </div>

        {/* comments */}
        <div className="mt-6 pt-5 border-t border-border">
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            comments
          </h3>

          <div
            ref={commentListRef}
            className="space-y-3 max-h-48 overflow-y-auto mb-4"
          >
            {commentsLoading && (
              <p className="text-xs text-muted">loading…</p>
            )}
            {!commentsLoading && commentsData?.comments.length === 0 && (
              <p className="text-xs text-muted">no comments yet</p>
            )}
            {commentsData?.comments.map((c) => (
              <div key={c.id} className="text-sm">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium">{c.author.name}</span>
                  <span className="text-xs text-muted">{formatRelative(c.createdAt)}</span>
                </div>
                <p className="text-muted whitespace-pre-wrap break-words">{c.body}</p>
              </div>
            ))}
          </div>

          {canComment ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!commentBody.trim()) return;
                setCommentError(null);
                postComment.mutate(commentBody.trim());
              }}
              className="flex flex-col gap-2"
            >
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="add a comment…"
                rows={2}
                className="block w-full rounded-md bg-bg border border-border px-3 py-2 text-sm focus:border-accent focus:outline-none resize-none"
              />
              {commentError && (
                <p className="text-xs text-red-400" role="alert">{commentError}</p>
              )}
              <button
                type="submit"
                disabled={postComment.isPending || !commentBody.trim()}
                className="self-end text-sm px-4 py-1.5 rounded-md bg-accent text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {postComment.isPending ? "posting…" : "post"}
              </button>
            </form>
          ) : (
            <p className="text-xs text-muted">viewers can read but not post comments</p>
          )}
        </div>
      </div>
    </div>
  );
}
