import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildDetails,
  DETAILS_VERSION,
  buildMatchDoc,
  buildStandingsDoc,
  makeLogoFinder,
  matchKind,
  needsDetail,
  ourMatches,
  sameDoc,
  tidy,
} from '../src/convert.js';
import { parseLevelPage, parseMatchPage } from '../src/parse.js';
import { clone, competition, fixture, levelHtml, matchHtml } from './helpers.js';

const level = () => parseLevelPage(levelHtml());
const finished = () => parseMatchPage(matchHtml(fixture('match-finished')));
const byId = (page, id) => page.matches.find((m) => m.id === id);

describe('reading the pages', () => {
  test('a competition page gives the league, all matches and the table', () => {
    const page = level();
    assert.equal(page.leagueName, '1. liga st.dorastenci');
    assert.equal(page.matches.length, 8); // 4 played + 4 upcoming in the fixture
    assert.equal(page.standings.length, 6);
    assert.deepEqual(page.standings[4], {
      position: 5,
      teamId: 6569,
      team: 'HC Sporta Hlohovec / HŠK Legends Šaľa',
      logoUrl: page.standings[4].logoUrl,
      played: 7,
      points: 8,
      goalsFor: 235,
      goalsAgainst: 207,
    });
    assert.match(page.standings[0].logoUrl, /^https:\/\/cdn\.handball\.eliterro\.sk\//);
  });

  test('a page without matches and table is reported as a changed site', () => {
    assert.throws(() => parseLevelPage('<html>nič</html>'));
    assert.throws(() => parseLevelPage(levelHtml({ unrelated: true })), /zväz asi zmenil web/);
  });

  test('a match page gives the whole match', () => {
    const detail = finished();
    assert.equal(detail.id, 90785);
    assert.equal(detail.state, 'Finished');
    assert.throws(() => parseMatchPage(matchHtml({ nothing: 1 }).replace('matchDetail', 'other')), /zväz asi zmenil web/);
  });
});

describe('which matches are ours, and their ids', () => {
  test('only the matches of our team, with the id the app already uses', () => {
    const matches = ourMatches(competition, level().matches);
    assert.deepEqual(
      matches.map((m) => m.id),
      ['szh-starsiDorastenci-k5', 'szh-starsiDorastenci-k6', 'szh-starsiDorastenci-k7', 'szh-starsiDorastenci-k8', 'szh-starsiDorastenci-k9', 'szh-starsiDorastenci-k10'],
    );
    assert.equal(matches.length, 6); // the two other teams' matches are left out
  });

  test('a second match of the same round gets a number after it', () => {
    const page = level();
    const second = clone(byId(page, 90748));
    second.id = 99999;
    second.dateFrom = '2026-10-25T10:00:00Z';
    second.visitingParticipant = { ...second.visitingParticipant };
    const matches = ourMatches(competition, [...page.matches, { ...second, homeParticipant: { ...second.homeParticipant, id: 1234 } }]);
    const ids = matches.map((m) => m.id);
    assert.ok(ids.includes('szh-starsiDorastenci-k8'));
    assert.ok(ids.includes('szh-starsiDorastenci-k8-2'));
  });

  test('a round off ("Voľno") is not a match', () => {
    const page = level();
    const bye = clone(byId(page, 90748));
    bye.id = 5;
    bye.homeParticipant.name = 'Voľno';
    assert.equal(ourMatches(competition, [bye]).length, 0);
  });

  test('the same fixture listed twice is one match: the one with the result, with the known time', () => {
    const page = level();
    const base = byId(page, 90785);
    const withTime = { ...clone(base), id: 100, homeParticipantResult: null, visitingParticipantResult: null, state: 'Finished', dateFrom: '2026-10-17T08:00:00Z', showTime: true };
    const withResult = { ...clone(base), id: 101, dateFrom: '2026-10-16T22:00:00Z', showTime: false };
    const matches = ourMatches(competition, [withTime, withResult]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].raw.id, 101); // the one with the result keeps its own page
    assert.equal(matches[0].raw.showTime, true);
    assert.equal(matches[0].raw.dateFrom, '2026-10-17T08:00:00Z'); // and takes the kickoff time
  });

  test('identical placeholders of the future collapse into one', () => {
    const page = level();
    const base = byId(page, 90694);
    const copies = [201, 202, 203].map((id) => ({ ...clone(base), id }));
    const matches = ourMatches(competition, copies);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].raw.id, 201);
  });

  test('different opponents on the same day stay separate', () => {
    const page = level();
    const a = { ...clone(byId(page, 90694)), id: 301 };
    const b = clone(a);
    b.id = 302;
    b.visitingParticipant = { ...b.visitingParticipant, id: 4242, name: 'Iný tím' };
    assert.equal(ourMatches(competition, [a, b]).length, 2);
  });
});

