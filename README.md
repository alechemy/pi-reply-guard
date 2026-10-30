# pi-reply-guard

[![npm](https://img.shields.io/npm/v/pi-reply-guard)](https://www.npmjs.com/package/pi-reply-guard) [![Pi package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages/pi-reply-guard) [![Downloads](https://img.shields.io/npm/dm/pi-reply-guard)](https://www.npmjs.com/package/pi-reply-guard) [![Stars](https://img.shields.io/github/stars/amalavet/pi-reply-guard)](https://github.com/amalavet/pi-reply-guard/stargazers) [![License](https://img.shields.io/npm/l/pi-reply-guard)](LICENSE)

This branch contains regression fixes and bounded per-rule evaluation for all 36 Unslop rules. [Rule catalog and Markdown checks](docs/rules.md) documents source protection and local auditing. [Per-rule evaluation](docs/evaluation.md) documents Jev execution, coverage, caching, and the diagnostic CLI. [Preservation and isolated repair](docs/repair.md) documents the new repair engine and Pi lifecycle adapter. Keep the extension uninstalled until operating modes and terminal delivery policies are integrated. [Implementation status](docs/implementation.md) records the tested changes and remaining work.

The current Pi lifecycle still uses the legacy evaluator, which asks Jev whether each final reply complies with each configured skill. Its probability estimates the answer to that question. A low compliance probability requests a rewrite within the configured budget.

https://github.com/user-attachments/assets/c8c65cf3-3030-44af-88e1-03f897d86447

## Install

```sh
pi install npm:pi-reply-guard
```

Or install from GitHub:

```sh
pi install git:github.com/amalavet/pi-reply-guard
```

## Configure

Run `/reply-guard` in Pi to open the settings menu. Select a setting to change it, or choose “Edit JSON” to edit the full configuration. Each change saves atomically to `~/.pi/agent/reply-guard.json`, backs up the previous bytes, and applies to the next request:

```json
{
  "schemaVersion": 1,
  "thresholdMeaning": "compliance",
  "auditDeadlineMs": 5000,
  "classifierConcurrency": 2,
  "maxClassifierRequests": 8,
  "maxInputTokens": 64000,
  "skills": {
    "asd-ste100": 0.3,
    "i-have-adhd": 0.3,
    "my-reply-preferences": 0.3
  },
  "model": "openrouter/typesafe/jev-1.14",
  "maxRewrites": 2,
  "inject": false,
  "reinjectBelow": 0,
  "preload": false,
  "debug": false,
  "showVerdicts": true
}
```

Install the skills separately. Names must match installed skills. Missing, unreadable, empty, or unconfigured skills produce an incomplete audit with a configuration diagnostic. Invalid configuration leaves the existing file unchanged.

Unversioned upstream settings retain their compliance thresholds, default model (`openrouter/typesafe/jev-1.13`), and preload preference. Saving through `/reply-guard` writes schema version 1 and creates a private `.bak` beside the configuration. Version 1 does not accept violation thresholds. The per-rule catalog will use a separate schema.

| Key | Default | Meaning |
|---|---|---|
| `skills` | `{}` | Installed skill name that replies must adhere to, with a threshold (0-1) to pass. A reply passes when the probability that it meets the skill is at or above the threshold |
| `model` | `openrouter/typesafe/jev-1.14` | Classifier model, `provider/id`. Existing selections are retained. |
| `maxRewrites` | `2` | Additional writer generations. The original and both revisions receive an audit attempt. Zero still audits the original. Exhaustion releases the current reply with a failed or incomplete status. |
| `auditDeadlineMs` | `5000` | Overall audit deadline per candidate, including provider work. |
| `classifierConcurrency` | `2` | Maximum concurrent classifier requests. |
| `maxClassifierRequests` | `8` | Request limit per candidate. Native SDK retries are disabled. |
| `maxInputTokens` | `64000` | Cumulative conservative input budget. UTF-8 bytes plus 256 tokens of overhead bound each request. Oversized input is reported incomplete without truncation. |
| `inject` | `false` | Set to `true` to add the full text of the failed skills to each rewrite request. |
| `reinjectBelow` | `0` | Adds the full text of a failed skill to the rewrite request when its probability is below this value (0-1). `0` disables it. `inject: true` takes precedence. |
| `preload` | `false` | Adds the full text of the guarded skills to the context once. Leave disabled when an existing loader supplies the skill. |
| `debug` | `false` | Records structured lifecycle events, hashes, and verdicts. New traces omit raw provider payloads, tool arguments, and draft text. |
| `showVerdicts` | `true` | Shows the audit result. Disabling this hides successful checks. Failures and incomplete checks remain visible. |
