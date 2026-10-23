import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SiteClient, SiteError } from '../src/http.js';
import { extractFlight, findByKey, FormatError } from '../src/flight.js';
import { slovakDay, slovakHour, slovakMidnight } from '../src/time.js';
import { flightPage } from './helpers.js';

describe('Slovak time', () => {
  test('the day is the Slovak day, not the UTC one', () => {
    // 22:30 UTC on 17 October is already 00:30 on the 18th in Slovakia (summer time).
    assert.equal(slovakDay(new Date('2026-10-17T22:30:00Z')), '2026-10-18');
    assert.equal(slovakDay(new Date('2026-10-17T12:00:00Z')), '2026-10-17');
    // In winter the offset is one hour.
    assert.equal(slovakDay(new Date('2026-12-17T22:30:00Z')), '2026-12-17');
    assert.equal(slovakDay(new Date('2026-12-17T23:30:00Z')), '2026-12-18');
  });

  test('midnight is 22:00 UTC the evening before in summer and 23:00 in winter', () => {
    assert.equal(slovakMidnight(new Date('2026-10-18T10:00:00Z')).toISOString(), '2026-10-17T22:00:00.000Z');
    assert.equal(slovakMidnight(new Date('2026-12-18T10:00:00Z')).toISOString(), '2026-12-17T23:00:00.000Z');
    // The nights the clocks change (25 October 2026 and 28 March 2027).
    assert.equal(slovakMidnight(new Date('2026-10-25T12:00:00Z')).toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(slovakMidnight(new Date('2027-03-28T12:00:00Z')).toISOString(), '2027-03-27T23:00:00.000Z');
  });

  test('the hour is the Slovak hour', () => {
    assert.equal(slovakHour(new Date('2026-10-17T12:00:00Z')), 14);
    assert.equal(slovakHour(new Date('2026-12-17T12:00:00Z')), 13);
    assert.equal(slovakHour(new Date('2026-10-17T22:00:00Z')), 0);
  });
});

describe('the data inside a page', () => {
  test('lines of the page data are read, whatever else is in them', () => {
    const html = flightPage({ matchDetail: { id: 5, homeParticipant: {} } });
    const flight = extractFlight(html);
    assert.deepEqual(flight['1'], { matchDetail: { id: 5, homeParticipant: {} } });
  });

  test('data split over several pieces is joined first', () => {
    const line = '7:{"a":{"b":[1,2,3]}}\n';
    const half = Math.floor(line.length / 2);
    const html =
      `<script>self.__next_f.push([1,${JSON.stringify(line.slice(0, half))}])</script>` +
      `<script>self.__next_f.push([1,${JSON.stringify(line.slice(half))}])</script>`;
    assert.deepEqual(extractFlight(html)['7'], { a: { b: [1, 2, 3] } });
  });

  test('lines that are not JSON are skipped', () => {
    const text = '0:["$","div"]\nc:I[123,["x.js"],"Y"]\n9:{"ok":true}\n';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(text)}])</script>`;
    const flight = extractFlight(html);
    assert.deepEqual(flight['9'], { ok: true });
    assert.equal(flight.c, undefined);
  });

  test('a page without data is reported as a changed site', () => {
    assert.throws(() => extractFlight('<html>nič</html>'), FormatError);
  });

  test('findByKey finds the object that holds the key, deep inside', () => {
    const tree = { a: [{ b: { levelTabs: [1, 2], league: 'x' } }] };
    assert.deepEqual(findByKey(tree, 'levelTabs', Array.isArray), tree.a[0].b);
    assert.equal(findByKey(tree, 'missing'), null);
    assert.equal(findByKey({ levelTabs: 'text' }, 'levelTabs', Array.isArray), null);
  });
});

describe('the site client', () => {
  const okPage = (text = '<html></html>') => ({ ok: true, status: 200, text: async () => text });

  function makeClient(responses, extra = {}) {
    const calls = [];
    const sleeps = [];
    let time = 0;
    const client = new SiteClient({
      pauseMs: 1500,
      retries: 2,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      now: () => time,
      ...extra,
    });
    return { client, calls, sleeps };
  }

  test('asks for the right addresses, naming itself', async () => {
    const { client, calls } = makeClient([okPage('A'), okPage('B')]);
    assert.equal(await client.levelPage(236, 258), 'A');
    assert.equal(await client.matchPage(90785), 'B');
    assert.equal(calls[0].url, 'https://slovakhandball.sk/levels/236/258');
    assert.equal(calls[1].url, 'https://slovakhandball.sk/matches/90785');
    assert.match(calls[0].options.headers['User-Agent'], /LegendsSalaSync/);
  });

  test('pauses between requests', async () => {
    const { client, sleeps } = makeClient([okPage(), okPage(), okPage()]);
    await client.matchPage(1);
    await client.matchPage(2);
    await client.matchPage(3);
    // Nothing before the first; about the pause before each later one.
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every((ms) => ms > 0 && ms <= 1500));
  });

  test('a server error is tried again, then gives up with a message', async () => {
    const bad = { ok: false, status: 503, text: async () => '' };
    const { client, calls } = makeClient([bad, bad, bad]);
    await assert.rejects(() => client.matchPage(1), /503/);
    assert.equal(calls.length, 3);
  });

  test('a failed attempt followed by a good one works', async () => {
    const bad = { ok: false, status: 502, text: async () => '' };
    const { client, calls } = makeClient([bad, okPage('fine')]);
    assert.equal(await client.matchPage(1), 'fine');
    assert.equal(calls.length, 2);
  });

  test('a network error is tried again too', async () => {
    const { client } = makeClient([new Error('connection reset'), okPage('fine')]);
    assert.equal(await client.matchPage(1), 'fine');
  });

  test('a missing page (404) is reported at once, not retried', async () => {
    const { client, calls } = makeClient([{ ok: false, status: 404, text: async () => '' }]);
    await assert.rejects(() => client.levelPage(1, 2), (error) => error instanceof SiteError && /404/.test(error.message));
    assert.equal(calls.length, 1);
  });

  test('counts requests and bytes', async () => {
    const { client } = makeClient([okPage('12345'), okPage('123')]);
    await client.matchPage(1);
    await client.matchPage(2);
    assert.equal(client.requests, 2);
    assert.equal(client.bytes, 8);
  });
});
