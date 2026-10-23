import { SITE_URL } from './config.js';

export class SiteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads pages of slovakhandball.sk one at a time with a pause in between, so
 * the load on the federation's server stays that of a single reader. Sends a
 * User-Agent that names the project.
 */
export class SiteClient {
  constructor({
    baseUrl = SITE_URL,
    pauseMs = 1500,
    retries = 2,
    userAgent = 'LegendsSalaSync/1.0 (club schedule app; Legends Sala handball club)',
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    now = () => Date.now(),
  } = {}) {
    this.baseUrl = baseUrl;
    this.pauseMs = pauseMs;
    this.retries = retries;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.sleep = sleepImpl;
    this.now = now;
    this.lastRequestAt = null;
    this.requests = 0;
    this.bytes = 0;
  }

  levelPage(level, stage) {
    return this.#get(`/levels/${level}/${stage}`);
  }

  matchPage(id) {
    return this.#get(`/matches/${id}`);
  }

  async #get(path) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(this.pauseMs * 2 * attempt);
      await this.#pause();
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'sk' },
          signal: AbortSignal.timeout(45_000),
        });
        if (response.status === 404) throw new SiteError(`Stránka ${path} neexistuje (404).`);
        if (!response.ok) {
          lastError = new SiteError(`Server slovakhandball.sk vrátil chybu ${response.status} pri ${path}.`);
          continue;
        }
        const html = await response.text();
        this.requests++;
        this.bytes += html.length;
        return html;
      } catch (error) {
        if (error instanceof SiteError && error.message.includes('404')) throw error;
        lastError = error instanceof SiteError ? error : new SiteError(`Nepodarilo sa stiahnuť ${path}: ${error.message}`);
      }
    }
    throw lastError;
  }

  async #pause() {
    if (this.lastRequestAt !== null) {
      const wait = this.pauseMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt = this.now();
  }
}
