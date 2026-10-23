import { extractFlight, findByKey, FormatError } from './flight.js';

/**
 * A competition page (`/levels/<level>/<stage>`): the league's name, every match
 * of the competition (played and upcoming) and the league table.
 */
export function parseLevelPage(html) {
  const flight = extractFlight(html);
  const holder = Object.values(flight)
    .map((value) => findByKey(value, 'levelTabs', Array.isArray))
    .find(Boolean);
  if (!holder) throw new FormatError('Na stránke súťaže chýbajú zápasy a tabuľka (zväz asi zmenil web).');

  const tab = (name) => holder.levelTabs.find((t) => t.name === name);
  const matchesOf = (name) => (tab(name)?.childLevels ?? []).flatMap((c) => c.matches ?? []);
  const scoreboards = (tab('standings')?.childLevels ?? []).flatMap((c) => c.scoreboards ?? []);

  const matches = [...matchesOf('results'), ...matchesOf('upcoming')];
  const standings = scoreboards.map(readScoreboardRow);

  // Every logo address the page gives, by team name. A team's table row sometimes
  // has none while its matches do (and the other way round).
  const logos = [];
  for (const match of matches) {
    for (const team of [match.homeParticipant, match.visitingParticipant]) {
      if (team?.name && team.logoEntity?.url) logos.push([team.name, team.logoEntity.url]);
    }
  }
  for (const row of standings) {
    if (row.team && row.logoUrl) logos.push([row.team, row.logoUrl]);
  }

  return { leagueName: holder.league?.name ?? '', matches, standings, logos };
}

function readScoreboardRow(row) {
  const team = row.participants?.[0];
  const stat = (name) => {
    const found = (row.additionalData ?? []).find((d) => d.name === name);
    const number = Number(found?.value);
    return found && Number.isFinite(number) ? number : null;
  };
  return {
    position: Number(row.finalPosition),
    teamId: team?.id ?? null,
    team: team?.name ?? '',
    logoUrl: team?.logoEntity?.url ?? null,
    played: stat('matches-played'),
    points: stat('points'),
    goalsFor: stat('goals-for'),
    goalsAgainst: stat('goals-against'),
  };
}

/** A match page (`/matches/<id>`): the whole match with rosters and events. */
export function parseMatchPage(html) {
  const flight = extractFlight(html);
  const holder = Object.values(flight)
    .map((value) => findByKey(value, 'matchDetail', (v) => v && typeof v === 'object' && 'homeParticipant' in v))
    .find(Boolean);
  if (!holder) throw new FormatError('Na stránke zápasu chýbajú údaje (zväz asi zmenil web).');
  return holder.matchDetail;
}
