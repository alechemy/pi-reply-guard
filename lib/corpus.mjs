import { digest } from "./catalog.mjs";
import { canonicalJSON } from "./calibration-policy.mjs";
import { PRESERVATION_IDS } from "./preservation.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
export const corpusDigest = (value) => digest(canonicalJSON(value));
export const proseKey = (value) => digest(value.normalize("NFKC").replace(/\s+/gu, " ").trim());
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Corpus record has an unsupported field or shape.");
}
function reviewOf(value) {
  keys(value, ["basis", "reviewer"]);
  if (!["human-labeled", "human-reviewed", "synthetic"].includes(value.basis) || (value.basis !== "synthetic" && !text(value.reviewer))) throw new Error("Corpus labels need a review basis and a human reviewer when applicable.");
  return { basis: value.basis, ...(value.reviewer ? { reviewer: value.reviewer } : {}) };
}
function normalize(record) {
  keys(record, ["id", "group", "split", "kind", "request", "reply", "original", "conversation", "verbatim", "labels", "review", "correctionOf", "source"]);
  if (!identifier(record.id) || !identifier(record.group) || !["development", "held-out"].includes(record.split) || !["style", "preservation"].includes(record.kind)) throw new Error("Corpus records require stable IDs, a group, a split, and a supported kind.");
  if (!(record.request === null || text(record.request)) || !text(record.reply) || (record.split === "held-out" && record.request === null)) throw new Error("Replies need text. Held-out samples also need their original request.");
  if ((record.kind === "preservation" && !text(record.original)) || (record.kind === "style" && record.original !== undefined)) throw new Error("Preservation records require an original reference. Style records cannot supply one.");
  if (!object(record.labels) || !Object.keys(record.labels).length || Object.entries(record.labels).some(([id, label]) => !/^[a-z][a-z0-9-]+$/.test(id) || !["clear", "violation", "exception"].includes(label) || (record.kind === "preservation" ? !PRESERVATION_IDS.includes(id) : id.startsWith("preserve-")))) throw new Error("Invalid per-check corpus labels.");
  const conversation = record.conversation ?? [];
  if (!Array.isArray(conversation)) throw new Error("Invalid corpus conversation.");
  for (const message of conversation) {
    keys(message, ["role", "text"]);
    if (!["user", "assistant"].includes(message.role) || !text(message.text)) throw new Error("Corpus context accepts visible user and assistant text only.");
  }
  const verbatim = record.verbatim ?? [];
  if (!Array.isArray(verbatim)) throw new Error("Invalid corpus provenance.");
  for (const source of verbatim) {
    keys(source, ["sourceId", "text"]);
    if (!text(source.sourceId) || !text(source.text)) throw new Error("Invalid corpus provenance.");
  }
  if (record.correctionOf !== undefined && (!identifier(record.correctionOf) || record.kind !== "style")) throw new Error("Invalid correction relationship.");
  if (record.source !== undefined && !text(record.source)) throw new Error("Invalid corpus source reference.");
  return structuredClone({ ...record, conversation, verbatim, review: reviewOf(record.review) });
}
export function expandSubmission(value) {
  if (Array.isArray(value)) return value.flatMap(expandSubmission);
  if (!object(value) || !value.rejected || !value.accepted) return [value];
  keys(value, ["schemaVersion", "id", "split", "source", "request", "conversation", "contextStatus", "rejected", "accepted", "review", "expectedEdit"]);
  if (value.schemaVersion !== 1) throw new Error("Unsupported paired submission version.");
  for (const candidate of [value.rejected, value.accepted]) keys(candidate, ["reply", "labels"]);
  return ["rejected", "accepted"].map((side) => ({
    id: `${value.id}:${side}`, group: value.id, split: value.split, kind: "style", request: value.request,
    reply: value[side].reply, labels: value[side].labels, review: value.review,
    ...(value.conversation ? { conversation: value.conversation } : {}), ...(value.source ? { source: value.source } : {}),
    ...(side === "accepted" ? { correctionOf: `${value.id}:rejected` } : {}),
  }));
}
export function importCorpus(input, { name, version }) {
  if (!identifier(name) || !identifier(version)) throw new Error("Corpus name and version must be stable identifiers.");
  const records = expandSubmission(input).map(normalize);
  if (!records.length) throw new Error("A corpus needs at least one record.");
  const ids = new Map();
  const groups = new Map();
  const replies = new Map();
  const samples = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error("Duplicate corpus record ID.");
    ids.set(record.id, record);
    if (groups.has(record.group) && groups.get(record.group) !== record.split) throw new Error("Related examples cross development and held-out splits.");
    groups.set(record.group, record.split);
    for (const content of [record.reply, record.original].filter(Boolean)) {
      const key = proseKey(content);
      if (replies.has(key) && replies.get(key) !== record.split) throw new Error("Repeated prose crosses development and held-out splits.");
      replies.set(key, record.split);
    }
    const key = corpusDigest({ kind: record.kind, request: record.request, reply: proseKey(record.reply), original: record.original ? proseKey(record.original) : null, conversation: record.conversation });
    if (samples.has(key)) throw new Error("Duplicate corpus sample.");
    samples.add(key);
  }
  for (const record of records.filter((record) => record.correctionOf)) {
    const original = ids.get(record.correctionOf);
    if (!original || original.kind !== "style" || original.group !== record.group || original.split !== record.split || original.id === record.id || original.correctionOf) throw new Error("A correction must reference its original in the same group and split.");
  }
  const data = { schemaVersion: 1, name, version, records };
  return { ...data, digest: corpusDigest(data) };
}
export function validateCorpus(value) {
  keys(value, ["schemaVersion", "name", "version", "records", "digest"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error("Unsupported corpus format.");
  const checked = importCorpus(value.records, value);
  if (checked.digest !== value.digest) throw new Error("Corpus digest mismatch. Import a new dataset version after editing records.");
  return checked;
}
export function parseSubmissions(content) {
  try { return JSON.parse(content); }
  catch { return content.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line)); }
}
