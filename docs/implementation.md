# Implementation status

This branch contains the upstream regression fixes and the offline rule-catalog phase of the Unslop reply guard. The catalog covers all 36 rules with 46 checks and 138 synthetic examples. Positioned Markdown parsing, protected-content comparisons, local checks, and semantic request planning are implemented. [Rule catalog and Markdown checks](rules.md) documents the files and commands.

Keep the extension uninstalled until preservation, text-only repair, and delivery-state handling are implemented. The current Pi entry point still uses whole-skill compliance questions and main-agent continuations.

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
- Remove request and reply character cutoffs. Oversized inputs receive explicit incomplete results until chunked evaluation is implemented.
- Bound audit time, concurrent requests, total requests, and conservatively estimated input. Disable native transport retries so they cannot exceed the extension's request budget.
- Discard awaited results after input, shutdown, or branch navigation. Abort the in-flight classifier request on those events.
- Preserve configuration errors as visible incomplete results. Missing or empty required skills cannot silently disable checking.
- Save versioned configuration atomically with private backups, an editor lock, and a check for intervening edits. Reading legacy configuration does not write it. Saving migrates it without changing compliance threshold semantics, its selected model, or its preload preference.
- Keep failures visible when successful verdict display is disabled. New debug traces omit raw drafts, tool payloads, and provider payloads.

Schema version 1 explicitly retains upstream compliance probabilities. Its settings are an intermediate migration format. Per-rule violation probabilities require a separate schema and explicit migration.

The terminal renderer still conceals drafts using display transformations. Those drafts remain in raw session history, provider context, JSON events, RPC streams, and exports. This checkpoint does not provide strict concealment or a preservation-checked fallback.

## Pi API constraints for the next stage

The installed declarations and implementation were inspected in addition to the documentation.

1. Use `ctx.sessionManager.buildSessionProjection()` for accepted context. It is in the public read-only interface. Upstream used `buildSessionContext()`, which is absent from that interface in Pi 1.4.0.
2. `message_end` may replace a message of the same role. `agent_before_settle` may append `context_edit` entries. Preserve other extensions' boundary entries and their continuation decisions.
3. Use an isolated writer completion with the selected writer model and applicable generation settings. Main-agent tool declarations do not restrict every callable tool, and a blocked call can cause another internal agent turn. The replacement writer must have no tool executor or continuation loop.
4. Persist accepted replacements through a context edit against the original assistant entry. The raw entry and usage remain intact. Record isolated writer usage separately and test reconstruction on resume and the next user turn.
5. Pi's System One transport defaults to two retries. Explicit `maxRetries: 0` is necessary when the extension owns the request budget.
6. Pi 1.4.0's System One answer parser discards the whole batch when one answer is malformed. Its returned model field also copies the requested model ID. The per-rule adapter must retain valid partial answers and inspect the served model identity without logging credentials. Verify a narrowly scoped native transport hook before implementing that adapter.
7. Pi converts public `bool` questions to wire-level `noul` and converts `noul` answers to `probability`. Keep these contracts separate.

The MIT license and upstream author attribution remain intact. The local `upstream` remote points to the original repository.

## Verification

Run against the installed Homebrew Pi package:

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" npm test
```

Tests block network access, use a disposable HOME, and provide deterministic classifiers and writers. `test/regressions.mjs` exercises the loaded extension's handlers. `test/sdk.mjs` runs real Pi settlement and continuation with a fake writer provider. The initial tests reproduced skipped final audits and false-success error handling before the fixes.

These tests establish control flow. Jev's writing judgments and repair preservation remain uncalibrated. Live calls belong after the offline guard and installation are complete.

## Remaining implementation

Continue in this order:

1. Connect the completed catalog and Markdown view to per-rule evaluation. Replace whole-skill questions with narrow per-rule questions, full-response chunk coverage, structured evidence, and versioned cache keys. Start semantic style checks as advisory. Preserve active local findings when remote checks fail.
2. Add mandatory semantic and literal preservation checks against the original draft. Add the isolated writer, its deadline and bounded attempts, and mock-tool isolation tests.
3. Implement off, observe, and enforce modes, warning and strict release policies, explicit draft recovery, canonical fallback context, and resumed-session rendering.
4. Extend the catalog's synthetic examples with a separate semantic-preservation fixture set, corpus import, held-out evaluation, and reviewable promotion records. Prioritize semantic calibration for rules 9, 25, 34, and 35.
5. Finish fork publication, immutable package registration, idempotent Stow integration, configuration migration, and rollback. Test the chosen authenticated Jev route with a bounded synthetic smoke test and record served versions, latency, and usage.

A final supported Pi range and an installed revision must be recorded after these stages pass. The current branch is a development checkpoint.
