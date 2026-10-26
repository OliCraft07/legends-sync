import {
  competitions as defaultCompetitions,
  LIVE_LEAD_MINUTES,
  LIVE_TRAIL_MINUTES,
  MIN_PLAYED_MINUTES,
  OUR_TEAM_NAME,
  OVER_AFTER_MINUTES,
  QUIET_MINUTES,
} from './config.js';
import { buildMatchDoc, buildStandingsDoc, hasMatchData, makeLogoFinder, needsDetail, ourMatches, sameDoc } from './convert.js';
import { parseLevelPage, parseMatchPage } from './parse.js';
import { slovakDay, slovakHour } from './time.js';

const MINUTE = 60_000;

/** A league table is written again at least this often, so its "last import" date stays recent. */
const STANDINGS_REFRESH_MS = 12 * 60 * MINUTE;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The everyday pass: downloads each category's competition page (all its matches
 * and the table), and writes what changed. A played match whose own page has
 * not been read yet (or whose result changed) has that page downloaded too, for
 * the rosters, goals, sanctions and referees.
 *
 * Returns the matches as they are in the database afterwards, and a summary.
 */
export async function runBaseline({ client, store, now = () => new Date(), log = () => {}, competitions = defaultCompetitions }) {
  const existing = await store.loadMatches();
  const existingStandings = await store.loadStandings();
  const summary = { added: 0, updated: 0, unchanged: 0, standingsWritten: 0, warnings: [], errors: [] };
  const matchWrites = [];
  const standingsWrites = [];

  // First every competition is read, because a team without a logo in one category
  // may have it in another.
  const pages = [];
  for (const competition of competitions) {
    log(`Kategória ${competition.category}: sťahujem súťaž ${competition.level}/${competition.stage}`);
    try {
      pages.push({ competition, page: parseLevelPage(await client.levelPage(competition.level, competition.stage)) });
    } catch (error) {
      summary.errors.push(`${competition.category}: ${error.message}`);
    }
  }

  const storedLogos = [...existing.values()].map((doc) => [
    doc.homeTeam === OUR_TEAM_NAME ? doc.awayTeam : doc.homeTeam,
    doc.opponentLogoUrl,
  ]);
  const findLogo = makeLogoFinder(pages.flatMap(({ page }) => page.logos), storedLogos);

  for (const { competition, page } of pages) {
    const ours = ourMatches(competition, page.matches);
    if (ours.length === 0) {
      summary.warnings.push(`${competition.category}: nenašli sa žiadne zápasy nášho tímu (číslo tímu ${competition.teamId} v config.js?)`);
    }

    for (const { id, raw } of ours) {
      const before = existing.get(id) ?? null;
      const at = now();
      let detail = null;
      if (needsDetail(raw, before, at)) {
        try {
          detail = parseMatchPage(await client.matchPage(raw.id));
        } catch (error) {
          summary.warnings.push(`${competition.category}: detail zápasu ${raw.id}: ${error.message}`);
        }
      }
      const doc = buildMatchDoc({ competition, leagueName: page.leagueName, id, raw, detail, existing: before, findLogo, now: at });
      if (!before) {
        summary.added++;
      } else if (!sameDoc(doc, before)) {
        summary.updated++;
      } else {
        summary.unchanged++;
        continue;
      }
      matchWrites.push({ id, doc });
      existing.set(id, doc);
    }

    // Matches of the federation that are in the database but no longer on its page
    // (a fixture it dropped or merged). They are never deleted; an admin can.
    if (ours.length > 0) {
      const current = new Set(ours.map((m) => m.id));
      const gone = [...existing.keys()].filter((id) => id.startsWith(`szh-${competition.category}-`) && !current.has(id));
      if (gone.length > 0) {
        summary.warnings.push(`${competition.category}: ${gone.length} zápasov v databáze zväz už nelistuje (${gone.slice(0, 8).join(', ')}); možno ich zmazať v správcovi.`);
      }
    }

    const table = buildStandingsDoc({ competition, rows: page.standings, now: now(), findLogo });
    if (table.rows.length > 0) {
      const before = existingStandings.get(competition.category);
      const stale = !before || now() - before.updatedAt > STANDINGS_REFRESH_MS;
      if (stale || !sameDoc(table.rows, before.rows)) {
        standingsWrites.push({ id: competition.category, doc: table });
        summary.standingsWritten++;
      }
    }
  }

  if (matchWrites.length) await store.saveMatches(matchWrites);
  if (standingsWrites.length) await store.saveStandings(standingsWrites);

  return { matches: existing, summary };
}