describe('the match as the app stores it', () => {
  const page = level();
  const build = (raw, extra = {}) => buildMatchDoc({ competition, leagueName: page.leagueName, id: 'x', raw, ...extra });

  test('a played home match, from our point of view', () => {
    const doc = build(byId(page, 90785), { detail: finished() });
    assert.equal(doc.category, 'starsiDorastenci');
    assert.equal(doc.homeTeam, 'Legends Šaľa');
    assert.equal(doc.awayTeam, 'HáO TJ Slovan Modra');
    assert.equal(doc.homeScore, 49);
    assert.equal(doc.awayScore, 35);
    assert.equal(doc.competition, '1. liga · 7. kolo');
    assert.equal(doc.dateTime.toISOString(), '2026-10-17T12:00:00.000Z');
    assert.equal(doc.timeUnknown, false);
    assert.equal(doc.live, false);
    assert.equal(doc.szhId, 90785);
    assert.equal(doc.venue, '');
    assert.match(doc.opponentLogoUrl, /cdn\.handball\.eliterro\.sk/);
    assert.equal(doc.details.hasFullRoster, true);
  });

  test('an away match puts our team second', () => {
    const doc = build(byId(page, 90843));
    assert.equal(doc.homeTeam, 'SMF HK Žilina');
    assert.equal(doc.awayTeam, 'Legends Šaľa');
    assert.equal(doc.homeScore, 26);
    assert.equal(doc.awayScore, 38);
  });

  test('an upcoming match has no scores and no details', () => {
    const doc = build(byId(page, 90748));
    assert.equal(doc.homeScore, null);
    assert.equal(doc.awayScore, null);
    assert.equal(doc.details, null);
    assert.equal(doc.live, false);
    assert.equal(doc.homeTeam, 'Tatran Prešov');
  });

  test('a match without a set time shows the day only', () => {
    const doc = build(byId(page, 90694)); // 2026-10-30T23:00Z = 31 October, 00:00 in Slovakia
    assert.equal(doc.timeUnknown, true);
    assert.equal(doc.dateTime.toISOString(), '2026-10-30T23:00:00.000Z');
  });

  test('a time an admin set stays while the federation has none', () => {
    const existing = { ...build(byId(page, 90694)), timeUnknown: false, dateTime: new Date('2026-10-31T09:00:00Z'), venue: 'Šaľa, ZŠ' };
    const doc = build(byId(page, 90694), { existing });
    assert.equal(doc.timeUnknown, false);
    assert.equal(doc.dateTime.toISOString(), '2026-10-31T09:00:00.000Z');
    assert.equal(doc.venue, 'Šaľa, ZŠ');
  });

  test('a time the federation does set replaces the admin one', () => {
    const raw = clone(byId(page, 90694));
    raw.showTime = true;
    raw.dateFrom = '2026-10-31T10:30:00Z';
    const existing = { ...build(byId(page, 90694)), timeUnknown: false, dateTime: new Date('2026-10-31T09:00:00Z') };
    const doc = build(raw, { existing });
    assert.equal(doc.dateTime.toISOString(), '2026-10-31T10:30:00.000Z');
  });

  test('an admin time on another day is not kept', () => {
    const existing = { ...build(byId(page, 90694)), timeUnknown: false, dateTime: new Date('2026-11-07T09:00:00Z') };
    const doc = build(byId(page, 90694), { existing });
    assert.equal(doc.timeUnknown, true);
  });

  test('the venue an admin typed is always kept', () => {
    const existing = { ...build(byId(page, 90785)), venue: 'Hlohovec' };
    assert.equal(build(byId(page, 90785), { existing }).venue, 'Hlohovec');
  });

  test('details stay when the match page is not downloaded again', () => {
    const first = build(byId(page, 90785), { detail: finished() });
    const again = build(byId(page, 90785), { existing: first });
    assert.deepEqual(again.details, first.details);
  });

  test('the logo of the same opponent is kept if the federation lists none', () => {
    const first = build(byId(page, 90785));
    const raw = clone(byId(page, 90785));
    raw.visitingParticipant.logoEntity = null;
    assert.equal(build(raw, { existing: first }).opponentLogoUrl, first.opponentLogoUrl);
    // ...but not the one of another opponent.
    raw.visitingParticipant.name = 'Iný tím';
    assert.equal(build(raw, { existing: first }).opponentLogoUrl, null);
  });

  test('a finished match without a result is shown as not played, with no details', () => {
    const raw = clone(byId(page, 90785));
    raw.homeParticipantResult = null;
    raw.visitingParticipantResult = null;
    const doc = build(raw, { detail: raw });
    assert.equal(doc.homeScore, null);
    assert.equal(doc.details, null);
  });

  test('a match being played is marked live, with the score so far', () => {
    const raw = clone(finished());
    raw.state = 'InProgress';
    raw.homeParticipantResult = '12';
    raw.visitingParticipantResult = '10';
    const doc = build(raw, { detail: raw });
    assert.equal(doc.live, true);
    assert.equal(doc.homeScore, 12);
    assert.equal(doc.awayScore, 10);
    assert.ok(doc.details.homePlayers.length > 0);
    assert.equal(matchKind(raw), 'live');
  });

  test('names are tidied', () => {
    assert.equal(tidy('MHC ŠTART  Nové Zámky '), 'MHC ŠTART Nové Zámky');
    assert.equal(tidy(null), '');
  });
});

