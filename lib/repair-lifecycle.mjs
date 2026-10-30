import { digest } from "./catalog.mjs";
import { auditCandidate } from "./evaluator.mjs";
import { JudgmentCache } from "./judgment-cache.mjs";
import { createIsolatedWriter, repairReply, validateRepairBounds } from "./repair.mjs";
import { repairBoundary } from "./repair-boundary.mjs";

const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";

export function registerRepairLifecycle(pi, loadSnapshot) {
  let scope;
  function invalidate() {
    scope?.controller.abort();
    scope = undefined;
  }
  for (const event of ["input", "session_shutdown", "session_tree", "session_before_switch", "session_before_fork"]) pi.on(event, invalidate);
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      invalidate();
      scope = { controller: new AbortController(), sessionId: ctx.sessionManager.getSessionId(), cache: new JudgmentCache(), rewrites: 0 };
    }
    if (event.message.role === "assistant" && scope) scope.pending = undefined;
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return;
    const text = textOf(message.content);
    if (!text.trim() || !scope) return;
    const captured = scope;
    const isCurrent = () => scope === captured && !captured.controller.signal.aborted && !ctx.signal?.aborted && ctx.sessionManager.getSessionId() === captured.sessionId;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, captured.controller.signal]) : captured.controller.signal;
    try {
      if (!captured.snapshot) {
        const snapshot = await loadSnapshot(ctx);
        if (!isCurrent()) return;
        const adapter = snapshot.adapter;
        const maxRewrites = snapshot.maxRewrites === undefined ? 2 : snapshot.maxRewrites;
        const writerDeadlineMs = snapshot.writerDeadlineMs === undefined ? 60000 : snapshot.writerDeadlineMs;
        validateRepairBounds(maxRewrites, writerDeadlineMs);
        captured.snapshot = { ...snapshot, maxRewrites, writerDeadlineMs,
          adapter: { identity: structuredClone(adapter.identity), available: adapter.available, classify: adapter.classify.bind(adapter) },
          verbatim: structuredClone(snapshot.verbatim ?? []), limits: structuredClone(snapshot.limits ?? {}), generation: structuredClone(snapshot.generation ?? {}),
        };
        captured.writer = createIsolatedWriter(ctx.modelRegistry, ctx.model, { reasoning: ctx.thinkingLevel, ...captured.snapshot.generation });
      }
      const messages = ctx.sessionManager.buildSessionProjection().messages;
      const userIndex = messages.findLastIndex((message) => message.role === "user");
      const request = userIndex < 0 ? "" : textOf(messages[userIndex].content);
      const conversation = messages.slice(0, userIndex < 0 ? 0 : userIndex).filter((message) => ["user", "assistant"].includes(message.role))
        .map((message) => ({ role: message.role, text: textOf(message.content) }));
      const input = { ...captured.snapshot, text, request, conversation, cache: captured.cache, signal };
      const audit = await auditCandidate(input);
      if (isCurrent()) captured.pending = { input, audit, hash: digest(text), isCurrent };
    } catch {
      if (isCurrent()) captured.pending = { error: "Reply guard configuration or audit could not be completed.", isCurrent };
    }
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    const captured = scope;
    const pending = captured?.pending;
    if (!pending || !pending.isCurrent() || event.continue || event.outcome !== "completed") return;
    captured.pending = undefined;
    if (pending.error) return { entries: [...event.entries, { type: "custom", customType: "reply-guard-repair", data: { status: "incomplete", termination: "configuration-error", error: pending.error } }] };
    const target = event.context.contextEntries.findLast((entry) => entry.messages.some((message) => message.role === "assistant" && digest(textOf(message.content)) === pending.hash));
    if (!target || event.entries.some((entry) => entry.type === "context_edit" && entry.targetId === target.sourceEntry.id)) return;
    const result = await repairReply({
      ...pending.input, writer: captured.writer, isCurrent: pending.isCurrent,
      maxRewrites: Math.max(0, (pending.input.maxRewrites ?? 2) - captured.rewrites),
      audit: (input) => input.baseline === undefined && digest(input.text) === pending.hash ? Promise.resolve(pending.audit) : auditCandidate(input),
    });
    captured.rewrites += result.rewrites;
    result.requestRewrites = captured.rewrites;
    if (!pending.isCurrent() || ctx.signal?.aborted) return;
    return repairBoundary(event, { targetId: target.sourceEntry.id, originalHash: pending.hash, result, isCurrent: pending.isCurrent });
  });
}
