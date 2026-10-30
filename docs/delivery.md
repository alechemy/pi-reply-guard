# Delivery and operating modes

The package entry point registers the catalog-backed evaluator, isolated writer, delivery policies, and terminal renderers. Pi 1.4.0 is the tested host version.

## Modes and policies

| Mode | Audit | Repair | Delivery |
| --- | --- | --- | --- |
| `off` | Bypassed. | Bypassed. | Pi displays the original reply normally. |
| `observe` | Runs the complete configured audit. | Never requested. | The original remains visible, including failed or incomplete results. |
| `enforce` | Audits the original and each revision. | Repairs active violations within the cap. | Applies the selected warning or strict policy. |

Warning policy releases the latest preserved candidate with the audit for that exact candidate. Strict policy requires all applicable active style checks and revision-preservation checks to pass completely. Advisory-only unknowns do not block release. Their incomplete coverage is recorded in the verdict.

Malformed, unsupported, or unreadable configuration cannot establish a trusted operating policy. The guard withholds the draft and directs the operator to `/reply-guard status`. A valid configuration with an unavailable catalog retains its selected policy and records an incomplete audit.

An explicit mode, policy, or experimental-selection change cancels pending repair. The cancelled draft remains withheld. Run `/reply-guard recover` to inspect it. The command opens the latest withheld draft on the current branch without appending messages or changing canonical context.

## Lifecycle

1. A consumed user message starts a request scope and snapshots configuration, catalog, classifier identity, writer model, and generation preferences.
2. `message_end` accepts only completed assistant replies with text and no tool calls. Enforce mode assigns unique display markers and records the original draft before awaiting the audit.
3. `turn_end` runs isolated repair while Pi still exposes the active operation's abort signal. Other extensions' continuation decisions can defer this work. Every writer generation consumes the request's remaining cap.
4. `agent_before_settle` verifies candidate identity and the current projected entry, then prepares the context edit and pending metadata. No model call runs at this boundary.
5. `agent_settled` checks Pi's final cancellation state and the committed projection against the selected candidate. Only then does it append a final delivery result. A later handler's conflicting edit or continuation causes withholding.
6. Input, navigation, session replacement, shutdown, and explicit mode changes invalidate pending work. Cancellation preserves the consumed request's rewrite count.

Pi 1.4.0 clears its agent abort signal before final settlement. Its `abort()` method sets a private settlement flag without providing a new signal to extensions. Running the isolated writer at `turn_end` keeps Escape and SDK abort requests connected to that writer. Aborted runs can also skip `agent_before_settle`, so `turn_end` removes cancelled drafts from canonical context.

The guard retains other extensions' boundary entries. A competing content edit supersedes the audited draft and causes withholding. Raw entries remain in session history. A consumed new user message resets the rewrite counter. Handled input, mode changes, extension feedback, and resumed continuations retain the existing count.

## Terminal and history

Enforce mode suppresses streaming prose and marked raw drafts through Pi's Markdown transformer. The final result renderer displays released text once. Observe and off modes leave the ordinary assistant renderer responsible for the original text.

Markers identify individual drafts, so identical text in another unguarded reply remains visible. The guard reconstructs presentation from the active branch on startup and navigation. A draft lacking a final result after interruption receives a withheld result and remains recoverable.

Released text replaces the original assistant's content in canonical context. Pending and withheld candidates are filtered from model requests and audit conversation context. Strict withholding and turn-boundary cancellation append omission edits immediately. A late cancellation or conflicting edit can leave provisional text in Pi's committed projection until the next boundary appends an omission edit. The context filter excludes it from provider requests during that interval, including after resume. Raw original entries and their usage are retained. Removing the extension leaves ordinary assistant history readable, but removes its custom rendering and concealment.

`showVerdicts` defaults to `false`. Released replies whose active checks pass render without a banner, including experimental passes and results with advisory findings or incomplete advisory coverage. Failures, incomplete active checking, withheld replies, errors, and stale calibration or catalog warnings remain visible. The current display preference also applies to resumed history. Set `showVerdicts: true` to show passing banners.

Expanded results list individual checks, advisory coverage, and experimental uncalibrated labels. With `debug` enabled, expansion also shows structured candidate audits and writer usage. `/reply-guard verdict` opens the latest result metadata for inspection.

The footer displays `Reply guard: checking` during enforced auditing and repair. It clears after delivery or cancellation and stays empty on startup, navigation, and mode changes. `/reply-guard status` shows the current mode and settings.

## Integration metadata

Custom session entries are excluded from model context:

| Custom type | Stored data |
| --- | --- |
| `reply-guard-draft` | Schema version, draft ID, original candidate hash, display markers, original text, mode, and policy. |
| `reply-guard-prepared` | Pending selection, intended delivery, target entry, audit, and rewrite accounting. It cannot authorize publication. |
| `reply-guard-repair` | Delivery decision, termination, selected candidate ID and audit, per-candidate audits, rewrite counts, writer usage, mode, policy, and recoverable draft text. Released enforce results also include `reply`. |
| `reply-guard-verdict` | Historical whole-skill results remain renderable. New audits use `reply-guard-repair`. |

`draftId` associates a result with its original draft. Settled results include the target session entry ID. The selected candidate hash equals the selected audit's candidate hash. Each rejected revision retains its own audit and preservation result in the candidate list.

Observe results have no display-copy `reply` because Pi already displays the original. Withheld results have no `reply`. Consumers must wait for `reply-guard-repair` and use its `delivery` field to decide whether to publish. Candidate counts and writer usage may be unavailable after interruption. Missing usage and missing pricing remain unknown.

Full original and selected draft text is retained in session metadata for recovery, including under strict policy. This is separate from debug output. Provider payloads and credentials are never added to these records.

## External consumers

Terminal concealment does not redact raw session files, streamed JSON or RPC events, or exports. Drafts are also sent to Jev and the isolated writer for evaluation and repair. An external client must buffer assistant drafts and wait for a final result before displaying enforced output. It must also handle mode changes and withheld results. This package supplies the metadata without adding an external client.

## Focused verification

```sh
PI_PACKAGE_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/sdk.mjs test/ui-sdk.mjs test/regressions.mjs test/review-regressions.mjs test/repair.mjs test/repair-sdk.mjs
```

The tests load the real package entry point through Pi's SDK and render with Pi's assistant-message component and the registered entry renderers. They cover operating modes, release policies, exact fallback context, resume, interruption, cancellation during classification and repair, earlier and later settlement handlers, continuation, consumed-request budgets, request-derived literals, configuration migration, and private backups. Classifier and writer responses are synthetic. Test authentication and HOME directories are disposable.
