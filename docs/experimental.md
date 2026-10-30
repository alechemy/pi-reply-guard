# Experimental semantic trial

The trial lets two uncalibrated checks trigger repairs:

- `formulaic-contrast`
- `redundant-negative-clarification`

After installing a revision containing the trial commands, run `/reload`, then `/reply-guard trial on`. Run `/reply-guard status` to inspect the selected checks and `/reply-guard coverage` to see their effective dispositions. Repairs require enforce mode. The trial command preserves the current mode and release policy.

Run `/reply-guard trial off` to remove the experimental opt-in. This retains the ordinary punctuation checks and any independently calibrated checks. Changing the trial selection cancels pending repair and preserves the consumed request's rewrite count.

## Settings and safeguards

The live configuration stores the selection in `experimentalChecks`. Its default is an empty array. Only the two IDs above are accepted. The JSON editor also accepts either check individually.

The runtime marks selected checks active without changing their catalog status or calibration evidence. Expanded verdicts, `/reply-guard verdict`, and `/reply-guard coverage` label them experimental and uncalibrated. Passing banners follow the `showVerdicts` preference. Stale definitions and stale calibration cannot be reactivated through the trial.

The trial uses each check's existing threshold. The house catalog currently uses 0.9. It retains exact-source protection, all preservation checks, audit budgets, the rewrite cap, and the tool-free writer. Under warning release, a rejected revision leaves the latest preservation-approved reply visible, even when that reply still has a style violation.

Experimental activation does not qualify as reviewed promotion. The [held-out calibration requirements](calibration.md#review-and-promote) remain unchanged.

## Initial live observations

The original request for the supplied example was unavailable, so the live checks used a synthetic request about release-audit behavior. The first run missed the contrast. The questions were then revised to match the source rules more closely. The contrast question now tests the rhetorical construction even when the distinction is factual. The clarification question explicitly covers same-sentence additions and requires contextual evidence for an exception.

With those revisions, Jev assigned the contrast example 0.97 and attempted a repair. Several preservation judgments were inconclusive, so the original reply remained selected. The redundant-negative-clarification check assigned the same example 0.26 and missed that labeled violation. A shorter acceptable version received 0.01 and 0.02 and triggered no rewrite. Another synthetic contrast received 0.87, below the unchanged threshold.

These are development observations from OpenRouter's `typesafe/jev-1.14-20261014`, using the Codex writer. The trial can miss violations and reject useful revisions. Held-out accuracy has not been measured.
