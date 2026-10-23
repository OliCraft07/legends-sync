import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildMatchDoc, ourMatches } from '../src/convert.js';
import { parseLevelPage } from '../src/parse.js';
import { MemoryStore } from '../src/store.js';
import { baselineDue, liveCandidates, runBaseline, runLive } from '../src/sync.js';
import { clone, competition, FakeClient, fixture, levelHtml, matchHtml } from './helpers.js';

const NOW = new Date('2026-10-23T10:00:00Z');
const page = () => parseLevelPage(levelHtml());
const rawById = (id) => page().matches.find((m) => m.id === id);

/** The own page of a match: the fixture's rosters with the match's own data on top. */
function detailOf(id, overrides = {}) {
  return { ...clone(fixture('match-finished')), ...clone(rawById(id)), ...overrides };
}

function clientWith(extra = {}) {
  const matches = {};
  for (const id of [90785, 90843, 90910]) matches[id] = matchHtml(detailOf(id));
  return new FakeClient({ levels: { '236/258': levelHtml() }, matches: { ...matches, ...extra } });
}

const baseline = (client, store, extra = {}) =>
  runBaseline({ client, store, now: () => NOW, competitions: [competition], ...extra });

describe('the everyday pass', () => {
  test('the first run adds our matches and the table, and reads the pages of the played ones', async () => {
    const client = clientWith();
    const store = new MemoryStore();

    const { summary, matches } = await baseline(client, store);

    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.warnings, []);
    assert.equal(summary.added, 6);
    assert.equal(summary.updated, 0);
    assert.equal(summary.standingsWritten, 1);
    assert.equal(matches.size, 6);
    assert.equal(store.matches.size, 6);
    assert.equal(store.standings.get('starsiDorastenci').rows.length, 6);
    // One competition page and the three played matches' pages.
    assert.deepEqual(client.requests, ['level 236/258', 'match 90910', 'match 90843', 'match 90785']);

    const played = store.matches.get('szh-starsiDorastenci-k7');
    assert.equal(played.homeScore, 49);
    assert.equal(played.details.hasFullRoster, true);
    assert.equal(store.matches.get('szh-starsiDorastenci-k8').details, null);
  });

  test('running it again changes and downloads nothing', async () => {
    const store = new MemoryStore();
    await baseline(clientWith(), store);
    const writesBefore = store.writes.length;

    const client = clientWith();
    const { summary } = await baseline(client, store);

    assert.equal(summary.added, 0);
    assert.equal(summary.updated, 0);
    assert.equal(summary.unchanged, 6);
    assert.equal(summary.standingsWritten, 0);
    assert.deepEqual(client.requests, ['level 236/258']);
    assert.equal(store.writes.length, writesBefore);
  });

  test('a changed result is written and its page read again', async () => {
    const store = new MemoryStore();
    await baseline(clientWith(), store);

    const changed = fixture('level-236');
    const match = changed.levelTabs[1].childLevels[0].matches.find((m) => m.id === 90785);
    match.homeParticipantResult = '50';
    const client = clientWith({ 90785: matchHtml(detailOf(90785, { homeParticipantResult: '50' })) });
    client.levels['236/258'] = levelHtml(changed);

    const { summary } = await baseline(client, store);

    assert.equal(summary.updated, 1);
    assert.ok(client.requests.includes('match 90785'));
    assert.equal(client.requests.filter((r) => r.startsWith('match')).length, 1);
    assert.equal(store.matches.get('szh-starsiDorastenci-k7').homeScore, 50);
  });

  test('the venue an admin typed survives every pass', async () => {
    const store = new MemoryStore();
    await baseline(clientWith(), store);
    const id = 'szh-starsiDorastenci-k8';
    store.matches.set(id, { ...store.matches.get(id), venue: 'Prešov, hala' });

    await baseline(clientWith(), store);

    assert.equal(store.matches.get(id).venue, 'Prešov, hala');
  });

  test('a category that cannot be read does not stop the others', async () => {
    const other = { category: 'muzi', level: 235, stage: 257, teamId: 6650 };
    const client = clientWith();
    client.levels['235/257'] = new Error('Server slovakhandball.sk vrátil chybu 503.');
    const store = new MemoryStore();

    const { summary } = await baseline(client, store, { competitions: [other, competition] });

    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /muzi: .*503/);
    assert.equal(summary.added, 6);
    assert.equal(store.matches.size, 6);
  });

  test('a page that cannot be parsed is reported, not thrown', async () => {
    const client = clientWith();
    client.levels['236/258'] = '<html>nový web</html>';
    const { summary } = await baseline(client, new MemoryStore());
    assert.match(summary.errors[0], /starsiDorastenci/);
    assert.equal(summary.added, 0);
  });

  test('a match page that fails still saves the match, and is tried again next time', async () => {
    const store = new MemoryStore();
    const client = clientWith({ 90785: new Error('Server slovakhandball.sk vrátil chybu 500.') });

    const first = await baseline(client, store);

    assert.equal(first.summary.warnings.length, 1);
    assert.match(first.summary.warnings[0], /90785/);
    const saved = store.matches.get('szh-starsiDorastenci-k7');
    assert.equal(saved.homeScore, 49);
    assert.equal(saved.details, null);

    const again = clientWith();
    await baseline(again, store);
    assert.ok(again.requests.includes('match 90785'));
    assert.ok(store.matches.get('szh-starsiDorastenci-k7').details);
  });

  test('a wrong team number is called out', async () => {
    const { summary } = await baseline(clientWith(), new MemoryStore(), {
      competitions: [{ ...competition, teamId: 1 }],
    });
    assert.match(summary.warnings[0], /nenašli sa žiadne zápasy/);
  });

  test('the table is written again after twelve hours even when unchanged', async () => {
    const store = new MemoryStore();
    await baseline(clientWith(), store);

    const later = new Date(NOW.getTime() + 13 * 3600_000);
    const { summary } = await runBaseline({ client: clientWith(), store, now: () => later, competitions: [competition] });

    assert.equal(summary.standingsWritten, 1);
    assert.equal(store.standings.get('starsiDorastenci').updatedAt, later);
  });

  test('matches the federation no longer lists are reported and never deleted', async () => {
    const stale = { category: 'starsiDorastenci', dateTime: NOW, homeTeam: 'Legends Šaľa', awayTeam: 'Stará duplicita', homeScore: null, awayScore: null };
    const store = new MemoryStore({ matches: [{ id: 'szh-starsiDorastenci-k99', doc: stale }] });

    const { summary } = await baseline(clientWith(), store);

    assert.ok(summary.warnings.some((w) => /starsiDorastenci: 1 zápasov .*k99/.test(w)));
    assert.deepEqual(store.matches.get('szh-starsiDorastenci-k99'), stale);
  });

  test('a match of another category is not reported as gone', async () => {
    const other = { category: 'muzi', dateTime: NOW };
    const store = new MemoryStore({ matches: [{ id: 'szh-muzi-k3', doc: other }] });
    const { summary } = await baseline(clientWith(), store);
    assert.deepEqual(summary.warnings, []);
  });

  test('matches of the app that are not from the federation are not touched', async () => {
    const store = new MemoryStore({ matches: [{ id: 'abc123', doc: { category: 'muzi', dateTime: NOW } }] });
    await baseline(clientWith(), store);
    assert.deepEqual(store.matches.get('abc123'), { category: 'muzi', dateTime: NOW });
  });
});

