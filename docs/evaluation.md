# Per-rule evaluation

The evaluator runs the catalog's semantic questions through Pi's native classifier registry. All 44 house semantic checks remain advisory. The two local punctuation checks remain active. The diagnostic CLI and package entry point share the audit function. The package integrates it with the [repair lifecycle](repair.md) and [delivery policies](delivery.md).

## Diagnostic audit

This command sends the supplied reply, request, and optional visible conversation to the selected classifier provider. It prints structured findings and coverage. It cannot invoke task tools or rewrite the supplied text.

From the fork checkout, using the installed Homebrew Pi package:

```sh
UNSLOP="$HOME/.dotfiles/stow/agents/.agents/skills/unslop"
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
  node cli.mjs audit --catalog "$UNSLOP/reply-guard.rules.json" \
  --skill "$UNSLOP/SKILL.md" --text /path/to/reply.md --request /path/to/request.txt
```

Pi resolves authentication from its existing configuration. `--model` defaults to `openrouter/typesafe/jev-1.14`. Direct `typesafe/jev-1.14.0` is accepted only if that pinned model is already registered. Aliases and unsupported selections produce incomplete remote coverage without switching providers.

Optional inputs:

| Flag | Contents |
| --- | --- |
| `--conversation FILE` | A JSON array of `{ "role": "user" or "assistant", "text": "..." }` records. Only those two fields enter classifier state. |
| `--provenance FILE` | Trusted verbatim records in the [documented format](rules.md#protection-and-source-positions). |
| `--limits FILE` | A JSON object overriding the audit limits below. |
| `--model PROVIDER/ID` | An explicitly selected supported pinned classifier. |

Exit code 0 means active checks passed and evaluation coverage is complete. Advisory violations can still be present. Code 1 means an active violation was found. Code 2 means checking was incomplete or an input failed validation. Inspect `advisoryIncomplete` and `coverageComplete` even when active checks pass. The existing `audit-local`, `check-catalog`, and `coverage` commands remain network-free.

The authenticated smoke test belongs after installation. Current verification uses synthetic input and intercepted transport responses.

## Coverage and evidence

`lib/evaluator.mjs` combines local checks with one narrow question per semantic condition. High probability consistently means a violation. Questions with identical state share a request. The protection policy appears once in that state, referenced by each question.

The evaluator retains the full request and supplied visible conversation. Passage-scoped checks use exact Markdown chunks with 256 UTF-16 code units of overlapping context on each side. Chunk boundaries prefer paragraphs and preserve surrogate pairs. Only the named target ranges count toward coverage. Overlap provides context without duplicating the claimed coverage.

Reply-wide and conversation-wide checks require the complete exact reply. If it does not fit, those checks are unavailable. Oversized requests, exhausted budgets, stale definitions, and unresolved source protection also remain visible. No prefix or summary substitutes for the missing material.

Each check records its expected, executed, and omitted ranges. Findings retain the stable rule ID, threshold, probability, fixed repair guidance, and exact source quotations. Semantic evidence is labeled `evaluated-range`. It identifies the scope that received the judgment and does not claim a precise offending span. Jev supplies no free-form evidence or repair instructions.

Known violations survive missing or malformed answers elsewhere in a batch. Unknown answer IDs mark that batch incomplete. Unresolved protection prevents a semantic judgment from becoming a finding for the affected range.

## Limits and accounting

| Setting | Default |
| --- | --- |
| `auditDeadlineMs` | 5,000 milliseconds per candidate |
| `classifierConcurrency` | 2 simultaneous requests |
| `maxClassifierRequests` | 8 requests per candidate |
| `maxInputTokens` | 64,000 cumulative estimated input tokens |
| `perQuestionTokens` | 32,000 |
| `perRequestTokens` | 64,000 |

Estimates use the serialized request's UTF-8 byte count plus 1,024 tokens of overhead. This conservative bound includes questions and repeated context. Actual reported input can increase the charged budget. It never refunds an estimate or permits additional calls after an overrun. The two per-request context limits can be lowered but cannot exceed the pinned Jev limits.

The deadline starts before Markdown parsing and local checks. Scheduling stops when it expires. Awaited calls race cancellation, and late results cannot populate the cache. Synchronous parsing cannot be interrupted mid-operation, so unusually large local inputs can overrun the deadline before scheduling stops.

Native transport retries are disabled. The adapter permits one fetch per reserved request, verifies the planned URL and payload, and refuses redirects. Authentication and provider configuration remain Pi's responsibility. `requests` counts reservations, including failures before transport. `transportAttempts` counts calls reaching the fetch boundary. Usage is `null` when unavailable. A missing or all-zero catalog price produces unknown cost.

`lib/jev.mjs` uses the public fetch option tested on Pi 1.4.0. It observes the native response's parsed JSON without changing that response. This retains valid answers when Pi rejects another answer in the batch. It also checks the wire response's served model instead of relying on Pi's result field, which echoes the requested model. Public questions and results use `bool` and `probability`. Wire answers use `noul`.

## Cache and integration

A repair session should create one `JudgmentCache` and pass it to every candidate audit:

```js
import { auditCandidate } from "../lib/evaluator.mjs";
import { createJevAdapter } from "../lib/jev.mjs";
import { JudgmentCache } from "../lib/judgment-cache.mjs";

const adapter = createJevAdapter(ctx.modelRegistry);
const cache = new JudgmentCache();
const result = await auditCandidate({
  catalog, text, request, conversation, verbatim,
  adapter, cache, signal: ctx.signal,
});
```

The caller supplies a validated catalog and any verified external provenance. The evaluator also resolves explicit reproduction sources from the consumed request before local checks. Ambiguous intent remains incomplete. Keep the same catalog and adapter snapshot throughout a repair session. Pass the original Markdown view as `baseline` when checking a revision. This enables [mandatory preservation checks](repair.md#required-preservation-checks), keeps the original meaning reference, and prevents new wrappers from exempting prose. The preservation model judgments remain uncalibrated.

The cache holds at most 256 judgments for 15 minutes. Keys bind the exact candidate, evaluated state, question, threshold, definition, catalog, evaluator version, and model identity. Endpoint identity is hashed. Values contain only probabilities and the verified model ID. Successful answers from partial batches can be reused. Transport failures and protocol-invalid batches are not cached. There is no persistent cache.

Results separate active-check `status` and `incomplete` from `advisoryIncomplete` and `coverageComplete`. They also include candidate and catalog hashes, effective limits, version metadata, cache hits, timings, request counts, and usage. A later delivery policy must use the verdict for the exact candidate being released.

## Focused verification

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/evaluator.mjs test/jev.mjs test/cli.mjs test/catalog.mjs
```

The native transport tests use Pi 1.4.0 with a disposable HOME and fictional authentication. They cover partial-answer recovery, served identity, retry suppression, request mutation, cancellation, accounting, and the diagnostic CLI. Evaluator tests cover chunk boundaries, late-response rejection, budgets, exact context, cache invalidation, and preservation of local failures. These tests establish execution behavior. Semantic accuracy requires the later held-out evaluation.
