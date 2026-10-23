import { competitions as defaultCompetitions, LIVE_LEAD_MINUTES, LIVE_TRAIL_MINUTES, OUR_TEAM_NAME } from './config.js';
import { buildMatchDoc, buildStandingsDoc, makeLogoFinder, matchKind, needsDetail, ourMatches, sameDoc } from './convert.js';
import { parseLevelPage, parseMatchPage } from './parse.js';
import { slovakDay, slovakHour } from './time.js';

const MINUTE = 60_000;

/** A league table is written again at least this often, so its "last import" date stays recent. */
const STANDINGS_REFRESH_MS = 12 * 60 * MINUTE;

/**
 * The everyday pass: downloads each category's competition page (all its matches
 * and the table), and writes what changed. A finished match whose own page has
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
      let detail = null;
      if (needsDetail(raw, before)) {
        try {
          detail = parseMatchPage(await client.matchPage(raw.id));
        } catch (error) {
          summary.warnings.push(`${competition.category}: detail zápasu ${raw.id}: ${error.message}`);
        }
      }
      const doc = buildMatchDoc({ competition, leagueName: page.leagueName, id, raw, detail, existing: before, findLogo });
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

/**
 * Follows the matches that are being played (or are about to be) and writes the
 * score, the events and the rosters every [intervalMs]. Each match is read from
 * its own page. Ends when all of them are finished, or after [maxMinutes].
 */
export async function runLive({
  client,
  store,
  matches,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  maxMinutes = 170,
  intervalMs = MINUTE,
  lookaheadMinutes = 75,
}) {
  const startedAt = now().getTime();
  const pending = liveCandidates(matches, now(), lookaheadMinutes);
  const summary = { polls: 0, writes: 0, finished: 0, errors: [] };
  let failuresInARow = 0;

  while (pending.size > 0 && now().getTime() - startedAt < maxMinutes * MINUTE) {
    const active = [...pending].filter(([, doc]) => doc.dateTime.getTime() - LIVE_LEAD_MINUTES * MINUTE <= now().getTime());

    if (active.length === 0) {
      const earliest = Math.min(...[...pending.values()].map((d) => d.dateTime.getTime() - LIVE_LEAD_MINUTES * MINUTE));
      const wait = Math.min(Math.max(earliest - now().getTime(), 1000), 5 * MINUTE);
      log(`Čakám ${Math.round(wait / 1000)} s na začiatok zápasu`);
      await sleep(wait);
      continue;
    }

    let failedThisPass = 0;
    for (const [id, doc] of active) {
      try {
        const detail = parseMatchPage(await client.matchPage(doc.szhId));
        summary.polls++;
        const competition = { category: doc.category, teamId: teamIdOf(detail, doc), competitionName: null };
        const next = buildMatchDoc({
          competition,
          leagueName: detail.level?.leagueLevel?.name ?? '',
          id,
          raw: detail,
          detail,
          existing: doc,
        });
        // The label ("1. liga · 8. kolo") stays as the everyday pass wrote it.
        next.competition = doc.competition || next.competition;

        if (!sameDoc(next, doc)) {
          await store.saveMatches([{ id, doc: next }]);
          matches.set(id, next);
          summary.writes++;
          log(`${id}: ${next.homeScore ?? '-'}:${next.awayScore ?? '-'}${next.live ? ' (naživo)' : ''}`);
        }
        if (matchKind(detail) === 'finished') {
          pending.delete(id);
          summary.finished++;
          log(`${id}: zápas skončil`);
        } else {
          pending.set(id, next);
        }
      } catch (error) {
        failedThisPass++;
        summary.errors.push(`${id}: ${error.message}`);
        log(`${id}: chyba (${error.message})`);
      }
    }

    failuresInARow = failedThisPass === active.length ? failuresInARow + 1 : 0;
    if (failuresInARow >= 10) {
      summary.errors.push('Desať kôl po sebe sa nič nepodarilo stiahnuť, končím.');
      break;
    }
    if (pending.size > 0) await sleep(intervalMs);
  }

  return summary;
}

/** Our team's id in a match: the side of the stored document that is ours. */
function teamIdOf(detail, doc) {
  const home = doc.homeTeam === OUR_TEAM_NAME;
  return home ? detail.homeParticipant.id : detail.visitingParticipant.id;
}
