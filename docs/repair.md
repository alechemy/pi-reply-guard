# Preservation and isolated repair

The repair engine audits each revision against the original draft and selects the latest candidate that passes preservation checks. Its Pi lifecycle adapter audits at `message_end`, repairs at `turn_end`, prepares a context edit at `agent_before_settle`, and confirms delivery at `agent_settled`.

The package entry point uses this lifecycle on Pi 1.4.0. [Delivery and operating modes](delivery.md) documents warning and strict policies, terminal suppression, and draft recovery.

## Required preservation checks

Passing `baseline: originalView` to `auditCandidate()` adds a literal comparison and nine mandatory semantic conditions:

| Condition | Required preservation |
| --- | --- |
| Negation | Whether each claim is affirmed or denied. |
| Conditions | Prerequisites, exceptions, temporal order, and causal relationships. |
| Scope | Subjects, quantifiers, and applicability. |
| Uncertainty | Confidence and the distinction between evidence and interpretation. |
| Attribution | Sources, actors, authorship, and point of view. |
| Obligation | Permission, prohibition, recommendations, and requirements. |
| Quantities | Values, units, comparisons, and their association with the same subjects and claims. |
| Invention | No unsupported facts, examples, mechanisms, causes, or personal experiences. |
| Omission | Useful meaning, necessary limitations, and instructions remain intact. |

The literal comparison checks protected bytes, multiplicity, order, and newly introduced wrappers. Explicit reproduction sources from the consumed request enter the original baseline and every revision's protection map. Semantic checks compare the complete exact original and revision. Oversized comparisons remain incomplete.

For each semantic condition, `P(damage) <= 0.1` clears the check. Values at or above 0.9 indicate a violation. Intermediate values, missing answers, and malformed answers remain inconclusive. These experimental thresholds are uncalibrated. Every condition must clear before a revision can become a delivery candidate. Semantic style checks retain their advisory status.

Preservation uses the same candidate deadline, concurrency, request budget, and input budget as style evaluation. Required preservation questions are scheduled first. Any omitted style coverage remains visible. The original's identity comparison is trivial and does not certify its factual accuracy.

`test/fixtures/preservation.mjs` contains synthetic cases for these conditions, including swapped quantity associations and invented experience. Tests inject the corresponding judgments. The fixtures establish acceptance behavior, not classifier accuracy.

## Repair bounds

`repairReply()` defaults to two additional writer generations and a 60-second deadline per generation. The original and every completed revision receive an audit attempt. A zero cap audits only the original. Identical candidates and cycles reuse the exact candidate's verdict and stop without another classification.

The fallback starts as the original. A preserved revision becomes the new fallback even if style violations remain. A damaged or inconclusive revision cannot replace it. Further repairs start from the fallback, retain the original as the meaning reference, and receive fixed guidance plus the rejected revision's preservation findings when relevant.

Empty output, malformed output, truncation, provider errors, and attempted tool calls consume the reserved writer attempt and stop repair. Deadline and cancellation checks discard late completions. Cancelled or superseded work returns no selected candidate.

## Writer isolation

`createIsolatedWriter()` calls `ctx.modelRegistry.streamSimple(...).result()`. The extension registry does not expose the model runtime's `completeSimple()` method.

The writer uses the selected model, its model-level defaults, and the supplied applicable generation settings. The adapter retains thinking level, temperature, sampling parameters, output limit, transport, cache preference, and session identifier. It rejects sampling overrides that would replace messages, tools, or other request structure.

Each call has an empty tool list, `toolChoice: "none"`, disabled deferred generation, and zero transport retries. The adapter has no tool executor or continuation loop. Tool-call responses are protocol failures. Main-agent tool state is unchanged.

Repair input contains the full original, current fallback, relevant request, visible conversation, fixed preservation constraints, and findings from identified passages. Only user and assistant text enters conversation context. Hidden reasoning, tool results, and extra message fields are excluded.

Each reserved generation records its usage separately. Missing usage remains unknown. Missing or all-zero catalog pricing produces unknown cost. These records are stored in `reply-guard-repair` metadata. Pi's ordinary assistant usage remains attached to the original raw entry.

## Lifecycle and canonical context

`registerRepairLifecycle(pi, loadSnapshot, presentation)` accepts a loader for the validated catalog, pinned classifier adapter, limits, generation preferences, rewrite cap, and trusted provenance. The package configuration flow supplies that loader. The optional presentation adapter handles draft markers and status rendering.

The lifecycle adapter snapshots those inputs for the request. It invalidates pending work on input, shutdown, branch navigation, session switching, and forking. It also checks session identity and cancellation after awaited operations. A genuine consumed user message starts a new request scope.

The adapter preserves other extensions' boundary entries and continuation decisions. It defers repair when an earlier handler requests continuation. A competing content edit supersedes the audited draft and causes withholding.

Pi 1.4.0 exposes the active operation signal during `turn_end` but clears it before `agent_before_settle`. Isolated repair therefore runs at the turn boundary. Settlement preparation performs no model work. The final event's `aborted` flag and committed projection determine publication. Pending or withheld selections are filtered from subsequent requests until boundary cleanup can persist an omission edit. Turn-boundary cleanup also omits cancelled drafts when an abort skips final settlement.

`repairBoundary()` binds the selected text to its candidate hash and matching audit, then appends a context edit against the original assistant entry. The raw draft and its usage remain intact. Rejected revisions and internal editing instructions are never appended as conversational messages. The prepared metadata records candidate hashes, audits, preservation decisions, termination, and writer usage. The final result is appended only after settlement validation.

Installed-SDK tests verify canonical text on the next user turn and after reopening the saved session. Package-entry tests also cover native terminal rendering, strict withholding, recovery, operating modes, and aborting both classification and isolated repair.

## Verification

From the fork checkout:

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/repair.mjs test/repair-sdk.mjs test/evaluator.mjs test/jev.mjs test/cli.mjs
```

The SDK suite registers a counted task tool and attempts calls through direct, deferred, and codemode exposures. Its counter remains zero. It also covers final-permitted repairs, preservation fallback, writer failures, usage retention, other boundary entries, subsequent turns, and resume. Test HOME directories are disposable, and network access is blocked.
