export class JudgmentCache {
  #entries = new Map();
  constructor({ capacity = 256, ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Cache capacity and retention must be positive integers.");
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
  }
  get size() { return this.#entries.size; }
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.expires <= this.now()) return;
    this.#entries.set(key, entry);
    return structuredClone(entry.value);
  }
  set(key, value) {
    this.#entries.delete(key);
    this.#entries.set(key, { value: structuredClone(value), expires: this.now() + this.ttlMs });
    while (this.#entries.size > this.capacity) this.#entries.delete(this.#entries.keys().next().value);
  }
  clear() { this.#entries.clear(); }
}
