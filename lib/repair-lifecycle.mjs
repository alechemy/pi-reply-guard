import { digest } from "./catalog.mjs";
import { auditCandidate } from "./evaluator.mjs";
import { JudgmentCache } from "./judgment-cache.mjs";
import { createIsolatedWriter, repairReply, validateRepairBounds } from "./repair.mjs";
import { repairBoundary } from "./repair-boundary.mjs";
import { DRAFT, RESULT, deliveredData, hasMarker, incompleteAudit, textOf, untag } from "./delivery.mjs";

export function registerRepairLifecycle(pi, loadSnapshot, presentation = {}) {
  let scope;
  let restart = false;
  function finishDraft(captured, reason, ctx) {
    if (!captured?.draft || !ctx || ctx.sessionManager.getSessionId() !== captured.sessionId) return;
    const draft = captured.draft;
    if (!ctx.sessionManager.getBranch().some((entry) => entry.customType === DRAFT && entry.data?.id === draft.id)) return;
    const result = captured.pending?.result;
    const data = deliveredData({ ...result, termination: reason, candidates: result?.candidates ?? [], rewrites: captured.rewrites - captured.startRewrites, requestRewrites: captured.rewrites, writerUsage: result?.writerUsage ?? null }, captured.snapshot, draft);
    data.audit ??= captured.audit ?? incompleteAudit(draft.text, "Checking stopped before delivery.");
    pi.appendEntry(RESULT, data);
    presentation.status?.(data, ctx);
    captured.draft = undefined;
  }
  function invalidate(reason, ctx) {
    scope?.controller.abort();
    finishDraft(scope, reason, ctx);
    scope = undefined;
    restart = false;
  }
  for (const event of ["input", "session_shutdown", "session_tree", "session_before_tree", "session_before_switch", "session_before_fork"]) pi.on(event, (_event, ctx) => invalidate("cancelled", ctx));
  async function start(ctx) {
    const captured = { controller: new AbortController(), sessionId: ctx.sessionManager.getSessionId(), cache: new JudgmentCache(), rewrites: 0 };
    scope = captured;
    try {
      const supplied = await loadSnapshot(ctx);
      if (scope !== captured || captured.controller.signal.aborted) return;
      const snapshot = { mode: "enforce", releasePolicy: "warning", maxRewrites: 2, writerDeadlineMs: 60000, ...supplied };
      if (!["off", "observe", "enforce"].includes(snapshot.mode) || !["warning", "strict"].includes(snapshot.releasePolicy)) throw new Error("Invalid operating mode or release policy.");
      validateRepairBounds(snapshot.maxRewrites, snapshot.writerDeadlineMs);
      const adapter = snapshot.adapter;
      captured.snapshot = { ...snapshot,
        adapter: adapter ? { identity: structuredClone(adapter.identity), available: adapter.available, classify: adapter.classify.bind(adapter) } : undefined,
        verbatim: structuredClone(snapshot.verbatim ?? []), limits: structuredClone(snapshot.limits ?? {}), generation: structuredClone(snapshot.generation ?? {}),
      };
      if (snapshot.mode === "enforce" && !snapshot.error) captured.writer = createIsolatedWriter(ctx.modelRegistry, ctx.model, { reasoning: ctx.thinkingLevel, ...captured.snapshot.generation });
    } catch {
      captured.snapshot = { mode: "enforce", releasePolicy: "strict", maxRewrites: 0, error: "Configuration could not be loaded. Inspect /reply-guard status." };
    }
    if (scope === captured) presentation.mode?.(captured.snapshot.mode, ctx);
  }
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "user") { invalidate("cancelled", ctx); await start(ctx); }
    if (event.message.role === "assistant") {
      if (!scope && !ctx.signal?.aborted) await start(ctx);
      if (scope) { finishDraft(scope, "superseded", ctx); scope.pending = undefined; }
    }
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return;
    const text = textOf(message.content);
    if (!text.trim()) return;
    if (restart && !scope) { restart = false; await start(ctx); }
    if (!scope?.snapshot || scope.snapshot.mode === "off") return;
    const captured = scope;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, captured.controller.signal]) : captured.controller.signal;
    const isCurrent = () => scope === captured && !signal.aborted && !ctx.signal?.aborted && ctx.sessionManager.getSessionId() === captured.sessionId;
    const decorated = captured.snapshot.mode === "enforce" ? presentation.begin?.(message, captured.snapshot, ctx) : undefined;
    captured.draft = decorated?.draft;
    captured.startRewrites = captured.rewrites;
    captured.audit = undefined;
    const projected = ctx.sessionManager.buildSessionProjection().messages;
    const messages = presentation.messages?.(projected) ?? projected;
    const userIndex = messages.findLastIndex((message) => message.role === "user");
    const request = userIndex < 0 ? "" : textOf(messages[userIndex].content);
    const conversation = messages.slice(0, userIndex < 0 ? 0 : userIndex).filter((message) => ["user", "assistant"].includes(message.role))
      .map((message) => ({ role: message.role, text: textOf(message.content) }));
    const input = { ...captured.snapshot, text, request, conversation, cache: captured.cache, signal };
    let audit;
    try { audit = captured.snapshot.error ? incompleteAudit(text, captured.snapshot.error) : await auditCandidate(input); }
    catch { audit = incompleteAudit(text, "Audit could not be completed."); }
    if (isCurrent()) { captured.audit = audit; captured.pending = { input, audit, hash: digest(text), isCurrent }; }
    return decorated ? { message: decorated.message } : undefined;
  });
  function cleanup(event, ctx, skipId) {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    const drafts = branch.filter((entry) => entry.customType === DRAFT).map((entry) => entry.data);
    const results = new Map(branch.filter((entry) => entry.customType === RESULT).map((entry) => [entry.data?.draftId, entry.data]));
    const entries = [...event.entries];
    for (const draft of drafts) {
      if (draft.id === skipId || results.get(draft.id)?.delivery === "released") continue;
      const target = event.context.contextEntries.find((entry) => entry.sourceEntry.type === "message" && hasMarker(entry.sourceEntry.message, draft.markers));
      if (!target?.messages.length || entries.some((entry) => entry.type === "context_edit" && entry.targetId === target.sourceEntry.id && entry.replacement === null)) continue;
      entries.push({ type: "context_edit", targetId: target.sourceEntry.id, replacement: null });
    }
    return entries;
  }
  function targetFor(event, pending, draft) {
    return event.context.contextEntries.findLast((entry) => entry.messages.some((message) => message.role === "assistant" && digest(textOf(untag(message, draft?.markers).content)) === pending.hash));
  }
  function originalResult(captured, pending) {
    const selected = { id: pending.hash, text: pending.input.text, audit: pending.audit, preserved: true };
    const termination = captured.snapshot.error ? "configuration-error" : captured.snapshot.mode === "observe" ? "observed" : pending.audit.status === "passed" ? "passed" : "repair-unavailable";
    return { selected, candidates: [selected], termination, rewrites: 0, writerUsage: [] };
  }
  pi.on("turn_end", async (event, ctx) => {
    const captured = scope;
    const pending = captured?.pending;
    if (pending?.isCurrent() && event.outcome === "completed" && !event.continue && targetFor(event, pending, captured.draft)) {
      let result = originalResult(captured, pending);
      if (captured.snapshot.mode === "enforce" && !captured.snapshot.error && ctx.signal) {
        result = await repairReply({ ...pending.input, writer: (...args) => { captured.rewrites++; return captured.writer(...args); }, isCurrent: pending.isCurrent,
          signal: AbortSignal.any([pending.input.signal, ctx.signal]), maxRewrites: Math.max(0, captured.snapshot.maxRewrites - captured.rewrites),
          audit: (input) => input.baseline === undefined && digest(input.text) === pending.hash ? Promise.resolve(pending.audit) : auditCandidate(input),
        });
      }
      result.requestRewrites = captured.rewrites;
      if (pending.isCurrent()) pending.result = result;
      else { finishDraft(captured, "cancelled", ctx); captured.pending = undefined; }
    }
    const entries = cleanup(event, ctx, scope?.pending?.isCurrent() ? scope.draft?.id : undefined);
    if (entries.length !== event.entries.length) return { entries };
  });
  pi.on("agent_before_settle", (event, ctx) => {
    const captured = scope;
    const pending = captured?.pending;
    const entries = cleanup(event, ctx, pending?.isCurrent() && event.outcome === "completed" ? captured.draft?.id : undefined);
    const base = { ...event, entries };
    const unchanged = () => entries.length === event.entries.length ? undefined : { entries };
    if (!pending || !pending.isCurrent() || event.continue || event.outcome !== "completed") return unchanged();
    const draft = captured.draft;
    const target = targetFor(event, pending, draft);
    if (!target || event.entries.some((entry) => entry.type === "context_edit" && entry.targetId === target.sourceEntry.id)) {
      finishDraft(captured, "superseded", ctx);
      captured.pending = undefined;
      return { entries: cleanup(base, ctx) };
    }
    const result = pending.result ?? originalResult(captured, pending);
    result.requestRewrites = captured.rewrites;
    const boundary = repairBoundary(base, { targetId: target.sourceEntry.id, originalHash: pending.hash, result, isCurrent: pending.isCurrent, snapshot: captured.snapshot, draft });
    captured.pending = undefined;
    if (boundary) {
      captured.draft = undefined;
      presentation.status?.(boundary.entries.at(-1).data, ctx);
    }
    return boundary ?? unchanged();
  });
  for (const event of ["session_start", "session_tree"]) pi.on(event, (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    const completed = new Set(branch.filter((entry) => entry.customType === RESULT).map((entry) => entry.data?.draftId));
    for (const entry of branch.filter((entry) => entry.customType === DRAFT && !completed.has(entry.data?.id))) {
      const draft = entry.data;
      pi.appendEntry(RESULT, { ...deliveredData({ termination: "interrupted", candidates: [], rewrites: null, writerUsage: null }, draft, draft), audit: incompleteAudit(draft.text, "The session ended before delivery.") });
    }
    presentation.restore?.(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (scope?.draft) finishDraft(scope, "cancelled", ctx);
    presentation.restore?.(ctx);
  });
  return { changeMode: (mode, ctx) => { invalidate("mode-changed", ctx); restart = true; presentation.mode?.(mode, ctx); } };
}