describe('details of a played match', () => {
  test('halftime, referees and players', () => {
    const details = buildDetails(finished());
    assert.equal(details.homeHalftime, 25);
    assert.equal(details.awayHalftime, 16);
    assert.equal(details.referees.length, 2);
    assert.ok(details.referees.every((name) => !/\s{2}/.test(name)));
    assert.equal(details.homePlayers.length, 5);
    assert.equal(details.awayPlayers.length, 4);
    assert.equal(details.hasFullRoster, true);
    assert.equal(details.importVersion, DETAILS_VERSION);

    const top = details.homePlayers.find((p) => p.goals === 11);
    assert.equal(top.number !== null, true);
    assert.equal(top.twoMinutes, 0);
  });

  test('referees are only the two referees, the first one first', () => {
    const detail = clone(finished());
    detail.people = [
      { type: 'organizer', firstName: 'Ona', lastName: 'ORGANIZÁTOR' },
      { type: 'referee2', firstName: 'Druhý', lastName: 'ROZHODCA' },
      { type: 'referee1', firstName: 'Prvý', lastName: 'ROZHODCA' },
    ];
    assert.deepEqual(buildDetails(detail).referees, ['Prvý ROZHODCA', 'Druhý ROZHODCA']);
  });

  test('no halftime when the site has it for one team only', () => {
    const detail = clone(finished());
    detail.resultData = detail.resultData.filter((r) => !(r.participantId === detail.visitingParticipant.id && r.matchPart === 1));
    const details = buildDetails(detail);
    assert.equal(details.homeHalftime, null);
    assert.equal(details.awayHalftime, null);
  });

  test('sanctions are counted from the events when the roster statistics are empty', () => {
    const detail = clone(finished());
    const athlete = detail.homeParticipantLineup[0];
    athlete.matchStatistics = athlete.matchStatistics.map((s) => ({ ...s, value: '0' }));
    const mk = (eventType, description) => ({ eventType, description, athlete: { id: athlete.id } });
    detail.matchEvents = [mk('penalty', '2M'), mk('penalty', '2M'), mk('yellow-card', 'N'), mk('red-card', 'CK'), mk('goal', 's1'), mk('goal-penalty', 'ps1')];
    const player = buildDetails(detail).homePlayers[0];
    assert.equal(player.twoMinutes, 2);
    assert.equal(player.yellowCards, 1);
    assert.equal(player.redCards, 1);
    assert.equal(player.goals, 2);
  });

  test('the larger of the roster statistic and the events is taken', () => {
    const detail = clone(finished());
    const athlete = detail.homeParticipantLineup[0]; // 2 goals and one 2-minute in the roster
    detail.matchEvents = [{ eventType: 'goal', athlete: { id: athlete.id } }];
    const player = buildDetails(detail).homePlayers[0];
    assert.equal(player.goals, 2);
    assert.equal(player.twoMinutes, 1);
  });

  test('disqualifications count as red cards', () => {
    const detail = clone(finished());
    const athlete = detail.homeParticipantLineup[1];
    athlete.matchStatistics = athlete.matchStatistics.map((s) => (s.name === 'penalty-d' ? { ...s, value: '1' } : s.name === 'penalty-dt' ? { ...s, value: '1' } : s));
    assert.equal(buildDetails(detail).homePlayers[1].redCards, 2);
  });
});