/** Whether the everyday pass is due: on match days (and the day after, when results arrive late), every 6th hour otherwise, and always on an empty database. */
export function baselineDue(matches, at) {
  if (matches.size === 0) return true;
  if (slovakHour(at) % 6 === 0) return true;
  const today = slovakDay(at);
  const yesterday = slovakDay(new Date(at.getTime() - 24 * 60 * MINUTE));
  for (const doc of matches.values()) {
    const day = slovakDay(doc.dateTime);
    if (day === today || day === yesterday) return true;
  }
  return false;
}

function isDone(doc) {
  return doc.live !== true && doc.homeScore !== null && doc.awayScore !== null && !!doc.details;
}

/** The matches to follow live: kickoff from `LIVE_TRAIL_MINUTES` ago to [lookaheadMinutes] ahead, not yet finished. */
export function liveCandidates(matches, at, lookaheadMinutes = 75) {
  const result = new Map();
  for (const [id, doc] of matches) {
    if (doc.timeUnknown || !doc.szhId) continue;
    const kickoff = doc.dateTime.getTime();
    if (at.getTime() > kickoff + LIVE_TRAIL_MINUTES * MINUTE) continue;
    if (at.getTime() < kickoff - lookaheadMinutes * MINUTE) continue;
    if (isDone(doc) && at.getTime() > kickoff) continue;
    result.set(id, doc);
  }
  return result;
}

/** Whether a match is being followed right now (from a little before the kickoff). */
function isActive(doc, at) {
  return doc.dateTime.getTime() - LIVE_LEAD_MINUTES * MINUTE <= at.getTime();
}

/** Our team's id in a match: the side of the stored document that is ours. */
function teamIdOf(detail, doc) {
  const home = doc.homeTeam === OUR_TEAM_NAME;
  return home ? detail.homeParticipant.id : detail.visitingParticipant.id;
}

/**
 * Reads each of the [active] matches once from its own page and writes what changed.
 * A match has ended when something is recorded and either [OVER_AFTER_MINUTES] have
 * passed since the kickoff, or its second half has begun and nothing has happened for
 * [QUIET_MINUTES] (not before [MIN_PLAYED_MINUTES], so the half-time break cannot end it).
 * [watch] remembers, between calls, when each match last changed.
 *
 * Returns how many of the matches could not be read, and which ended.
 */