describe('when the everyday pass is due', () => {
  const doc = (iso) => ({ dateTime: new Date(iso) });
  const days = (...isos) => new Map(isos.map((iso, i) => [`m${i}`, doc(iso)]));

  test('always on an empty database', () => {
    assert.equal(baselineDue(new Map(), new Date('2026-10-20T11:00:00Z')), true);
  });

  test('on a day with a match, and the day after', () => {
    const matches = days('2026-10-24T11:00:00Z');
    assert.equal(baselineDue(matches, new Date('2026-10-24T08:00:00Z')), true);
    assert.equal(baselineDue(matches, new Date('2026-10-25T08:00:00Z')), true);
  });

  test('not on a quiet day, except at hours divisible by six', () => {
    const matches = days('2026-10-24T11:00:00Z');
    assert.equal(baselineDue(matches, new Date('2026-10-22T09:07:00Z')), false); // 11:07 Slovak time
    assert.equal(baselineDue(matches, new Date('2026-10-22T10:07:00Z')), true); // 12:07
    assert.equal(baselineDue(matches, new Date('2026-10-22T16:07:00Z')), true); // 18:07
  });

  test('the Slovak day counts, not the UTC one', () => {
    // 22:30 UTC on the 23rd is 00:30 on the 24th in Slovakia: the match day.
    assert.equal(baselineDue(days('2026-10-24T11:00:00Z'), new Date('2026-10-23T22:30:00Z')), true);
  });
});

