import { digest } from "./catalog.mjs";

export const DRAFT = "reply-guard-draft";
export const RESULT = "reply-guard-repair";
export const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
export const hasMarker = (message, markers) => Array.isArray(message?.content) && message.content.some((block) => block.type === "text" && markers.some((marker) => block.text.endsWith(marker)));
export function untag(message, markers = []) {
  return { ...message, content: message.content.map((block) => block.type !== "text" ? block : {
    ...block, text: markers.reduce((text, marker) => text.endsWith(marker) ? text.slice(0, -marker.length) : text, block.text),
  }) };
}
export function incompleteAudit(text, error) {
  return { candidateHash: digest(text), status: "incomplete", incomplete: true, coverageComplete: false, advisoryIncomplete: true, checks: [], error };
}
export function decideDelivery(result, { mode = "enforce", releasePolicy = "warning" } = {}) {
  if (!result.selected || ["cancelled", "superseded", "mode-changed"].includes(result.termination)) return "withheld";
  if (mode === "observe") return "released";
  return releasePolicy === "strict" && (result.selected.audit.status !== "passed" || result.selected.audit.incomplete || !result.selected.preserved) ? "withheld" : "released";
}
export function deliveredData(result, snapshot = {}, draft) {
  const delivery = decideDelivery(result, snapshot);
  const selected = result.selected;
  return {
    schemaVersion: 2, draftId: draft?.id, mode: snapshot.mode ?? "enforce", releasePolicy: snapshot.releasePolicy ?? "warning",
    delivery, termination: result.termination, selectedId: selected?.id, audit: selected?.audit,
    showVerdicts: snapshot.showVerdicts !== false, debug: snapshot.debug === true, draft: selected?.text ?? draft?.text,
    ...(delivery === "released" && snapshot.mode !== "observe" ? { reply: selected.text } : {}),
    rewrites: result.rewrites, requestRewrites: result.requestRewrites ?? result.rewrites, writerUsage: result.writerUsage,
    candidates: result.candidates.map(({ id, audit, preserved }) => ({ id, audit, preserved })),
  };
}