export async function liveTick({ client, store, matches, active, watch, now, log, summary }) {
  let failed = 0;
  const ended = [];

  for (const [id, doc] of active) {
    try {
      const detail = parseMatchPage(await client.matchPage(doc.szhId));
      summary.polls++;
      const at = now();

      const events = detail.matchEvents ?? [];
      const key = `${detail.homeParticipantResult}:${detail.visitingParticipantResult}/${events.length}`;
      const seen = watch.get(id) ?? { key: null, changedAt: at };
      if (seen.key !== key) {
        seen.key = key;
        seen.changedAt = at;
      }
      watch.set(id, seen);

      const elapsed = (at.getTime() - new Date(detail.dateFrom).getTime()) / MINUTE;
      const quietFor = (at.getTime() - seen.changedAt.getTime()) / MINUTE;
      const secondHalf = events.some((e) => e.matchPart >= 2);
      const over =
        hasMatchData(detail) &&
        (elapsed >= OVER_AFTER_MINUTES || (secondHalf && elapsed >= MIN_PLAYED_MINUTES && quietFor >= QUIET_MINUTES));

      const competition = { category: doc.category, teamId: teamIdOf(detail, doc), competitionName: null };
      const next = buildMatchDoc({
        competition,
        leagueName: detail.level?.leagueLevel?.name ?? '',
        id,
        raw: detail,
        detail,
        existing: doc,
        now: at,
        finished: over,
      });
      // The label ("1. liga · 8. kolo") stays as the everyday pass wrote it.
      next.competition = doc.competition || next.competition;

      log(
        `${id}: stav ${detail.state}, ${detail.homeParticipantResult ?? '-'}:${detail.visitingParticipantResult ?? '-'}, ` +
          `${events.length} udalostí, ${elapsed.toFixed(0)} min od výkopu, ticho ${quietFor.toFixed(0)} min` +
          `${over ? ' -> koniec' : ''}`,
      );

      if (!sameDoc(next, doc)) {
        await store.saveMatches([{ id, doc: next }]);
        summary.writes++;
        log(`${id}: zapísané ${next.homeScore ?? '-'}:${next.awayScore ?? '-'}${next.live ? ' (prebieha)' : ''}`);
      }
      matches.set(id, next);
      if (over) {
        ended.push(id);
        summary.finished++;
        log(`${id}: zápas skončil`);
      }
    } catch (error) {
      failed++;
      summary.errors.push(`${id}: ${error.message}`);
      log(`${id}: chyba (${error.message})`);
    }
  }

  return { failed, ended };
}

/**
 * Follows the matches that are being played (or are about to be) and writes the
 * score, the events and the rosters every [intervalMs]. Ends when all of them are
 * over, or after [maxMinutes].
 */
export async function runLive({
  client,
  store,
  matches,
  now = () => new Date(),
  sleep = defaultSleep,
  log = () => {},
  maxMinutes = 170,
  intervalMs = MINUTE,
  lookaheadMinutes = 75,
}) {
  const startedAt = now().getTime();
  const pending = liveCandidates(matches, now(), lookaheadMinutes);
  const summary = { polls: 0, writes: 0, finished: 0, errors: [] };
  const watch = new Map();
  let failuresInARow = 0;

  while (pending.size > 0 && now().getTime() - startedAt < maxMinutes * MINUTE) {
    const active = [...pending].filter(([, doc]) => isActive(doc, now()));

    if (active.length === 0) {
      const earliest = Math.min(...[...pending.values()].map((d) => d.dateTime.getTime() - LIVE_LEAD_MINUTES * MINUTE));
      const wait = Math.min(Math.max(earliest - now().getTime(), 1000), 5 * MINUTE);
      log(`Čakám ${Math.round(wait / 1000)} s na začiatok zápasu`);
      await sleep(wait);
      continue;
    }

    const { failed, ended } = await liveTick({ client, store, matches, active, watch, now, log, summary });
    for (const id of ended) pending.delete(id);
    for (const [id] of pending) pending.set(id, matches.get(id));

    failuresInARow = failed === active.length ? failuresInARow + 1 : 0;
    if (failuresInARow >= 10) {
      summary.errors.push('Desať kôl po sebe sa nič nepodarilo stiahnuť, končím.');
      break;
    }
    if (pending.size > 0) await sleep(intervalMs);
  }

  return summary;
}

/** Whether a match is still to come today, or is being played (or has just been, and its end is not written). */
function matchesLeftToday(matches, at) {
  const today = slovakDay(at);
  for (const doc of matches.values()) {
    if (doc.timeUnknown || !doc.szhId) continue;
    const kickoff = doc.dateTime.getTime();
    const ongoing = at.getTime() <= kickoff + LIVE_TRAIL_MINUTES * MINUTE && !(isDone(doc) && at.getTime() > kickoff);
    const comingToday = kickoff > at.getTime() && slovakDay(doc.dateTime) === today;
    if (comingToday || (at.getTime() >= kickoff && ongoing)) return true;
  }
  return false;
}