describe('deciding what to download', () => {
  const page = level();
  const raw = byId(page, 90785);
  const stored = () => ({ homeScore: 49, awayScore: 35, live: false, details: { hasFullRoster: true, importVersion: DETAILS_VERSION } });

  test('an upcoming match needs nothing', () => {
    assert.equal(needsDetail(byId(page, 90748), null), false);
  });

  test('a played match we do not have yet needs its page', () => {
    assert.equal(needsDetail(raw, null), true);
    assert.equal(needsDetail(raw, { ...stored(), details: null }), true);
  });

  test('a played match we have with the same result needs nothing', () => {
    assert.equal(needsDetail(raw, stored()), false);
  });

  test('a changed result, an old-style roster or a match marked live need the page again', () => {
    assert.equal(needsDetail(raw, { ...stored(), homeScore: 48 }), true);
    assert.equal(needsDetail(raw, { ...stored(), details: { hasFullRoster: false, importVersion: DETAILS_VERSION } }), true);
    // Details written by an earlier importer are read once more.
    assert.equal(needsDetail(raw, { ...stored(), details: { hasFullRoster: true } }), true);
    assert.equal(needsDetail(raw, { ...stored(), details: { hasFullRoster: true, importVersion: DETAILS_VERSION - 1 } }), true);
    assert.equal(needsDetail(raw, { ...stored(), live: true }), true);
  });

  test('a finished match without a result is never downloaded', () => {
    const empty = clone(raw);
    empty.homeParticipantResult = null;
    empty.visitingParticipantResult = null;
    assert.equal(needsDetail(empty, null), false);
  });

  test('a match in progress is always downloaded', () => {
    assert.equal(needsDetail({ ...raw, state: 'InProgress' }, stored()), true);
  });
});

describe('league tables', () => {
  const now = new Date('2026-10-23T10:00:00Z');

  test('rows in order, ours marked, names tidied', () => {
    const doc = buildStandingsDoc({ competition, rows: level().standings, now });
    assert.equal(doc.category, 'starsiDorastenci');
    assert.equal(doc.updatedAt, now);
    assert.equal(doc.rows.length, 6);
    assert.deepEqual(doc.rows.map((r) => r.position), [1, 2, 3, 4, 5, 6]);
    assert.equal(doc.rows[0].team, 'MHC ŠTART Nové Zámky');
    assert.deepEqual(doc.rows.filter((r) => r.isOurs).map((r) => r.position), [5]);
  });

  test('rows with missing numbers are left out', () => {
    const rows = clone(level().standings);
    rows[1].points = null;
    assert.equal(buildStandingsDoc({ competition, rows, now }).rows.length, 5);
  });

  test('no rows before the season starts', () => {
    assert.deepEqual(buildStandingsDoc({ competition, rows: [], now }).rows, []);
  });
});

