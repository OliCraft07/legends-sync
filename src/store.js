// Where matches and tables are kept. The sync only ever uses these four calls, so
// tests use the in-memory store and the real run uses Firestore.

export const MATCH_PREFIX = 'szh-';

/** Keeps everything in memory (tests, and dry runs without credentials). */
export class MemoryStore {
  constructor({ matches = [], standings = [] } = {}) {
    this.matches = new Map(matches.map(({ id, doc }) => [id, doc]));
    this.standings = new Map(standings.map(({ id, doc }) => [id, doc]));
    this.writes = [];
  }

  async loadMatches() {
    return new Map(this.matches);
  }

  async loadStandings() {
    return new Map(this.standings);
  }

  async saveMatches(entries) {
    for (const { id, doc } of entries) {
      this.matches.set(id, doc);
      this.writes.push({ kind: 'match', id });
    }
  }

  async saveStandings(entries) {
    for (const { id, doc } of entries) {
      this.standings.set(id, doc);
      this.writes.push({ kind: 'standings', id });
    }
  }
}

/** Reads like [inner] but never writes: for `--dry-run`. */
export class ReadOnlyStore {
  constructor(inner, log = () => {}) {
    this.inner = inner;
    this.log = log;
  }

  loadMatches() {
    return this.inner.loadMatches();
  }

  loadStandings() {
    return this.inner.loadStandings();
  }

  async saveMatches(entries) {
    for (const { id } of entries) this.log(`  (dry run) would write match ${id}`);
  }

  async saveStandings(entries) {
    for (const { id } of entries) this.log(`  (dry run) would write standings ${id}`);
  }
}
