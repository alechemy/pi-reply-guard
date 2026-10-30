import assert from "node:assert/strict";
import test from "node:test";
import { inspectCatalog } from "../lib/catalog.mjs";
import { createView, compareProtected, location } from "../lib/markdown.mjs";
import { evaluateLocal } from "../lib/local-checks.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

const catalog = inspectCatalog(makeCatalog(), skill);
const audit = (text, options) => evaluateLocal(catalog, createView(text, options));
const findings = (result) => result.checks.flatMap((check) => check.findings);

test("literal checks preserve source bytes and exact source locations", () => {
  const text = "# Heading\r\n\r\nA 😀 sentence—here. It is “done”.";
  const view = createView(text);
  const result = evaluateLocal(catalog, view);
  assert.equal(view.text, text);
  assert.equal(result.status, "failed");
  assert.deepEqual(findings(result).map((finding) => finding.quote), ["—", "“", "”"]);
  for (const finding of findings(result)) assert.equal(text.slice(finding.start, finding.end), finding.quote);
  assert.equal(findings(result)[0].line, 3);
  assert.equal(findings(result)[0].column, 14);
  assert.equal(location(view, text.indexOf("😀"), text.indexOf("😀") + 2).quote, "😀");
});

test("Markdown entities and escaped characters have reversible locations", () => {
  const text = "A &mdash; with &#x201c;quotes&#8221; and \\*markup\\*.";
  const view = createView(text);
  assert.equal(view.passages[0].text, "A — with “quotes” and *markup*.");
  assert.deepEqual(findings(evaluateLocal(catalog, view)).map((finding) => finding.quote), ["&mdash;", "&#x201c;", "&#8221;"]);
});

test("link and image labels remain eligible while destinations are protected", () => {
  for (const text of ["[label—text](https://example.org/a—b)", "![alt—text](https://example.org/a—b)", "![alt \\] text—here](https://example.org/a—b)"]) {
    const result = audit(text);
    assert.equal(findings(result).length, 1);
    assert.equal(findings(result)[0].quote, "—");
    assert.ok(findings(result)[0].start < text.indexOf("https:"));
  }
  assert.equal(audit("[Plain label](https://example.org/a—b)").status, "passed");
});

test("bare paths, identifiers, commands and citations are protected", () => {
  const text = "Use ./a—b/file.ts, https://example.org/a—b, user_name, parseValue() and [1].\n\n$ echo “literal”";
  const view = createView(text);
  assert.equal(evaluateLocal(catalog, view).status, "passed");
  for (const kind of ["path", "url", "identifier", "citation", "command"]) assert.ok(view.protections.some((span) => span.kind === kind), kind);
  assert.ok(view.protections.every((span) => text.slice(span.start, span.end) === span.raw));
});

test("verified exact reproduction protects punctuation including repeated occurrences", () => {
  const source = { sourceId: "user-request:quote-1", text: "“Keep—this.”" };
  const text = `${source.text}\n\n${source.text}`;
  const view = createView(text, { verbatim: [source] });
  assert.equal(evaluateLocal(catalog, view).status, "passed");
  assert.equal(view.protections.length, 2);
  assert.throws(() => createView(text, { verbatim: [{ text: source.text }] }));
  const revision = createView(source.text, { verbatim: [source], baseline: view });
  assert.equal(compareProtected(view, revision).outcome, "violation");
});

test("unverified wrappers cannot yield a clean literal pass", () => {
  for (const text of ["```text\nWords—here.\n```", "Use `words—here`.", "> Words—here.", "<div>Words—here.</div>", "<div>Words&mdash;here.</div>"]) {
    const result = audit(text);
    assert.equal(result.status, "incomplete", text);
    assert.equal(findings(result).length, 0);
    assert.ok(result.checks.some((check) => check.unknown.length));
  }
});

test("verified source code and blockquotes do not produce inappropriate flags", () => {
  for (const text of ["```js\nconst x = '—';\n```", "> “Keep—this.”"]) {
    const result = audit(text, { verbatim: [{ sourceId: "supplied-source:1", text }] });
    assert.equal(result.status, "passed");
    assert.equal(findings(result).length, 0);
  }
  assert.equal(audit("`const x = '—';`", { verbatim: [{ sourceId: "request:1", text: "const x = '—';" }] }).status, "passed");
});

test("new code, HTML, and quotation wrappers do not exempt revisions", () => {
  const original = createView("Words—here.");
  for (const text of ["```text\nWords—here.\n```", "`Words—here.`", "> Words—here.", "<div>Words—here.</div>", "<div>Words&mdash;here.</div>"]) {
    const revision = createView(text, { baseline: original });
    assert.equal(evaluateLocal(catalog, revision).status, "failed", text);
    const result = compareProtected(original, revision);
    assert.equal(result.outcome, "violation");
    assert.ok(result.wrapperChanges.length);
    assert.equal(compareProtected(original, createView(text)).outcome, "violation");
  }
});

test("literal preservation checks presence, multiplicity, order, and bytes", () => {
  const original = createView("Use `alpha` and `beta`, then [docs](https://example.org). Also use `alpha`.");
  assert.equal(compareProtected(original, createView(original.text, { baseline: original })).outcome, "clear");
  for (const text of [
    original.text.replace("`beta`", "`gamma`"),
    original.text.replace("`alpha` and `beta`", "`beta` and `alpha`"),
    original.text.replace(" Also use `alpha`.", ""),
    original.text.replace("https://example.org", "https://other.example"),
  ]) assert.equal(compareProtected(original, createView(text, { baseline: original })).outcome, "violation");
  assert.equal(compareProtected(original, createView(original.text, { baseline: original })).semanticPreservation, "not-evaluated");
});

test("GFM tables, footnotes, nested lists, and final sentences are covered", () => {
  const text = "| A | B |\n|---|---|\n| Good | Bad—here |\n\n- First.\n  - Second—item.\n\nNote[^x].\n\n[^x]: Footnote—text.\n\n" + "Fine prose. ".repeat(1500) + "Final—sentence.";
  const view = createView(text);
  const result = evaluateLocal(catalog, view);
  assert.equal(findings(result).length, 4);
  assert.ok(findings(result).some((finding) => finding.start > 16000));
  assert.ok(view.passages.some((passage) => passage.kind === "tableCell"));
  assert.ok(view.passages.some((passage) => passage.listed));
  assert.ok(view.protections.some((span) => span.kind === "citation"));
  assert.ok(view.passages.at(-1).sentences.at(-1).text.includes("Final—sentence."));
});

test("sentence and paragraph IDs are deterministic and source anchored", () => {
  const text = "First sentence. Second sentence.\n\nThird.";
  const first = createView(text);
  assert.deepEqual(first, createView(text));
  assert.equal(first.passages[0].sentences[1].id, "p1.s2");
  for (const passage of first.passages) assert.equal(passage.markdown, text.slice(passage.start, passage.end));
});

test("local checks do not impose quotas or flag contextual punctuation", () => {
  const text = "The formats are JSON, YAML, and TOML. A vector holds values. The stops are Portland, Oregon; Austin, Texas; and Albany, New York.";
  assert.equal(audit(text).status, "passed");
  assert.equal(audit("").checks[0].outcome, "inapplicable");
});
