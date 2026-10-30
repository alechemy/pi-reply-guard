# Deployment verification

Pi 1.4.0 is the verified host version. The fork is published at [alechemy/pi-reply-guard](https://github.com/alechemy/pi-reply-guard/tree/feat/unslop-audit). The managed installation pins `6dd3a189fc728bf0a0f21af2c065b6639e787c88`.

The first live check exposed an identity mismatch. OpenRouter accepts `typesafe/jev-1.14` and returns `typesafe/jev-1.14-20261014`. The adapter previously required the response to echo the requested ID. The corrected adapter binds audits, caches, and calibration records to the exact dated response identity. Other builds and aliases remain unavailable. The [System One response contract](https://docs.typesafe.ai/api/system-one) allows the served model name to differ from the request alias.

The installed revision includes the correction and is configured for enforce mode with warning release.

## Live synthetic smoke test

The corrected source used the existing Pi credentials, the complete house catalog, and default audit budgets. The isolated writer used `openai-codex/gpt-6-astra` with high reasoning and a 4,096-token output cap. No task tools or real conversation history were supplied.

| Measurement | Result |
| --- | --- |
| Classifier response | `typesafe/jev-1.14-20261014` |
| Original audit | One active em-dash violation, complete applicable coverage, 2,892 ms |
| Repaired audit | Active checks and preservation passed, complete applicable coverage, 450 ms |
| Repair | One writer call, accepted revision without the em dash |
| Total audit and repair time | 5,254 ms |
| Classifier usage | 19,461 input tokens and 1,862 output tokens across three requests |
| Classifier catalog-priced estimate | $0.000817362 |
| Writer usage | 324 input tokens and 12 output tokens |
| Live cancellation | One request aborted, incomplete coverage returned in 108 ms |

These measurements establish the authenticated execution path for one synthetic reply. The semantic style checks remain advisory pending held-out calibration. Catalog-priced estimates are separate from provider billing.

Native Pi regression tests cover settlement, cancellation, context reconstruction, modes, strict withholding, and terminal rendering with synthetic provider responses. Transport tests reproduce the dated response identity and reject missing, aliased, or changed identities.

## Managed configuration

Dotfiles owns the immutable Git package declaration and the Unslop skill/catalog files. Its setup script copies a configuration seed to `~/.pi/agent/reply-guard.json` only when absent. The live configuration is a private regular file. Repeating setup preserves mode changes, including disabling the guard.

After installation, run `/reload` and `/reply-guard status` in Pi. Use `/reply-guard enforce` if the guard was previously disabled. Warning policy releases the latest preserved candidate with its audit. `/reply-guard off` disables checking and repair while retaining the configuration.

For full removal, remove the package from the managed settings fragment, merge settings, run `pi remove` with its exact package source, and reload Pi. Keep the live configuration and session files for recovery.
