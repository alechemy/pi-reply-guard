# Experimental semantic trial

The trial lets three uncalibrated checks trigger repairs:

- `formulaic-contrast`
- `underspecified-behavior`
- `unnecessary-qualification`

After installing this revision, restart Pi, then run `/reply-guard trial on`. Pi can retain native `.mjs` imports across `/reload`, so a full restart is required when the supported check IDs change. Run `/reply-guard status` to inspect the selected checks and `/reply-guard coverage` to see their effective dispositions. Repairs require enforce mode. The trial command preserves the current mode and release policy.

Run `/reply-guard trial off` to remove the experimental opt-in. This retains the ordinary punctuation checks and any independently calibrated checks. Changing the trial selection cancels pending repair and preserves the consumed request's rewrite count.

## Settings and safeguards

The live configuration stores the selection in `experimentalChecks`. Its default is an empty array. The JSON editor accepts any subset of the supported checks. The legacy ID `redundant-negative-clarification` is accepted as an alias for `unnecessary-qualification`, including with older catalogs. Selecting both aliases is rejected.

To complete the rename, update the check ID and process references in the catalog, regenerate its coverage report, and replace the old ID in the live `experimentalChecks` array. Keep the question, examples, threshold, and preservation policy unchanged. The check covers unnecessary affirmative and negative qualifications.

The runtime marks selected checks active without changing their catalog status or calibration evidence. Expanded verdicts, `/reply-guard verdict`, and `/reply-guard coverage` label them experimental and uncalibrated. Passing banners follow the `showVerdicts` preference. Stale definitions and stale calibration cannot be reactivated through the trial.

The trial uses each check's existing threshold. The house catalog uses 0.9 for formulaic contrast and underspecified behavior, and 0.6 for unnecessary qualifications. It retains exact-source protection, all preservation checks, audit budgets, the rewrite cap, and the tool-free writer. Under warning release, a rejected revision leaves the latest preservation-approved reply visible, even when that reply still has a style violation.

Experimental activation does not qualify as reviewed promotion. The [held-out calibration requirements](calibration.md#review-and-promote) remain unchanged.

## Underspecified behavior

The check targets indirect causation, vague relationship verbs, and compressed implementation descriptions that leave necessary behavior unclear. Its examples distinguish "makes the subscribed-services checkbox select providers" from a direct description of which providers checking the box selects. Precise statements such as "The cache holds responses for five minutes" remain acceptable. Repairs must use supplied facts and must not infer provider selection, filtering, or persistence behavior from ambiguous wording.

The threshold is an experimental starting point. Classifier accuracy has not been measured for this check.

## Initial live observations

The original request for the supplied example was unavailable, so the live checks used a synthetic request about release-audit behavior. The first run missed the contrast. The questions were then revised to match the source rules more closely. The contrast question now tests the rhetorical construction even when the distinction is factual. The clarification question explicitly covers same-sentence additions and requires contextual evidence for an exception.

With those revisions, Jev assigned the contrast example 0.97 and attempted a repair. Several preservation judgments were inconclusive, so the original reply remained selected. The redundant-negative-clarification check assigned the same example 0.26 and missed that labeled violation. A shorter acceptable version received 0.01 and 0.02 and triggered no rewrite. Another synthetic contrast received 0.87, below the unchanged threshold.

These are development observations from OpenRouter's `typesafe/jev-1.14-20261014`, using the Codex writer. The trial can miss violations and reject useful revisions. Held-out accuracy has not been measured.
