# Implementation status

This branch contains the upstream regression fixes, the complete rule catalog, bounded per-rule evaluation, and the integrated preservation-checked repair engine. The catalog covers all 36 rules with 46 checks and 138 synthetic examples. [Rule catalog and Markdown checks](rules.md) documents source protection and local auditing. [Per-rule evaluation](evaluation.md) covers Jev execution and diagnostics. [Preservation and isolated repair](repair.md) covers acceptance checks, writer isolation, and canonical context.

The package entry point now uses the new lifecycle with off, observe, and enforce modes, warning and strict policies, and recoverable withheld drafts. [Delivery and operating modes](delivery.md) covers terminal rendering and integration metadata. The managed installation pins `6dd3a189fc728bf0a0f21af2c065b6639e787c88` with enforce mode configured. That revision includes the live-tested served-model identity correction. See [deployment verification](deployment.md).

## Source baseline

Sources were inspected on 2026-10-30 UTC, October 29 in America/Los_Angeles.

| Source | Finding |
| --- | --- |
| [Upstream source](https://github.com/amalavet/pi-reply-guard/tree/4fc465709fbabbd27a6debdae5d4847c6fc7bed5) | HEAD still equals the handoff baseline, `4fc465709fbabbd27a6debdae5d4847c6fc7bed5`. |
| npm `pi-reply-guard` | Stable is 0.3.0. Published versions and dist-tags contain no newer stable or prerelease. |
| [Pinned Unslop skill](https://github.com/alechemy/dotfiles-fish/blob/fb0f33ac1e1a67d16d7074b3a298172790c38c51/stow/agents/.agents/skills/unslop/SKILL.md) | The working skill adds a per-request reminder. All 36 numbered rules are unchanged. |
| Installed Pi | 1.4.0, tested through its extension loader and SDK on Node 24.22.2. Earlier Pi releases are outside this checkpoint's verification. |
| [TypeSafe models](https://docs.typesafe.ai/models) | Jev 1.14 is current. Direct ID `jev-1.14.0`, 64k whole-request context, 32k per-question context, $0.042 per million input tokens. No current preview beyond that version. This is the direct provider's published price. |
| [Pi classifier models](https://pi.dev/docs/latest/models#use-classifier-models) | Pi 1.4.0 lists OpenRouter `typesafe/jev-1.14` and direct TypeSafe `jev-latest`. New configurations select the versioned OpenRouter model. |

Skill SHA-256 values:

- Pinned: `52562ddc68372a6002cdf825b149673ef749cf9b64e0b90141cbf36d6ee4ed89`.
- Working copy: `05581382c2a6b9eb3bcb2f8232bb5b05e92003d0125b011d45375de12dcd8337`.

The existing Unslop loader supplies a request-local reminder and restores the full skill after compaction. Fresh sessions retain their explicit full-skill read requirement. The guard's fresh defaults therefore disable duplicate preloading. Legacy preferences are retained.

## Implemented changes

- Audit the original and every permitted rewrite. A cap of two allows three audit attempts. Zero allows one.
- Separate failed checks, incomplete checking, termination, and delivery. Preserve known failures when another check is unavailable.
- Stop repeated candidates and cycles using the exact candidate's cached result within the request.
- Reject missing, malformed, nonfinite, out-of-range, and unexpected answers. Provider errors no longer look like successful checks.
- Remove request and reply character cutoffs. Passage checks use overlapping chunks. Oversized full-context checks receive explicit incomplete results.
- Bound audit time, concurrent requests, total requests, and conservatively estimated input. Disable native transport retries so they cannot exceed the extension's request budget.
- Discard awaited results after input, shutdown, or branch navigation. Abort the in-flight classifier request on those events.
- Preserve configuration errors as visible incomplete results. Missing or empty required skills cannot silently disable checking.
- Save version 2 configuration atomically with private backups, an editor lock, and a check for intervening edits. Explicit migration retains legacy compliance thresholds, the selected model, preload preference, budgets, and unrelated settings.
- Keep failures visible when successful verdict display is disabled. New debug traces omit raw drafts, tool payloads, and provider payloads.

Schema version 2 uses catalog-owned violation thresholds. `/reply-guard migrate` requires confirmation and stores old thresholds under `legacyCompliance` with their original meaning. A multi-skill legacy configuration remains unchanged pending an explicit catalog mapping decision.

The terminal renderer conceals enforced drafts and displays the chosen reply once. Raw session files, JSON/RPC streams, exports, and recovery metadata retain draft text. Future main-agent context uses the released text or an omission edit for withheld drafts.

## Pi API constraints

The installed declarations and implementation were inspected in addition to the documentation.

1. Use `ctx.sessionManager.buildSessionProjection()` for accepted context. It is in the public read-only interface. Upstream used `buildSessionContext()`, which is absent from that interface in Pi 1.4.0.
2. `message_end` may replace a message of the same role. `agent_before_settle` may append `context_edit` entries. Preserve other extensions' boundary entries and their continuation decisions.
3. Use `ctx.modelRegistry.streamSimple(...).result()` for isolated provider-neutral writer calls. `completeSimple()` belongs to `ModelRuntime` and is absent from the extension registry. Main-agent tool declarations do not restrict every callable tool, and a blocked call can cause another internal agent turn. The isolated writer has no tool executor or continuation loop.
4. Persist accepted replacements through a context edit against the original assistant entry. The raw entry and usage remain intact. Record isolated writer usage separately and test reconstruction on resume and the next user turn.
5. Pi's System One transport defaults to two retries. Explicit `maxRetries: 0` is necessary when the extension owns the request budget.
6. Pi 1.4.0's System One answer parser discards the whole batch when one answer is malformed. Its returned model field also copies the requested model ID. The new adapter uses Pi's public fetch option to retain valid partial answers and check the served identity. Installed-SDK tests verify the hook, authentication forwarding, and retry suppression.
7. Pi converts public `bool` questions to wire-level `noul` and converts `noul` answers to `probability`. Keep these contracts separate.
8. Pi 1.4.0 clears `ctx.signal` before final settlement. Its private settlement abort flag is unavailable until `agent_settled.aborted`. Run isolated repair at `turn_end` while the active signal exists. Prepare context edits at `agent_before_settle`, then validate the final cancellation state and committed projection before publication. Aborted runs can skip settlement, so turn-boundary cleanup must also omit cancelled drafts. Pending or withheld selections remain filtered from provider requests until an omission edit can be committed.

The MIT license and upstream author attribution remain intact. The local `upstream` remote points to the original repository.

## Verification

Run against the installed Homebrew Pi package:

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" npm test
```

Tests block network access, use a disposable HOME, and provide deterministic classifiers and writers. `test/regressions.mjs` exercises the loaded extension's configuration and cancellation paths through the SDK. `test/sdk.mjs` runs real Pi settlement, context reconstruction, and native message rendering with synthetic writer and classifier responses. The initial tests reproduced skipped final audits and false-success error handling before the fixes.

These tests establish control flow. Jev's writing judgments and repair preservation remain uncalibrated. The [live synthetic smoke test](deployment.md) establishes authenticated auditing, repair, and cancellation for the corrected source.

## Per-rule evaluation checkpoint

The evaluator now runs every applicable semantic question, groups shared state, and tracks exact evaluated and omitted ranges. Passage checks use overlapping chunks. Broader checks remain incomplete when the exact full context cannot fit. Local violations survive remote failures. Structured findings use fixed guidance and source quotations labeled as evaluated ranges.

The adapter verifies served model identity and retains valid partial answers through Pi's native transport. Deadlines, request limits, concurrency, and input reservations apply across each candidate audit. The bounded memory cache stores probabilities and hashes without prose. CLI audits reuse Pi authentication and never create an agent session.

An offline check of the actual 44-question house catalog completed in three batches with 55,331 conservatively estimated input tokens for a short synthetic reply containing a heading and list. This demonstrates planning within the default budget. It does not measure Jev latency, billed usage, or writing accuracy.

## Preservation and repair checkpoint

Revisions now require literal preservation and nine semantic preservation conditions. They share the candidate audit budget with style checks. Intermediate preservation probabilities are inconclusive and reject the revision. The engine keeps the original meaning reference throughout the bounded repair loop and selects the latest preserved candidate with its own verdict.

The isolated writer uses the selected model and applicable generation settings. Registered mock tools remain unexecuted across direct, deferred, and codemode tool-call attempts. Writer failures and cancellation stop without an internal agent continuation.

`registerRepairLifecycle()` implements the Pi event integration and is registered by the package entry point. `repairBoundary()` persists the selected reply through a context edit while retaining the raw original and its usage. Installed-SDK tests verify the accepted text on the next turn and after resume.

## Delivery checkpoint

Off mode bypasses checking. Observe mode audits the original without rewriting or withholding it. Enforce mode performs bounded isolated repair and applies warning or strict release. Advisory coverage is reported separately from active acceptance checks.

Unique draft markers prevent duplicate terminal delivery without hiding identical text in another reply. Native Pi rendering tests cover fresh and resumed sessions, narrow widths, strict withholding, and ordinary history with rendering disabled. Interrupted drafts remain recoverable and are excluded from subsequent model requests.

Mode and policy commands cancel pending repair while preserving the consumed request's rewrite count. Handled input and resumed extension feedback also retain that count. Request-derived exact-copy sources protect local auditing and every repair baseline. Ambiguous reproduction intent remains incomplete. Native SDK tests exposed the missing settlement abort signal, so isolated repair now runs at the active turn boundary. Abort during classification or repair produces no late release. The settings editor uses schema version 2, explicit legacy migration, and the existing private backup and concurrency protections.

## Calibration tooling checkpoint

[Calibration commands](calibration.md) import supplied replies and corrections into versioned private corpora. They preserve per-check labels and source context, separate development and held-out groups, and reject duplicate samples and cross-split prose reuse. Missing request context remains explicit.

Evaluation reports per-check errors, incomplete coverage, sample counts, latency, and bounded repair behavior. Dedicated preservation samples measure damage acceptance separately. Generated repairs require human review before a meaning-regression rate can be established. Reports retain hashes and structured outcomes. Raw repair drafts use a separate private artifact.

Promotion consumes exact reviewed held-out evidence and checks sample counts, error bounds, threshold, evaluator, definition, and model identity. A definition or model change makes the effective semantic check advisory with visible stale calibration. Native Pi tests cover corpus evaluation, authentication forwarding, and isolated writer calls with synthetic responses.

The house semantic checks remain advisory. No held-out human corpus has been evaluated. The workflow prioritizes rules 9, 25, 34, and 35.

## Experimental trial

The [experimental trial](experimental.md) provides a default-off runtime opt-in for formulaic contrast and redundant negative clarification. It retains uncalibrated metadata, existing thresholds, preservation checks, rewrite budgets, and cancellation behavior. The catalog's promotion policy remains unchanged.

Native Pi tests cover opt-in commands, effective coverage, semantic-triggered repair, rejected meaning changes, stale definitions, and cancellation when the trial is disabled. Live development tests exposed missed violations and inconclusive preservation judgments. Those observations are recorded in the trial documentation.

The supported host version is Pi 1.4.0. The trial commands require publication and installation of this change. Reviewed semantic promotion remains dependent on held-out calibration.