/**
 * The whole match day in one run: it does the everyday pass whenever it is due (at
 * most every [baselineEveryMinutes]), follows every match that is on or about to be
 * every [intervalMs], and waits in between. It ends when no match is left today, or
 * after [maxMinutes] (then `continueNeeded` is true and the caller should start another run).
 *
 * One long run, and not many short ones started by a timer, because GitHub starts timed
 * runs late or not at all: on a match day the first run that does start stays until the
 * last match is over.
 */
export async function runDaemon({
  client,
  store,
  now = () => new Date(),
  sleep = defaultSleep,
  log = () => {},
  maxMinutes = 330,
  intervalMs = MINUTE,
  baselineEveryMinutes = 45,
  competitions = defaultCompetitions,
}) {
  const startedAt = now().getTime();
  let matches = await store.loadMatches();
  const watch = new Map();
  const summary = { baselines: 0, polls: 0, writes: 0, finished: 0, errors: [], baselineErrors: [], baselinesWithErrors: 0, warnings: [], continueNeeded: false };
  let lastBaselineAt = null;
  let failuresInARow = 0;

  for (;;) {
    const at = now();

    if (baselineDue(matches, at) && (lastBaselineAt === null || at.getTime() - lastBaselineAt.getTime() >= baselineEveryMinutes * MINUTE)) {
      const result = await runBaseline({ client, store, now, log, competitions });
      matches = result.matches;
      lastBaselineAt = at;
      summary.baselines++;
      for (const warning of result.summary.warnings) {
        if (!summary.warnings.includes(warning)) summary.warnings.push(warning);
      }
      summary.baselineErrors.push(...result.summary.errors);
      if (result.summary.errors.length > 0) summary.baselinesWithErrors++;
      const s = result.summary;
      log(`Hlavné sťahovanie: ${s.added} nových, ${s.updated} zmenených, ${s.unchanged} bez zmeny; tabuľky: ${s.standingsWritten}`);
    }

    if (!matchesLeftToday(matches, now())) break;
    if (now().getTime() - startedAt >= maxMinutes * MINUTE) {
      summary.continueNeeded = true;
      break;
    }

    const active = [...liveCandidates(matches, now(), LIVE_LEAD_MINUTES)].filter(([, doc]) => isActive(doc, now()));
    if (active.length > 0) {
      const { failed } = await liveTick({ client, store, matches, active, watch, now, log, summary });
      failuresInARow = failed === active.length ? failuresInARow + 1 : 0;
      if (failuresInARow >= 10) {
        summary.errors.push('Desať kôl po sebe sa nič nepodarilo stiahnuť, končím.');
        break;
      }
      await sleep(intervalMs);
      continue;
    }

    // Nothing to follow yet: wait for the next kickoff or the next everyday pass.
    const nextKickoff = Math.min(
      Infinity,
      ...[...matches.values()]
        .filter((d) => !d.timeUnknown && d.szhId && d.dateTime.getTime() - LIVE_LEAD_MINUTES * MINUTE > now().getTime())
        .map((d) => d.dateTime.getTime() - LIVE_LEAD_MINUTES * MINUTE),
    );
    const nextBaseline = lastBaselineAt === null ? now().getTime() : lastBaselineAt.getTime() + baselineEveryMinutes * MINUTE;
    const wait = Math.min(Math.max(Math.min(nextKickoff, nextBaseline) - now().getTime(), 30_000), 5 * MINUTE);
    log(`Čakám ${Math.round(wait / 1000)} s (najbližší zápas alebo ďalšie hlavné sťahovanie)`);
    await sleep(wait);
  }

  return summary;
}
