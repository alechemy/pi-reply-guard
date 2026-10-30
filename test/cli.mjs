import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { main } from "../cli.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

test("CLI catalog checks, coverage, and local audits are network-free", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reply-catalog-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "catalog.json");
  const skillPath = join(directory, "SKILL.md");
  const textPath = join(directory, "reply.md");
  await writeFile(catalogPath, JSON.stringify(makeCatalog()));
  await writeFile(skillPath, skill);
  const flags = ["--catalog", catalogPath, "--skill", skillPath];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Unexpected network call"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal((await main(["check-catalog", ...flags])).data.valid, true);
  assert.match((await main(["coverage", ...flags])).text, /36\. Rule 36/);
  await writeFile(textPath, "Plain prose.");
  const clean = await main(["audit-local", ...flags, "--text", textPath]);
  assert.equal(clean.code, 0);
  assert.equal(clean.data.local.semanticEvaluation, "not-executed");
  assert.ok(clean.data.semantic.every((check) => check.outcome === "pending"));
  await writeFile(textPath, "Words—here.");
  assert.equal((await main(["audit-local", ...flags, "--text", textPath])).code, 1);
  await writeFile(textPath, "```text\nWords—here.\n```");
  assert.equal((await main(["audit-local", ...flags, "--text", textPath])).code, 2);
  await writeFile(skillPath, skill.replace("Fictional policy 13.", "Changed policy."));
  assert.equal((await main(["check-catalog", ...flags])).code, 2);
  assert.equal(await readFile(catalogPath, "utf8"), JSON.stringify(makeCatalog()));
});

test("CLI rejects invalid arguments and malformed JSON with useful diagnostics", async () => {
  await assert.rejects(main(["unknown"]), /Usage:/);
  await assert.rejects(main(["coverage", "--skill", "a"]), /Both/);
  await assert.rejects(main(["coverage", "--skill", "a", "--skill", "b"]), /repeated/);
  await assert.rejects(main(["audit", "--catalog", "a", "--skill", "b"]), /requires --request/);
  await assert.rejects(main(["audit-local", "--model", "provider/model"]), /require the audit command/);
  const result = spawnSync(process.execPath, [new URL("../cli.mjs", import.meta.url).pathname, "unknown"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
