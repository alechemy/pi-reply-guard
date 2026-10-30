import { digest } from "./catalog.mjs";
import { auditCandidate } from "./evaluator.mjs";
import { JudgmentCache } from "./judgment-cache.mjs";
import { createIsolatedWriter, repairReply, validateRepairBounds } from "./repair.mjs";
import { repairBoundary, matchesPrepared } from "./repair-boundary.mjs";
import { DRAFT, RESULT, PREPARED, deliveredData, hasMarker, incompleteAudit, textOf, untag } from "./delivery.mjs";

export function registerRepairLifecycle(pi, loadSnapshot, presentation = {}) {
  let scope;
  let restart = false;
  let requestBudget;
  function budgetFor(ctx, fresh = false) {
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    const index = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
    const requestId = branch[index]?.id;
    if (fresh) requestBudget = { sessionId, rewrites: 0 };
    else if (requestBudget?.sessionId === sessionId && (!requestBudget.requestId || requestBudget.requestId === requestId)) requestBudget.requestId = requestId;
    else {
      const records = branch.slice(index + 1).filter((entry) => [RESULT, PREPARED].includes(entry.customType)).map((entry) => entry.data);
      requestBudget = { sessionId, requestId,
        rewrites: records.reduce((count, data) => Number.isSafeInteger(data?.requestRewrites) ? Math.max(count, data.requestRewrites) : count, 0),
        maxRewrites: records.find((data) => Number.isSafeInteger(data?.requestMaxRewrites) && data.requestMaxRewrites >= 0)?.requestMaxRewrites,
      };
    }
    return requestBudget;
  }
  function finishDraft(captured, reason, ctx) {
    if ((!captured?.draft && !captured?.pending?.prepared) || !ctx || ctx.sessionManager.getSessionId() !== captured.sessionId) return;
    const draft = captured.draft;
    if (draft && !ctx.sessionManager.getBranch().some((entry) => entry.customType === DRAFT && entry.data?.id === draft.id)) return;
    const result = captured.pending?.result;
    const data = deliveredData({ ...result, termination: reason, candidates: result?.candidates ?? [], rewrites: captured.budget.rewrites - captured.startRewrites, requestRewrites: captured.budget.rewrites, writerUsage: result?.writerUsage ?? null }, captured.snapshot, draft);
    data.targetId = captured.pending?.prepared?.targetId;
    data.audit ??= captured.audit ?? incompleteAudit(draft?.text ?? "", "Checking stopped before delivery.");
    pi.appendEntry(RESULT, data);
    presentation.status?.(data, ctx);
    captured.draft = undefined;
    captured.pending = undefined;
  }
  function invalidate(reason, ctx) {
    scope?.controller.abort();
    finishDraft(scope, reason, ctx);
    scope = undefined;
    restart = false;
  }
  for (const event of ["input", "session_shutdown", "session_tree", "session_before_tree", "session_before_switch", "session_before_fork"]) pi.on(event, (_event, ctx) => invalidate("cancelled", ctx));
  async function start(ctx, fresh = false) {
    const captured = { controller: new AbortController(), sessionId: ctx.sessionManager.getSessionId(), cache: new JudgmentCache(), budget: budgetFor(ctx, fresh) };
    scope = captured;
    try {
      const supplied = await loadSnapshot(ctx);
      if (scope !== captured || captured.controller.signal.aborted) return;
      const snapshot = { mode: "enforce", releasePolicy: "warning", maxRewrites: 2, writerDeadlineMs: 60000, ...supplied };
      if (!["off", "observe", "enforce"].includes(snapshot.mode) || !["warning", "strict"].includes(snapshot.releasePolicy)) throw new Error("Invalid operating mode or release policy.");
      validateRepairBounds(snapshot.maxRewrites, snapshot.writerDeadlineMs);
      captured.budget.maxRewrites ??= snapshot.maxRewrites;
      snapshot.maxRewrites = captured.budget.maxRewrites;
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
    if (event.message.role === "user") { invalidate("cancelled", ctx); await start(ctx, true); }
    if (event.message.role === "assistant") {
      budgetFor(ctx);
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
    captured.startRewrites = captured.budget.rewrites;
    captured.audit = undefined;
    const projected = ctx.sessionManager.buildSessionProjection().messages;
    const messages = filterGuardedMessages(presentation.messages?.(projected) ?? projected, ctx);
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
    const blocked = new Set(blockedTargets(branch));
    for (const draft of drafts) {
      const target = event.context.contextEntries.find((entry) => entry.sourceEntry.type === "message" && hasMarker(entry.sourceEntry.message, draft.markers));
      if (draft.id === skipId || results.get(draft.id)?.delivery === "released") { blocked.delete(target?.sourceEntry.id); continue; }
      if (target) blocked.add(target.sourceEntry.id);
    }
    for (const targetId of blocked) {
      const target = event.context.contextEntries.find((entry) => entry.sourceEntry.id === targetId);
      if (!target?.messages.length || entries.some((entry) => entry.type === "context_edit" && entry.targetId === targetId && entry.replacement === null)) continue;
      entries.push({ type: "context_edit", targetId, replacement: null });
    }
    return entries;
  }
  function blockedTargets(branch) {
    const targets = new Map(branch.filter((entry) => entry.customType === DRAFT).map(({ data }) => [data.id,
      branch.find((entry) => entry.type === "message" && hasMarker(entry.message, data.markers))?.id,
    ]));
    const states = new Map([...targets.values()].filter(Boolean).map((id) => [id, "pending"]));
    for (const entry of branch) {
      if (![PREPARED, RESULT].includes(entry.customType) || entry.data?.mode === "observe") continue;
      const targetId = entry.data?.targetId ?? targets.get(entry.data?.draftId);
      if (targetId) states.set(targetId, entry.data.delivery);
    }
    return [...states].filter(([, delivery]) => delivery !== "released").map(([targetId]) => targetId);
  }
  function filterGuardedMessages(messages, ctx) {
    const blocked = new Set(blockedTargets(ctx.sessionManager.getBranch?.() ?? []));
    if (scope?.pending?.prepared?.mode === "enforce") blocked.add(scope.pending.prepared.targetId);
    if (!blocked.size) return messages;
    const fingerprints = new Set(ctx.sessionManager.buildSessionProjection().entries.filter((entry) => blocked.has(entry.sourceEntry.id)).flatMap((entry) => entry.messages.map((message) => JSON.stringify(message))));
    return messages.filter((message) => !fingerprints.has(JSON.stringify(message)));
  }
  pi.on("context", (event, ctx) => ({ messages: filterGuardedMessages(event.messages, ctx) }));
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
        result = await repairReply({ ...pending.input, writer: (...args) => { captured.budget.rewrites++; return captured.writer(...args); }, isCurrent: pending.isCurrent,
          signal: AbortSignal.any([pending.input.signal, ctx.signal]), maxRewrites: Math.max(0, captured.snapshot.maxRewrites - captured.budget.rewrites),
          audit: (input) => input.baseline === undefined && digest(input.text) === pending.hash ? Promise.resolve(pending.audit) : auditCandidate(input),
        });
      }
      result.requestRewrites = captured.budget.rewrites;
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
    result.requestRewrites = captured.budget.rewrites;
    const boundary = repairBoundary(base, { targetId: target.sourceEntry.id, originalHash: pending.hash, result, isCurrent: pending.isCurrent, snapshot: captured.snapshot, draft });
    if (boundary) pending.prepared = structuredClone(boundary.entries.at(-1).data);
    return boundary ?? unchanged();
  });
  for (const event of ["session_start", "session_tree"]) pi.on(event, (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    const completed = new Set(branch.filter((entry) => entry.customType === RESULT).map((entry) => entry.data?.draftId));
    for (const entry of branch.filter((entry) => entry.customType === DRAFT && !completed.has(entry.data?.id))) {
      const draft = entry.data;
      const prepared = branch.findLast((entry) => entry.customType === PREPARED && entry.data?.draftId === draft.id)?.data;
      pi.appendEntry(RESULT, { ...deliveredData({ termination: "interrupted", candidates: [], rewrites: null, requestRewrites: prepared?.requestRewrites, writerUsage: null }, draft, draft), targetId: prepared?.targetId, audit: incompleteAudit(draft.text, "The session ended before delivery.") });
    }
    presentation.restore?.(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    const captured = scope;
    const pending = captured?.pending;
    const prepared = pending?.prepared;
    if (prepared) {
      const expected = matchesPrepared(ctx.sessionManager.buildSessionProjection(), prepared);
      const committed = ctx.sessionManager.getBranch().some((entry) => entry.customType === PREPARED && entry.data?.targetId === prepared.targetId && entry.data?.selectedId === prepared.selectedId);
      if (event.aborted || !pending.isCurrent()) finishDraft(captured, "cancelled", ctx);
      else if (!expected || !committed) finishDraft(captured, "superseded", ctx);
      else {
        const { intendedDelivery, ...data } = prepared;
        data.delivery = intendedDelivery;
        pi.appendEntry(RESULT, data);
        captured.draft = undefined;
        captured.pending = undefined;
        presentation.status?.(data, ctx);
      }
    } else if (captured?.draft) finishDraft(captured, "cancelled", ctx);
    presentation.restore?.(ctx);
  });
  return { changeMode: (mode, ctx) => { invalidate("mode-changed", ctx); restart = true; presentation.mode?.(mode, ctx); } };
}
