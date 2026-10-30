import { digest } from "./catalog.mjs";
import { deliveredData, RESULT, textOf, untag } from "./delivery.mjs";

export function repairBoundary(event, { targetId, originalHash, result, isCurrent, snapshot = {}, draft }) {
  if (!isCurrent() || event.outcome !== "completed" || event.continue || !result.selected) return;
  const entry = event.context.contextEntries.find((entry) => entry.sourceEntry.id === targetId);
  const message = entry?.messages.find((message) => message.role === "assistant");
  if (!message || message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return;
  if (digest(textOf(untag(message, draft?.markers).content)) !== originalHash || event.entries.some((entry) => entry.type === "context_edit" && entry.targetId === targetId)) return;
  const selected = result.selected;
  if (!selected.preserved || digest(selected.text) !== selected.id || selected.audit.candidateHash !== selected.id) return;
  const data = { ...deliveredData(result, snapshot, draft), targetId };
  return { entries: [
    ...event.entries,
    ...(snapshot.mode === "observe" ? [] : [{ type: "context_edit", targetId, replacement: data.delivery === "released" ? { content: [{ type: "text", text: selected.text }] } : null }]),
    { type: "custom", customType: RESULT, data },
  ] };
}
