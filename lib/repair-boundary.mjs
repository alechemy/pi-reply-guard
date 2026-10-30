import { digest } from "./catalog.mjs";

export function repairBoundary(event, { targetId, originalHash, result, isCurrent }) {
  if (!isCurrent() || event.outcome !== "completed" || event.continue || !result.selected) return;
  const entry = event.context.contextEntries.find((entry) => entry.sourceEntry.id === targetId);
  const message = entry?.messages.find((message) => message.role === "assistant");
  if (!message || message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return;
  const original = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (digest(original) !== originalHash || event.entries.some((entry) => entry.type === "context_edit" && entry.targetId === targetId)) return;
  const selected = result.selected;
  if (!selected.preserved || digest(selected.text) !== selected.id || selected.audit.candidateHash !== selected.id) return;
  return { entries: [
    ...event.entries,
    { type: "context_edit", targetId, replacement: { content: [{ type: "text", text: selected.text }] } },
    { type: "custom", customType: "reply-guard-repair", data: {
      termination: result.termination, selectedId: selected.id, audit: selected.audit,
      rewrites: result.rewrites, requestRewrites: result.requestRewrites ?? result.rewrites, writerUsage: result.writerUsage,
      candidates: result.candidates.map(({ id, audit, preserved }) => ({ id, audit, preserved })),
    } },
  ] };
}
