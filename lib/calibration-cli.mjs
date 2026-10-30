import { mkdir, open, readFile, lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCatalog } from "./catalog.mjs";
import { createJevAdapter, JEV_MODEL } from "./jev.mjs";
import { createIsolatedWriter, WRITER_OPTION_KEYS } from "./repair.mjs";
import { corpusDigest, importCorpus, parseSubmissions, validateCorpus } from "./corpus.mjs";
import { calibrationReport, evaluateCorpus, promoteRule, promotionRecord, reportMarkdown } from "./calibration.mjs";
import { promotionProblems } from "./calibration-policy.mjs";

const common = ["--corpus", "--evaluation", "--output"];
const flagsFor = {
  "corpus-import": ["--input", "--output", "--name", "--version"],
  "evaluate-corpus": ["--corpus", "--catalog", "--skill", "--output", "--split", "--limits", "--audit-limits", "--model", "--allow-remote", "--writer-model", "--writer-settings", "--repair-drafts"],
  "calibration-report": [...common, "--format"],
  "calibration-review": [...common, "--check"],
  "promote-rule": [...common, "--catalog", "--skill", "--review"],
};
export const CALIBRATION_COMMANDS = Object.keys(flagsFor);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
async function unused(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Output already exists. Choose a new file to preserve the existing artifact.");
}
async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"); }
  catch (error) { await unlink(path); throw error; }
  finally { await file.close(); }
}
export async function calibrationMain(args, { registry, fetch: requestFetch, loadRegistry } = {}) {
  const [command, ...options] = args;
  const flags = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    if (!flagsFor[command]?.includes(flag) || flags.has(flag) || !options[index + 1] || options[index + 1].startsWith("--")) throw new Error("Invalid or repeated calibration option.");
    flags.set(flag, options[index + 1]);
  }
  const required = (name) => { if (!flags.has(name)) throw new Error(`${command} requires ${name}.`); return flags.get(name); };
  const output = required("--output");
  await unused(output);
  if (command === "corpus-import") {
    const corpus = importCorpus(parseSubmissions(await readFile(required("--input"), "utf8")), { name: required("--name"), version: required("--version") });
    await save(output, corpus);
    return { data: { file: output, digest: corpus.digest, records: corpus.records.length }, code: 0 };
  }
  const corpus = validateCorpus(await json(required("--corpus")));
  if (command === "evaluate-corpus") {
    if (flags.get("--allow-remote") !== "yes") throw new Error("Evaluation sends the selected corpus split to the classifier. Supply --allow-remote yes to authorize that transfer.");
    const catalog = await loadCatalog(required("--catalog"), required("--skill"));
    const limits = flags.has("--limits") ? await json(flags.get("--limits")) : {};
    const auditLimits = flags.has("--audit-limits") ? await json(flags.get("--audit-limits")) : {};
    const writerSettings = flags.has("--writer-settings") ? await json(flags.get("--writer-settings")) : {};
    if (!writerSettings || typeof writerSettings !== "object" || Array.isArray(writerSettings) || Object.keys(writerSettings).some((key) => !WRITER_OPTION_KEYS.includes(key))) throw new Error("Writer settings must contain supported generation preferences only.");
    if (!flags.has("--writer-model") && (flags.has("--writer-settings") || flags.has("--repair-drafts"))) throw new Error("Writer settings and draft capture require --writer-model.");
    if (flags.has("--writer-model")) {
      const drafts = required("--repair-drafts");
      if (resolve(drafts) === resolve(output)) throw new Error("Evaluation and repair drafts need different output files.");
      await unused(drafts);
    }
    const models = registry ?? await loadRegistry();
    const adapter = createJevAdapter(models, flags.get("--model") ?? JEV_MODEL, { fetch: requestFetch });
    let writer;
    let writerIdentity;
    if (flags.has("--writer-model")) {
      const [provider, ...parts] = flags.get("--writer-model").split("/");
      const selected = models.getModelOfType("chat", provider, parts.join("/"));
      if (!selected) throw new Error("The explicit writer model is unavailable in Pi's registry.");
      writer = createIsolatedWriter(models, selected, writerSettings);
      writerIdentity = { provider: selected.provider, model: selected.id, settingsDigest: corpusDigest(writerSettings) };
    }
    const { evaluation, repairDrafts } = await evaluateCorpus({ corpus, catalog, adapter, split: required("--split"), limits, auditLimits, writer, writerIdentity });
    await save(output, evaluation);
    if (writer) await save(flags.get("--repair-drafts"), repairDrafts);
    const report = calibrationReport(corpus, evaluation);
    return { data: { file: output, digest: evaluation.digest, samples: report.samples, budget: evaluation.budget }, code: report.metrics.some((metric) => metric.incompleteRate > 0) ? 2 : 0 };
  }
  const evaluation = await json(required("--evaluation"));
  if (command === "calibration-report") {
    const format = flags.get("--format") ?? "markdown";
    if (!["markdown", "json"].includes(format)) throw new Error("Report format must be markdown or json.");
    const report = calibrationReport(corpus, evaluation);
    await save(output, format === "markdown" ? reportMarkdown(report) : report);
  } else if (command === "calibration-review") {
    const record = promotionRecord(corpus, evaluation, required("--check"));
    await save(output, record);
    return { data: { file: output, promotionProblems: promotionProblems(record) }, code: 0 };
  } else if (command === "promote-rule") {
    const catalog = await loadCatalog(required("--catalog"), required("--skill"));
    const next = promoteRule({ corpus, evaluation, record: await json(required("--review")), catalog, skillText: await readFile(flags.get("--skill"), "utf8") });
    await save(output, next);
  } else throw new Error("Unknown calibration command.");
  return { data: { file: output }, code: 0 };
}
