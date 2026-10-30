# Rule catalog and Markdown checks

The catalog maps all 36 Unslop rules to 46 checks. The two literal predicates are active for eligible prose. The 44 semantic questions are advisory, with an experimental violation threshold of 0.9. The catalog contains 138 synthetic examples. None establishes calibration accuracy.

The catalog feeds the [per-rule evaluator](evaluation.md), which provides bounded Jev execution and diagnostic auditing. The Pi entry point uses this evaluator with [preservation-checked repair](repair.md) and [delivery policies](delivery.md).

## Files

| File | Owner and purpose |
| --- | --- |
| `~/.dotfiles/stow/agents/.agents/skills/unslop/SKILL.md` | Authoritative style policy. |
| `~/.dotfiles/stow/agents/.agents/skills/unslop/reply-guard.rules.json` | Reviewed check definitions and source bindings. |
| `~/.dotfiles/stow/agents/.agents/skills/unslop/reply-guard.coverage.md` | Generated mapping, dispositions, and calibration status. |
| `schemas/catalog.schema.json` | Catalog schema, shipped with the fork. |
| `lib/catalog.mjs` | Schema validation, source drift detection, and coverage rendering. |
| `lib/markdown.mjs` | Positioned Markdown parsing, protection map, and literal preservation comparison. |
| `lib/provenance.mjs` | Request-derived literal sources and unresolved reproduction intent. |
| `lib/local-checks.mjs` | Literal evaluation and typed semantic plans. |
| `lib/evaluator.mjs` | Per-rule execution, chunk coverage, budgets, and structured findings. |
| `lib/jev.mjs` | Native Pi classifier adapter with partial-answer and served-model validation. |
| `lib/judgment-cache.mjs` | Bounded in-memory judgments keyed by versioned hashes. |
| `cli.mjs` | Network-free catalog inspection and local audits, plus explicit remote diagnostic audits. |

Source, ruleset, preprocessing, detector, and protection metadata are shared in the JSON document. `loadCatalog()` resolves those fields onto every check. Each resolved check also carries a definition digest covering its question, exceptions, threshold, examples, and source binding. A separate calibration digest binds detector behavior without including activation status or the evidence record itself. Definition drift makes a calibrated check advisory and marks its calibration stale.

`inspectCatalog()` compares every numbered source rule and its location with the catalog. Added, removed, changed, or unmapped rules produce diagnostics. Policy changes before the numbered rules invalidate all mappings. Stale local checks are unavailable. Unaffected findings remain available alongside the incomplete catalog status.

The schema rejects activation of uncalibrated semantic checks in the catalog. The [experimental trial](experimental.md) applies an explicit runtime override for two named checks while retaining their uncalibrated evidence. [Promotion](calibration.md#review-and-promote) consumes an explicitly approved held-out record with qualifying per-check error counts and version bindings. Process requirements are recorded separately and are never reported as verified mental activity.

## Inspect and audit

Run these commands from the fork checkout:

```sh
UNSLOP="$HOME/.dotfiles/stow/agents/.agents/skills/unslop"
node cli.mjs check-catalog --catalog "$UNSLOP/reply-guard.rules.json" --skill "$UNSLOP/SKILL.md"
node cli.mjs coverage --catalog "$UNSLOP/reply-guard.rules.json" --skill "$UNSLOP/SKILL.md"
node cli.mjs audit-local --catalog "$UNSLOP/reply-guard.rules.json" --skill "$UNSLOP/SKILL.md" --text /path/to/reply.md --request /path/to/request.txt
```

`audit-local` exits with 0 when its active local checks pass, 1 for a local violation, and 2 for incomplete checking or an error. It reports semantic checks as pending or inapplicable. It does not call Jev, run task tools, rewrite text, or certify meaning preservation.

To regenerate the coverage artifact after reviewing a catalog edit:

```sh
node cli.mjs coverage --catalog "$UNSLOP/reply-guard.rules.json" --skill "$UNSLOP/SKILL.md" > "$UNSLOP/reply-guard.coverage.md"
```

This command renders existing bindings. It does not update source digests or clear stale calibration. Review affected questions and exceptions before updating their source bindings.

## Protection and source positions

The parser uses `mdast-util-from-markdown` with GFM support. Paragraphs, headings, table cells, list text, image labels, and footnote prose retain source ranges. Sentence IDs are stable for identical input. Every candidate keeps its original string unchanged.

Offsets and columns use JavaScript UTF-16 code units. Findings quote exact source slices. Entity-decoded punctuation maps back to its complete source entity, such as `&mdash;`. Original CRLF line endings remain intact.

The active predicates detect U+2014 and quotation characters U+2018 through U+201F. They do not impose sentence-length, bold-text, triplet, colon, or semicolon quotas. Contextual cases have separate advisory questions.

The protection map records exact code, link destinations, references, recognized paths and identifiers, shell-prompt commands, and verified verbatim text. Link and image labels remain eligible. Recognition of bare technical tokens is conservative. Ambiguous code, blockquote, HTML, or source-map intent is recorded explicitly. A literal violation in an unresolved range makes that check incomplete instead of flagging source material or silently clearing the range.

Verbatim evidence must come from the request or a trusted source record supplied by the caller. The evaluator resolves explicit directives such as `Reproduce exactly: Keep—this.` and `Reproduce this sentence exactly: Keep—this.` at the start of the consumed request. It treats all text after the directive as the source and preserves its bytes. Copy, repeat, return, and quote directives with `exactly`, `verbatim`, or `unchanged` use the same form.

Ambiguous reproduction intent or a source that does not match the reply makes the audit incomplete. The writer receives confirmed source records, and every revision retains the original protection baseline. A Markdown wrapper alone is insufficient. The optional `--provenance` file contains records such as:

```json
[{"sourceId":"user-request:quote-1","text":"Exact supplied source text."}]
```

Records match exact raw substrings. The caller must verify their origin. Do not accept provenance records supplied by a repair draft. Text requiring normalization to match a quotation remains unresolved.

`createView(revision, { baseline: originalView })` keeps newly introduced wrappers eligible. `compareProtected(originalView, revisionView)` checks bytes, presence, multiplicity, order, and new wrappers. Its result explicitly marks semantic preservation as unevaluated. A literal comparison alone cannot accept a revision.

## Verification

Core tests use synthetic policies and do not need the house skill:

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" npm test
```

Check the actual Stow catalog and its generated report:

```sh
REPLY_GUARD_ROOT="$PWD" node --test "$HOME/.dotfiles/scripts/tests/test_pi_reply_guard_catalog.mjs"
```

The tests cover source drift, all source-rule mappings, local examples, all semantic example plans, Markdown source positions, protected content, wrapper evasion, and response endings beyond 16,000 characters. Semantic examples test planning and schema behavior. [Evaluator tests](evaluation.md#focused-verification) exercise native transport and coverage with synthetic responses. Live judgments and held-out accuracy require the installation and calibration stages.
