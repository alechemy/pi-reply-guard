# pi-reply-guard

This fork of [amalavet/pi-reply-guard](https://github.com/amalavet/pi-reply-guard) audits completed assistant reply prose and repairs active violations with an isolated, tool-free writer. The Unslop catalog maps all 36 rules to 46 checks. The two literal checks enforce immediately. The 44 semantic style checks remain advisory until calibrated.

The package entry point now uses the per-rule evaluator and preservation-checked repair engine. It is tested against Pi 1.4.0. [Calibration tools](docs/calibration.md) provide corpus import, bounded evaluation, and reviewed per-rule promotion. The fork is published and installed. Live verification exposed a served-model identity mismatch. The corrected source passes authenticated auditing, repair, and cancellation checks. The installed revision remains disabled until that correction is published. See [deployment verification](docs/deployment.md) and [implementation status](docs/implementation.md).

## Commands

| Command | Action |
| --- | --- |
| `/reply-guard` | Opens the settings menu. Use **Edit JSON** for paths, model selection, and budgets. Use **Save settings** to create a fresh configuration. |
| `/reply-guard status` | Shows effective settings, discovered paths, and classifier registry availability. |
| `/reply-guard coverage` | Shows source-rule mappings, drift, and calibration status. |
| `/reply-guard verdict` | Opens the latest structured result for inspection. |
| `/reply-guard recover` | Opens the latest withheld draft for inspection. |
| `/reply-guard off` | Disables checking and repair for new replies. |
| `/reply-guard observe` | Audits the original reply without rewriting or withholding it. |
| `/reply-guard enforce` | Repairs active violations within the configured budget. |
| `/reply-guard warning` | Releases the latest preservation-approved candidate with its own verdict. |
| `/reply-guard strict` | Withholds automatic delivery when required checks fail or remain incomplete. |
| `/reply-guard migrate` | Converts legacy compliance settings after confirmation and creates a private backup. |

Mode or release-policy changes cancel pending repair. Other settings apply to the next request. Recovery opens an inspection editor and leaves canonical conversation context unchanged.

## Configuration

The configuration lives at `~/.pi/agent/reply-guard.json`, or under Pi's configured agent directory. Fresh defaults are:

```json
{
  "schemaVersion": 2,
  "thresholdMeaning": "violation",
  "mode": "enforce",
  "releasePolicy": "warning",
  "skill": "unslop",
  "model": "openrouter/typesafe/jev-1.14",
  "maxRewrites": 2,
  "writerDeadlineMs": 60000,
  "auditDeadlineMs": 5000,
  "classifierConcurrency": 2,
  "maxClassifierRequests": 8,
  "maxInputTokens": 64000,
  "preload": false,
  "debug": false,
  "showVerdicts": true
}
```

Install the authoritative skill separately. The guard discovers its `SKILL.md` through Pi and loads `reply-guard.rules.json` beside it. Optional `skillPath` and `catalogPath` settings accept absolute paths. The catalog owns per-rule violation thresholds, exceptions, and calibration records.

Two rewrites permit three candidate audits. Zero rewrites still audits the original. The selected Pi writer model and thinking level are retained. Repair uses no task tools.

Each candidate audit has one deadline and shared classifier budgets. Oversized passage checks use overlapping chunks. Checks requiring exact full context remain incomplete when that context cannot fit. Native classifier retries are disabled. See [per-rule evaluation](docs/evaluation.md).

Leave `preload` disabled when an existing loader supplies the complete skill. When enabled, the guard adds the skill text once per distinct version on the active branch. `showVerdicts: false` hides clean results. Failures, advisory findings, and incomplete coverage remain visible. `debug` adds structured candidate diagnostics to expanded verdicts.

Settings save atomically with private backups and protection against concurrent edits. Invalid configuration remains unchanged and withholds automatic delivery until corrected. A valid configuration with a missing skill or catalog produces an incomplete audit under its selected mode and policy.

### Legacy migration

Run `/reply-guard migrate` against an unversioned or version 1 configuration. Migration preserves the selected model, preload preference, budgets, and unrelated settings. It retains whole-skill thresholds under `legacyCompliance` with their original compliance meaning. The catalog supplies the new violation thresholds. Legacy injection settings are retained in that same record.

Migration requires one catalog-backed skill. Configurations selecting multiple legacy skills remain unchanged pending an explicit mapping decision. A preserved model selection outside the supported pinned routes remains unavailable until the operator changes it. `/reply-guard status` reports registry availability. Authentication requires a separate connection check.

## Delivery and privacy

The terminal hides enforced drafts and renders the selected reply once. Context edits retain that exact text for the next user turn and resumed sessions. Strictly withheld drafts are omitted from future main-agent context and remain available through `/reply-guard recover`.

Drafts are sent to the classifier and isolated writer. Raw session files, JSON events, RPC streams, and exports can contain drafts, including withheld text. Strict terminal concealment does not protect an unbuffered external consumer. See [delivery and operating modes](docs/delivery.md) for metadata and recovery behavior.

## Implementation references

- [Rule catalog and Markdown checks](docs/rules.md)
- [Per-rule evaluation and diagnostic CLI](docs/evaluation.md)
- [Preservation and isolated repair](docs/repair.md)
- [Delivery and operating modes](docs/delivery.md)
- [Corpus evaluation and semantic calibration](docs/calibration.md)
- [Implementation status and verification](docs/implementation.md)

The upstream MIT license and author attribution are retained.
