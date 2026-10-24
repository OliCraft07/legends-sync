import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildMatchDoc, DETAILS_VERSION, ourMatches } from '../src/convert.js';
import { parseLevelPage } from '../src/parse.js';
import { MemoryStore } from '../src/store.js';
import { baselineDue, liveCandidates, runBaseline, runDaemon, runLive } from '../src/sync.js';
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

  test('details an earlier importer wrote are read once more, then left alone', async () => {
    const store = new MemoryStore();
    await baseline(clientWith(), store);
    const id = 'szh-starsiDorastenci-k7';
    const { importVersion, ...older } = store.matches.get(id).details;
    store.matches.set(id, { ...store.matches.get(id), details: older });

    const first = clientWith();
    await baseline(first, store);
    assert.deepEqual(first.requests.filter((r) => r.startsWith('match')), ['match 90785']);
    assert.equal(store.matches.get(id).details.importVersion, DETAILS_VERSION);

    const second = clientWith();
    await baseline(second, store);
    assert.deepEqual(second.requests, ['level 236/258']);
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

  test('a team without a logo in the table gets the one its matches (or another category) show', async () => {
    const changed = fixture('level-236');
    const board = changed.levelTabs[0].childLevels[0].scoreboards;
    const zilina = board.find((s) => s.participants[0].id === 6576) ?? board[0];
    const name = zilina.participants[0].name;
    zilina.participants[0].logoEntity = null; // the table has none, the matches still do

    const client = clientWith();
    client.levels['236/258'] = levelHtml(changed);
    const store = new MemoryStore();
    await baseline(client, store);

    const row = store.standings.get('starsiDorastenci').rows.find((r) => r.team === name.replace(/\s+/g, ' ').trim());
    assert.ok(row, 'the team is in the table');
    assert.match(row.logoUrl ?? '', /cdn\.handball\.eliterro\.sk/);
  });

  test('a logo missing in one category is taken from another category', async () => {
    // The same team, "Tatran Prešov", is in the table of both categories. The first
    // page has its logo everywhere, the second page nowhere.
    const name = 'Tatran Prešov';
    const withLogo = fixture('level-236');
    const logo = withLogo.levelTabs[2].childLevels[0].matches
      .flatMap((m) => [m.homeParticipant, m.visitingParticipant])
      .find((team) => team.name === name).logoEntity.url;

    const without = fixture('level-236');
    const sides = ['homeParticipant', 'visitingParticipant'];
    for (const tab of without.levelTabs.slice(1, 3)) {
      for (const m of tab.childLevels[0].matches) for (const side of sides) if (m[side].name === name) m[side].logoEntity = null;
    }
    for (const s of without.levelTabs[0].childLevels[0].scoreboards) if (s.participants[0].name === name) s.participants[0].logoEntity = null;

    const second = { category: 'muzi', level: 235, stage: 257, teamId: 6569, competitionName: '1. liga' };
    const client = clientWith();
    client.levels['235/257'] = levelHtml(without);
    const store = new MemoryStore();
    await baseline(client, store, { competitions: [competition, second] });

    const row = store.standings.get('muzi').rows.find((r) => r.team === name);
    assert.ok(row, 'the team is in the table');
    assert.equal(row.logoUrl, logo);
    // and as an opponent in a match of that category
    const away = [...store.matches.values()].find((m) => m.category === 'muzi' && m.homeTeam === name);
    assert.equal(away.opponentLogoUrl, logo);
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

// How the federation's pages behaved on 24 October 2026 (see the log of that day): a match is
// "Upcoming" with nothing on it for the first few minutes, then "Finished" for the rest, also
// while it is being played, and the goals come in as they are scored. This builds such a match.
const KICKOFF = '2026-10-24T11:00:00Z';
const kickoffMs = Date.parse(KICKOFF);
const MATCH_ID = 90748; // Tatran Prešov (home) against our team

/** A match, as the federation's page shows it [minutes] after the kickoff. */
function federationAfter(minutes, { lastGoal = 62, everyMinutes = 2 } = {}) {
  const athlete = fixture('match-finished').homeParticipantLineup[0];
  const homeId = rawById(MATCH_ID).homeParticipant.id;
  const goals = [];
  for (let m = 6; m <= Math.min(minutes, lastGoal); m += everyMinutes) {
    if (m > 28 && m < 42) continue; // half-time
    goals.push(m);
  }
  const matchEvents = goals.map((m, i) => ({
    date: new Date(kickoffMs + m * 60_000).toISOString(),
    eventType: 'goal',
    description: 's1',
    matchPart: m < 30 ? 1 : 2,
    result: `${i + 1}:0`,
    athlete,
    participant: { id: homeId },
  }));
  const started = minutes >= 6;
  return {
    state: started ? 'Finished' : 'Upcoming',
    homeParticipantResult: started ? String(goals.length) : null,
    visitingParticipantResult: started ? '0' : null,
    matchEvents,
  };
}

/** A clock the tests move by "sleeping". */
function clock(startIso) {
  let t = Date.parse(startIso);
  return { now: () => new Date(t), sleep: async (ms) => { t += ms; }, at: () => t, minutes: () => (t - kickoffMs) / 60_000 };
}

describe('following a match live', () => {
  const ID = 'szh-starsiDorastenci-k8';

  function setUp(startIso, page = (minutes) => federationAfter(minutes)) {
    const time = clock(startIso);
    const stored = buildMatchDoc({ competition, leagueName: '1. liga st.dorastenci', id: ID, raw: rawById(MATCH_ID), now: time.now() });
    const store = new MemoryStore({ matches: [{ id: ID, doc: stored }] });
    const written = [];
    const save = store.saveMatches.bind(store);
    store.saveMatches = async (entries) => {
      for (const { doc } of entries) written.push({ minutes: time.minutes(), live: doc.live, score: `${doc.homeScore}:${doc.awayScore}`, events: doc.details?.events.length ?? 0 });
      await save(entries);
    };
    const matches = new Map([[ID, stored]]);
    const client = new FakeClient({ matches: { [MATCH_ID]: () => matchHtml(detailOf(MATCH_ID, page(time.minutes()))) } });
    return { time, store, matches, client, written };
  }

  const run = (env, extra = {}) =>
    runLive({ client: env.client, store: env.store, matches: env.matches, now: env.time.now, sleep: env.time.sleep, ...extra });

  test('writes the goals as they come, through the half-time break, and ends the match after the quiet that follows the last one', async () => {
    const env = setUp('2026-10-24T10:30:00Z');

    const summary = await run(env);

    assert.deepEqual(summary.errors, []);
    assert.equal(summary.finished, 1);
    const final = env.store.matches.get(ID);
    assert.equal(final.live, false);
    assert.equal(final.homeScore, 23);
    assert.equal(final.awayScore, 0);
    assert.equal(final.details.events.length, 23);
    assert.equal(final.details.hasFullRoster, true);

    // The first thing written is a goal, six minutes in, not "the match is over".
    assert.equal(env.written[0].live, true);
    assert.ok(env.written[0].minutes >= 6 && env.written[0].minutes < 8, `first write at ${env.written[0].minutes}`);
    // Everything before the end says "in progress": the federation's "Finished" did not end it,
    // and neither did the half-time break (nothing happens between minute 28 and 42).
    const beforeEnd = env.written.slice(0, -1);
    assert.ok(beforeEnd.length >= 20);
    assert.ok(beforeEnd.every((w) => w.live === true), 'all in progress until the end');
    // It ended after the last goal (minute 62) and the quiet of six minutes.
    const last = env.written.at(-1);
    assert.equal(last.live, false);
    assert.ok(last.minutes >= 68 && last.minutes <= 70, `ended at ${last.minutes}`);
    assert.ok(env.time.minutes() <= 71, `stopped at ${env.time.minutes()}`);
  });

  test('a match the federation lists as "Finished" without a result is never taken for over', async () => {
    // Like the two youth matches with the wrong date.
    const env = setUp('2026-10-24T10:30:00Z', () => ({ state: 'Finished', homeParticipantResult: null, visitingParticipantResult: null, matchEvents: [] }));

    const summary = await run(env, { maxMinutes: 60 });

    assert.equal(summary.finished, 0);
    assert.equal(env.written.length, 0);
    assert.equal(env.store.matches.get(ID).homeScore, null);
    assert.ok(summary.polls >= 30, `polled ${summary.polls} times`);
  });

  test('a long pause in the first half does not end it, because the second half has not begun', async () => {
    // A goal at minute 6, then nothing for 25 minutes (a long time-out), then the second half.
    const env = setUp('2026-10-24T10:55:00Z', (minutes) => federationAfter(minutes, { lastGoal: 50, everyMinutes: 10 }));

    await run(env);

    const first = env.written.filter((w) => w.minutes < 28);
    assert.ok(first.length >= 1);
    assert.ok(first.every((w) => w.live === true));
  });

  test('ends a match that is still recording after the longest a match can take', async () => {
    const env = setUp('2026-10-24T10:55:00Z', (minutes) => federationAfter(minutes, { lastGoal: 500 }));

    await run(env);

    assert.equal(env.store.matches.get(ID).live, false);
    assert.ok(env.time.minutes() >= 100 && env.time.minutes() <= 101, `stopped at ${env.time.minutes()}`);
  });

  test('a goal after the match was thought to be over makes it live again at the next everyday pass', async () => {
    const env = setUp('2026-10-24T10:30:00Z');
    await run(env);
    const ended = env.store.matches.get(ID);
    assert.equal(ended.live, false);

    // A late goal: the level page now shows 24:0 at minute 75.
    const raw = { ...rawById(MATCH_ID), state: 'Finished', homeParticipantResult: '24', visitingParticipantResult: '0' };
    const doc = buildMatchDoc({
      competition,
      leagueName: 'x',
      id: ID,
      raw,
      existing: ended,
      now: new Date(kickoffMs + 75 * 60_000),
    });
    assert.equal(doc.live, true);
    assert.equal(doc.homeScore, 24);
  });

  test('writes only when something changed', async () => {
    const env = setUp('2026-10-24T10:55:00Z', (minutes) => federationAfter(minutes, { lastGoal: 14 }));

    const summary = await run(env);

    // Goals at 6, 8, 10, 12, 14: five writes, then the end (the quiet is in the first half, so the
    // match is only over after the 100 minutes).
    assert.equal(env.written.filter((w) => w.live === true).length, 5);
    assert.ok(summary.polls > 90);
  });

  test('gives up after ten rounds in which nothing could be downloaded', async () => {
    const env = setUp('2026-10-24T11:00:00Z', () => ({}));
    env.client.matches[MATCH_ID] = new Error('Server slovakhandball.sk vrátil chybu 500.');
    const summary = await run(env);
    assert.ok(summary.errors.some((e) => /Desať kôl/.test(e)));
    assert.ok(env.client.requests.length <= 40);
  });

  test('a failed poll in between does not end it', async () => {
    const env = setUp('2026-10-24T10:55:00Z', (minutes) => {
      if (Math.round(minutes) === 12) throw new Error('Server slovakhandball.sk neodpovedá.');
      return federationAfter(minutes);
    });
    const summary = await run(env);
    assert.equal(summary.finished, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(env.store.matches.get(ID).live, false);
  });

  test('does nothing when no match is near', async () => {
    const env = setUp('2026-10-23T08:00:00Z');
    const summary = await run(env);
    assert.equal(summary.polls, 0);
    assert.deepEqual(env.client.requests, []);
  });

  test('knows the matches ourMatches finds are the ones to follow', () => {
    const doc = buildMatchDoc({ competition, leagueName: 'x', id: ID, raw: ourMatches(competition, page().matches).find((m) => m.id === ID).raw });
    assert.equal(doc.szhId, MATCH_ID);
    assert.equal(liveCandidates(new Map([[ID, doc]]), new Date('2026-10-24T11:30:00Z')).size, 1);
  });
});

describe('a whole match day in one run', () => {
  const ID = 'szh-starsiDorastenci-k8';

  /** The competition page as it is [minutes] after the kickoff (the federation's lists show the result so far). */
  function levelAt(minutes) {
    const level = fixture('level-236');
    const now = federationAfter(minutes);
    for (const tab of level.levelTabs.slice(1, 3)) {
      for (const m of tab.childLevels[0].matches) {
        if (m.id !== MATCH_ID) continue;
        m.state = now.state;
        m.homeParticipantResult = now.homeParticipantResult;
        m.visitingParticipantResult = now.visitingParticipantResult;
      }
    }
    return levelHtml(level);
  }

  function setUp(startIso, { store = new MemoryStore() } = {}) {
    const time = clock(startIso);
    const matches = {};
    for (const id of [90785, 90843, 90910]) matches[id] = matchHtml(detailOf(id));
    matches[MATCH_ID] = () => matchHtml(detailOf(MATCH_ID, federationAfter(time.minutes())));
    const client = new FakeClient({ levels: { '236/258': () => levelAt(time.minutes()) }, matches });
    return { time, store, client };
  }

  const run = (env, extra = {}) =>
    runDaemon({ client: env.client, store: env.store, now: env.time.now, sleep: env.time.sleep, competitions: [competition], ...extra });

  test('waits for the match, follows it, does the everyday pass in between, and ends when the match is over', async () => {
    const env = setUp('2026-10-24T10:20:00Z');

    const summary = await run(env);

    assert.deepEqual(summary.baselineErrors, []);
    assert.equal(summary.continueNeeded, false);
    assert.ok(summary.baselines >= 3, `${summary.baselines} everyday passes`);
    assert.ok(summary.polls > 60);
    assert.equal(summary.finished, 1);
    const doc = env.store.matches.get(ID);
    assert.equal(doc.live, false);
    assert.equal(doc.homeScore, 23);
    assert.equal(doc.details.events.length, 23);
    // The everyday pass seeing a match in progress does not end or spoil it.
    assert.ok(env.time.minutes() <= 71, `stopped at ${env.time.minutes()}`);
    // It did not start following before the kickoff minus ten minutes.
    const firstPoll = env.client.requests.indexOf(`match ${MATCH_ID}`);
    assert.ok(firstPoll >= 0);
  });

  test('keeps its place all day: the first run that starts is enough', async () => {
    // Nothing started the run for hours (the timer is unreliable); it starts 3 hours before the match.
    const env = setUp('2026-10-24T08:00:00Z');
    const summary = await run(env);
    assert.equal(summary.finished, 1);
    assert.equal(env.store.matches.get(ID).live, false);
    assert.ok(summary.baselines >= 4);
  });

  test('a day with no match more than ends at once', async () => {
    const quiet = new MemoryStore({
      matches: [{ id: ID, doc: buildMatchDoc({ competition, leagueName: 'x', id: ID, raw: rawById(MATCH_ID), now: new Date('2026-10-23T09:00:00Z') }) }],
    });
    const env = setUp('2026-10-23T09:07:00Z', { store: quiet }); // 11:07 on Friday: not the sixth hour, no match today or yesterday
    const summary = await run(env);
    assert.equal(summary.baselines, 0);
    assert.deepEqual(env.client.requests, []);
    assert.equal(summary.continueNeeded, false);
  });

  test('when the run runs out of time with the match day still going, it says another run is needed', async () => {
    const env = setUp('2026-10-24T08:00:00Z');
    const summary = await run(env, { maxMinutes: 60 });
    assert.equal(summary.continueNeeded, true);
    assert.equal(summary.finished, 0);
  });

  test('a match day whose match has not been played (wrong date on the site) does not keep the run for ever', async () => {
    const time = clock('2026-10-24T10:30:00Z');
    const client = new FakeClient({
      levels: { '236/258': () => levelHtml() },
      matches: { 90785: matchHtml(detailOf(90785)), 90843: matchHtml(detailOf(90843)), 90910: matchHtml(detailOf(90910)), [MATCH_ID]: () => matchHtml(detailOf(MATCH_ID, { state: 'Finished', homeParticipantResult: null, visitingParticipantResult: null, matchEvents: [] })) },
    });
    const summary = await runDaemon({ client, store: new MemoryStore(), now: time.now, sleep: time.sleep, competitions: [competition] });
    // It follows the match for the window after its kickoff and then lets the day go.
    assert.equal(summary.continueNeeded, false);
    assert.ok(time.minutes() <= 150 + 11, `stopped at ${time.minutes()}`);
  });
});