describe('comparing documents', () => {
  test('equal by value, dates as instants, key order does not matter', () => {
    const a = { x: 1, when: new Date('2026-10-17T12:00:00Z'), nested: { b: [1, 2], a: null } };
    const b = { nested: { a: null, b: [1, 2] }, when: new Date('2026-10-17T12:00:00Z'), x: 1 };
    assert.equal(sameDoc(a, b), true);
    assert.equal(sameDoc(a, { ...b, x: 2 }), false);
    assert.equal(sameDoc(a, { ...b, when: new Date('2026-10-17T12:00:01Z') }), false);
  });

  test('a missing value and an undefined one are the same', () => {
    assert.equal(sameDoc({ a: 1 }, { a: 1, b: undefined }), true);
  });
});

describe('logos', () => {
  const known = [
    ['MHK Piešťany A', 'https://cdn/piestany-a.webp'],
    ['HK AGRO Topoľčany', 'https://cdn/agro.webp'],
    ['MHC ŠTART  Nové Zámky A', 'https://cdn/start.webp'],
  ];

  test('the page gives every logo address, from the matches and from the table', () => {
    const logos = level().logos;
    assert.ok(logos.length > 8);
    assert.ok(logos.every(([name, url]) => name && /^https:\/\/cdn\.handball\.eliterro\.sk\//.test(url)));
    assert.ok(logos.some(([name]) => name === 'HáO TJ Slovan Modra'));
  });

  test('a team is found by its name, whatever the capitals and spaces', () => {
    const find = makeLogoFinder(known);
    assert.equal(find('hk agro  topoľčany'), 'https://cdn/agro.webp');
    assert.equal(find('MHC ŠTART Nové Zámky A'), 'https://cdn/start.webp');
  });

  test('a club\'s second team and its plain name use the logo of the club\'s other team', () => {
    const find = makeLogoFinder(known);
    assert.equal(find('MHK Piešťany B'), 'https://cdn/piestany-a.webp');
    assert.equal(find('MHK Piešťany'), 'https://cdn/piestany-a.webp');
    assert.equal(find('MHC ŠTART Nové Zámky B'), 'https://cdn/start.webp');
  });

  test('a letter in the middle of a name is not a second-team mark', () => {
    const find = makeLogoFinder([['SMF HK Žilina', 'https://cdn/zilina.webp']]);
    assert.equal(find('SMF HK Žilina'), 'https://cdn/zilina.webp');
    assert.equal(find('SMF HK'), null);
  });

  test('the logo the app already has is the last resort', () => {
    const find = makeLogoFinder(known, [['TJ Sokol Cífer', 'https://old/cifer.png'], ['MHK Piešťany B', 'https://old/other.png']]);
    assert.equal(find('TJ Sokol Cífer'), 'https://old/cifer.png');
    // what the federation gives wins over what was stored
    assert.equal(find('MHK Piešťany B'), 'https://cdn/piestany-a.webp');
  });

  test('a team nobody has a logo for gets none', () => {
    assert.equal(makeLogoFinder(known)('HBC Trnava'), null);
    assert.equal(makeLogoFinder([])('anything'), null);
  });

  test('the table and the matches take the found logo only when the team has none', () => {
    const find = (name) => (name === 'Tatran Prešov' ? 'https://found/tatran.webp' : null);
    const rows = clone(level().standings);
    rows[2].logoUrl = null; // Tatran Prešov in the fixture
    rows[1].logoUrl = null; // another team, nothing to find
    const doc = buildStandingsDoc({ competition, rows, now: new Date(), findLogo: find });
    assert.equal(doc.rows[2].logoUrl, 'https://found/tatran.webp');
    assert.equal(doc.rows[1].logoUrl, null);
    assert.match(doc.rows[0].logoUrl, /cdn\.handball\.eliterro\.sk/); // its own stays

    const raw = clone(byId(level(), 90748)); // Tatran Prešov at home against us
    raw.homeParticipant.logoEntity = null;
    const match = buildMatchDoc({ competition, leagueName: 'x', id: 'x', raw, findLogo: find });
    assert.equal(match.opponentLogoUrl, 'https://found/tatran.webp');
  });
});