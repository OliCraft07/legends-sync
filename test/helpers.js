import { readFileSync } from 'node:fs';

export const competition = {
  category: 'starsiDorastenci',
  level: 236,
  stage: 258,
  teamId: 6569,
  competitionName: '1. liga',
};

/** A page whose data is wrapped as the real site does (Next.js "flight" data). */
export function flightPage(value) {
  const line = `1:${JSON.stringify(value)}\n`;
  return `<html><head></head><body><script>self.__next_f.push([1,${JSON.stringify(line)}])</script></body></html>`;
}

export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

export const clone = (value) => JSON.parse(JSON.stringify(value));

/** The competition page of the fixture, as HTML. */
export function levelHtml(level = fixture('level-236')) {
  return flightPage(level);
}

/** A match page, as HTML. */
export function matchHtml(detail) {
  return flightPage({ matchDetail: detail });
}

/** A client that hands out prepared pages and counts the requests. */
export class FakeClient {
  constructor({ levels = {}, matches = {} } = {}) {
    this.levels = levels;
    this.matches = matches;
    this.requests = [];
  }

  async levelPage(level, stage) {
    this.requests.push(`level ${level}/${stage}`);
    const page = this.levels[`${level}/${stage}`];
    if (page === undefined) throw new Error(`no such level ${level}/${stage}`);
    if (page instanceof Error) throw page;
    return typeof page === 'function' ? page() : page;
  }

  async matchPage(id) {
    this.requests.push(`match ${id}`);
    const page = this.matches[id];
    if (page === undefined) throw new Error(`no such match ${id}`);
    if (page instanceof Error) throw page;
    return typeof page === 'function' ? page() : page;
  }
}