describe('which matches are followed live', () => {
  const doc = (kickoff, extra = {}) => ({
    dateTime: new Date(kickoff),
    timeUnknown: false,
    szhId: 1,
    homeScore: null,
    awayScore: null,
    details: null,
    live: false,
    ...extra,
  });

  test('from shortly before the kickoff until two and a half hours after', () => {
    const matches = new Map([['a', doc('2026-10-24T11:00:00Z')]]);
    assert.equal(liveCandidates(matches, new Date('2026-10-24T09:40:00Z')).size, 0); // 80 min ahead
    assert.equal(liveCandidates(matches, new Date('2026-10-24T10:00:00Z')).size, 1); // 60 min ahead
    assert.equal(liveCandidates(matches, new Date('2026-10-24T12:30:00Z')).size, 1);
    assert.equal(liveCandidates(matches, new Date('2026-10-24T13:31:00Z')).size, 0); // 151 min after
  });

  test('not a match that is done, one without a known time, or one the federation has no number for', () => {
    const at = new Date('2026-10-24T12:00:00Z');
    const finished = doc('2026-10-24T11:00:00Z', { homeScore: 30, awayScore: 20, details: { hasFullRoster: true } });
    const noTime = doc('2026-10-24T11:00:00Z', { timeUnknown: true });
    const noId = doc('2026-10-24T11:00:00Z', { szhId: undefined });
    const live = doc('2026-10-24T11:00:00Z', { homeScore: 5, awayScore: 4, details: {}, live: true });
    assert.equal(liveCandidates(new Map([['f', finished], ['t', noTime], ['n', noId]]), at).size, 0);
    assert.equal(liveCandidates(new Map([['l', live]]), at).size, 1);
  });
});

