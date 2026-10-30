# Calibration workflow

The calibration commands import supplied writing, evaluate development or held-out samples, report per-check errors, and prepare reviewed semantic activations. The house catalog remains advisory until a check has qualifying evidence.

| Task | Procedure |
| --- | --- |
| Import replies and corrections | [Prepare a corpus](#prepare-a-corpus) |
| Measure classifier and repair behavior | [Evaluate a split](#evaluate-a-split) |
| Inspect errors and approve a check | [Review and promote](#review-and-promote) |
| Interpret measurements | [Report semantics](#report-semantics) |

## Privacy and evidence

Import only files the operator supplies or explicitly authorizes. Keep submissions, corpora, and generated repair drafts outside Git and Stow. Commands create output files with mode `0600` and refuse to overwrite existing artifacts. Import, reporting, and promotion operate locally. Evaluation requires `--allow-remote yes` because it sends the selected samples to the configured classifier and, when requested, writer.

Examples used to develop a question belong in `development`. Reserve `held-out` examples before tuning questions or thresholds. Keep an original and its corrections in the same group and split. The importer rejects duplicate samples, groups spanning splits, and repeated prose crossing splits. Held-out evaluation also rejects prose copied from catalog development examples. These checks cannot detect every paraphrase or prior use of an example. The operator must retain the split's independence across dataset versions.

Prioritize rules 9, 25, 34, and 35. Label individual check IDs, such as `formulaic-contrast` and `redundant-negative-clarification`. An accepted reply establishes only the labels explicitly supplied for it.

## Prepare a corpus

Run commands from the fork checkout. Set the private data directory and house-rule location:

```sh
DATA="$HOME/.local/share/pi-reply-guard/calibration"
RULES="$HOME/.dotfiles/stow/agents/.agents/skills/unslop"
export PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent"
```

Submissions may be a JSON array or one JSON record per line. This fictional development record shows the format:

```json
{
  "id": "timer-original",
  "group": "timer-task",
  "split": "development",
  "kind": "style",
  "request": "When does the timer run?",
  "reply": "The timer runs hourly. It runs hourly, not daily.",
  "labels": {
    "formulaic-contrast": "violation",
    "redundant-negative-clarification": "violation"
  },
  "review": {"basis": "synthetic"}
}
```

Use `clear`, `violation`, or `exception` for each supplied label. An exception counts as acceptable prose. Real labels use `review.basis: "human-labeled"` or `"human-reviewed"` and a nonempty `reviewer`. Keep generated, unreviewed examples labeled `synthetic`.

A correction is another style record with its own labels, the same group and split, and `correctionOf` naming the original record. Optional `conversation` contains only `{role: "user" or "assistant", text}` records. Optional `verbatim` contains verified `{sourceId, text}` records. Hidden reasoning, tool messages, and unrecognized fields are rejected.

The importer also accepts paired inbox submissions containing `schemaVersion: 1`, `id`, `split`, `request`, `review`, and `rejected`/`accepted` objects with `reply` and `labels`. It expands each pair into linked records. A missing original request may be recorded as `null` in development data. Such samples remain incomplete for contextual evaluation and cannot enter the held-out split.

For preservation examples, set `kind: "preservation"`, supply `original` and the revised `reply`, and label conditions such as `preserve-negation` or `preserve-quantities`. The [preservation conditions](repair.md#required-preservation-checks) define the nine semantic checks. `preserve-literals` is the tenth check. Preservation results remain separate from style promotion.

```sh
node cli.mjs corpus-import \
  --input "$DATA/submissions.jsonl" --output "$DATA/corpus-v1.json" \
  --name writing --version v1
```

For additions or corrections, edit the authorized source submissions and import a new version into a new file. The normalized corpus stores a digest over its records, labels, review basis, context, and split assignments. Editing that artifact directly invalidates it.

## Evaluate a split

Evaluation defaults to 100 samples, 200 classifier requests, 2,000,000 cumulative input-token reservations, 20 writer generations, and a ten-minute run deadline. Each candidate also retains the ordinary [audit limits](evaluation.md#limits-and-accounting). Reaching a limit leaves the remaining rows explicitly incomplete. Provider-level failures stop further classifier calls within the run. Local checks remain available.

Supply a JSON file through `--limits` to change run limits. For a 200-sample held-out run, a starting budget is:

```json
{
  "maxSamples": 200,
  "maxClassifierRequests": 1600,
  "maxInputTokens": 20000000,
  "runDeadlineMs": 600000
}
```

Save that budget as `$DATA/run-limits.json`. After the selected provider is configured, run:

```sh
node cli.mjs evaluate-corpus \
  --corpus "$DATA/corpus-v1.json" \
  --catalog "$RULES/reply-guard.rules.json" --skill "$RULES/SKILL.md" \
  --split held-out --limits "$DATA/run-limits.json" \
  --allow-remote yes --output "$DATA/evaluation-v1.json"
```

Use `--split development` while tuning. `--model` selects a supported pinned classifier route. `--audit-limits FILE` overrides per-candidate limits. Usage can increase a reservation but cannot refund one or authorize more calls after an overrun. Exit code 0 means the labeled evaluations completed, including any detected violations. Code 2 indicates incomplete evaluation.

To benchmark repairs, add `--writer-model PROVIDER/MODEL` and `--repair-drafts "$DATA/repair-drafts-v1.json"`. Explicitly select the writer you use in Pi. `--writer-settings FILE` supplies its applicable generation preferences. The benchmark temporarily treats each sample's labeled style checks as active inside its isolated repair loop. It leaves the catalog unchanged. `maxRewrites` defaults to two, and all samples share the run's writer-generation cap.

Repair drafts are saved separately for human labeling. They start in the development split with empty labels and `review.basis: "unreviewed"`. The importer refuses them until a human supplies labels and a supported review basis. Evaluation artifacts contain hashes and structured outcomes without raw replies or provider payloads.

## Review and promote

Generate a report and a pending review record:

```sh
node cli.mjs calibration-report \
  --corpus "$DATA/corpus-v1.json" --evaluation "$DATA/evaluation-v1.json" \
  --output "$DATA/report-v1.md"

node cli.mjs calibration-review \
  --corpus "$DATA/corpus-v1.json" --evaluation "$DATA/evaluation-v1.json" \
  --check formulaic-contrast --output "$DATA/contrast-review-v1.json"
```

The current acceptance policy requires, for each promoted check:

- Every sample must be human-labeled or human-reviewed. Include at least 100 violations and 100 acceptable samples from the held-out split.
- At least 100 independent groups, with at most one sample from each class per group. An original/correction pair may supply one of each.
- Evaluation must resolve every sample.
- A 95% Wilson upper bound no greater than 5% for false positives and 10% for missed violations.
- A provider evaluation bound to the current rule definition, threshold, evaluator version, and classifier identity.
- Explicit, dated human approval.

These are conservative activation gates. They do not establish accuracy on every writing task. Changing questions or thresholds requires development evaluation followed by fresh held-out evidence.

Inspect the report and review record. To approve it, the human reviewer sets `review.decision` to `approve`, fills `review.reviewer`, and supplies an ISO timestamp in `review.reviewedAt`. Leave the evidence fields unchanged. Then produce a candidate catalog:

```sh
node cli.mjs promote-rule \
  --corpus "$DATA/corpus-v1.json" --evaluation "$DATA/evaluation-v1.json" \
  --catalog "$RULES/reply-guard.rules.json" --skill "$RULES/SKILL.md" \
  --review "$DATA/contrast-review-v1.json" --output "$DATA/promoted-rules-v1.json"
```

Review the candidate catalog's diff before replacing the managed catalog. Promotion embeds the reviewed record and activates only its named check. Definition, threshold, or evaluator drift makes the effective check advisory with stale calibration. A different classifier identity also makes the check advisory during evaluation.

## Report semantics

Reports separate style and preservation checks and show sample counts, review basis, false positives, missed violations, and incomplete coverage. Error rates and confidence bounds use resolved samples. If none were resolved, those values remain unknown. Rules 9, 25, 34, and 35 appear first. Latency includes added auditing and optional repair work. Evaluation rows retain classifier usage, writer usage, model identities, and budget reservations. Missing usage remains unknown.

Repair reports distinguish the number needing repair, rewrite frequency, and audit-accepted repairs within the cap. Human-verified meaning regressions for newly generated repairs remain unknown until those drafts are reviewed. Dedicated preservation samples report human-labeled damaged pairs that the checker incorrectly accepts. Overall preserved-pair rejection counts require acceptable labels for all ten preservation checks. Partial labels still contribute to per-condition results.

The focused tests use synthetic classifier and writer responses, including Pi's native transport:

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/calibration.mjs test/catalog.mjs test/evaluator.mjs test/cli.mjs test/jev.mjs
```