describe('following a match live', () => {
  const KICKOFF = '2026-10-24T11:00:00Z';
  const ID = 'szh-starsiDorastenci-k8';

  /** A clock the tests move by "sleeping". */
  function clock(start) {
    let t = new Date(start).getTime();
    return { now: () => new Date(t), sleep: async (ms) => { t += ms; }, at: () => t };
  }

  function setUp(startIso, script) {
    const time = clock(startIso);
    const stored = buildMatchDoc({
      competition,
      leagueName: '1. liga st.dorastenci',
      id: ID,
      raw: rawById(90748),
    });
    const store = new MemoryStore({ matches: [{ id: ID, doc: stored }] });
    const matches = new Map([[ID, stored]]);
    let polls = 0;
    const client = new FakeClient({
      matches: {
        90748: () => {
          const step = script(time.at(), polls++);
          return matchHtml(detailOf(90748, step));
        },
      },
    });
    return { time, store, matches, client, polls: () => polls };
  }

  const run = (env, extra = {}) =>
    runLive({ client: env.client, store: env.store, matches: env.matches, now: env.time.now, sleep: env.time.sleep, ...extra });

  test('waits for the kickoff, follows the score and stops at the final whistle', async () => {
    const env = setUp('2026-10-24T10:30:00Z', (t, poll) => {
      const minutesIn = (t - new Date(KICKOFF).getTime()) / 60000;
      if (minutesIn < 70) return { state: 'InProgress', homeParticipantResult: String(Math.max(0, Math.floor(minutesIn / 5))), visitingParticipantResult: '1' };
      return { state: 'Finished', homeParticipantResult: '15', visitingParticipantResult: '12' };
    });

    const summary = await run(env);

    assert.deepEqual(summary.errors, []);
    assert.equal(summary.finished, 1);
    const final = env.store.matches.get(ID);
    assert.equal(final.live, false);
    assert.equal(final.homeScore, 15);
    assert.equal(final.awayScore, 12);
    assert.equal(final.details.hasFullRoster, true);
    // It began at kickoff minus ten minutes, not before.
    assert.ok(env.polls() >= 70, `polled ${env.polls()} times`);
    assert.ok(env.polls() <= 85, `polled ${env.polls()} times`);
    // And it did not keep going after the end.
    assert.equal(env.client.requests.at(-1), 'match 90748');
    assert.equal(env.matches.get(ID).homeScore, 15);
  });

  test('writes only when something changed, and marks the match live meanwhile', async () => {
    const seen = [];
    const env = setUp('2026-10-24T11:00:00Z', (t, poll) => {
      if (poll < 3) return { state: 'InProgress', homeParticipantResult: '1', visitingParticipantResult: '0' };
      if (poll < 5) return { state: 'InProgress', homeParticipantResult: '2', visitingParticipantResult: '0' };
      return { state: 'Finished', homeParticipantResult: '2', visitingParticipantResult: '0' };
    });
    const origSave = env.store.saveMatches.bind(env.store);
    env.store.saveMatches = async (entries) => {
      seen.push(entries[0].doc.live);
      await origSave(entries);
    };

    const summary = await run(env);

    // 1:0 (live), 2:0 (live), final (not live): three writes for six polls.
    assert.equal(summary.polls, 6);
    assert.equal(summary.writes, 3);
    assert.deepEqual(seen, [true, true, false]);
  });

  test('keeps the round label the everyday pass gave', async () => {
    const env = setUp('2026-10-24T11:00:00Z', () => ({ state: 'Finished', homeParticipantResult: '3', visitingParticipantResult: '2' }));
    await run(env);
    assert.equal(env.store.matches.get(ID).competition, '1. liga · 8. kolo');
  });

  test('stops after the time it is allowed to run', async () => {
    const env = setUp('2026-10-24T11:00:00Z', () => ({ state: 'InProgress', homeParticipantResult: '1', visitingParticipantResult: '1' }));
    const summary = await run(env, { maxMinutes: 10 });
    assert.equal(summary.finished, 0);
    assert.ok(summary.polls >= 9 && summary.polls <= 12, `polled ${summary.polls} times`);
  });

  test('gives up after ten rounds in which nothing could be downloaded', async () => {
    const env = setUp('2026-10-24T11:00:00Z', () => ({}));
    env.client.matches[90748] = new Error('Server slovakhandball.sk vrátil chybu 500.');
    const summary = await run(env);
    assert.ok(summary.errors.some((e) => /Desať kôl/.test(e)));
    assert.ok(env.client.requests.length <= 12);
  });

  test('a failed poll in between does not end it', async () => {
    const env = setUp('2026-10-24T11:00:00Z', (t, poll) => {
      if (poll === 1) throw new Error('Server slovakhandball.sk neodpovedá.');
      if (poll < 4) return { state: 'InProgress', homeParticipantResult: '1', visitingParticipantResult: '0' };
      return { state: 'Finished', homeParticipantResult: '1', visitingParticipantResult: '0' };
    });
    const summary = await run(env);
    assert.equal(summary.finished, 1);
    assert.equal(summary.errors.length, 1);
  });

  test('does nothing when no match is near', async () => {
    const env = setUp('2026-10-23T08:00:00Z', () => ({ state: 'Finished' }));
    const summary = await run(env);
    assert.equal(summary.polls, 0);
    assert.deepEqual(env.client.requests, []);
  });

  test('knows the matches ourMatches finds are the ones to follow', () => {
    const doc = buildMatchDoc({ competition, leagueName: 'x', id: ID, raw: ourMatches(competition, page().matches).find((m) => m.id === ID).raw });
    assert.equal(doc.szhId, 90748);
    assert.equal(liveCandidates(new Map([[ID, doc]]), new Date('2026-10-24T11:30:00Z')).size, 1);
  });
});
