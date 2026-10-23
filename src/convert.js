import { OUR_TEAM_NAME, STATE_FINISHED, STATE_UPCOMING } from './config.js';
import { slovakDay, slovakMidnight } from './time.js';

/** Squeezes whitespace (the site has names like "Viliam  MACKO"). */
export const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

/** 'finished', 'upcoming', or 'live' for every other state (a match in progress). */
export function matchKind(raw) {
  if (raw.state === STATE_FINISHED) return 'finished';
  if (raw.state === STATE_UPCOMING) return 'upcoming';
  return 'live';
}

export function involvesTeam(raw, teamId) {
  return raw.homeParticipant?.id === teamId || raw.visitingParticipant?.id === teamId;
}

/** A "round off" is not a match. */
function isRealMatch(raw) {
  return tidy(raw.homeParticipant?.name) !== 'Voľno' && tidy(raw.visitingParticipant?.name) !== 'Voľno';
}

/**
 * Our matches of a competition with the id each has in the app's database. The
 * id is `szh-<category>-k<round>` (kept from the earlier importer, so existing
 * matches are updated and not duplicated); a second match of the same round
 * (for example in play-offs) gets `-2`.
 */
export function ourMatches(competition, raws) {
  const ours = withoutDuplicates(raws.filter((raw) => involvesTeam(raw, competition.teamId) && isRealMatch(raw))).sort(
    (a, b) => new Date(a.dateFrom) - new Date(b.dateFrom) || a.id - b.id,
  );

  const used = new Set();
  return ours.map((raw) => {
    const round = intOrNull(raw.round);
    const base = round !== null
      ? `szh-${competition.category}-k${round}`
      : `szh-${competition.category}-${slovakDay(new Date(raw.dateFrom)).replaceAll('-', '')}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    return { id, raw };
  });
}

/**
 * The federation sometimes lists one fixture twice (the same two teams on the same
 * day: one entry with the result, another with the kickoff time, or a few identical
 * placeholders). One of them is kept: the one with a result, else the one with a
 * known time, else the first. If the kept one has no time, it takes the time of
 * another entry of the group. Its own id stays, since that page holds the details.
 */
function withoutDuplicates(raws) {
  const groups = new Map();
  for (const raw of raws) {
    const key = `${raw.homeParticipant.id}-${raw.visitingParticipant.id}-${slovakDay(new Date(raw.dateFrom))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(raw);
  }

  const hasResult = (raw) => intOrNull(raw.homeParticipantResult) !== null && intOrNull(raw.visitingParticipantResult) !== null;
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const ordered = [...group].sort((a, b) => a.id - b.id);
    const kept = ordered.find(hasResult) ?? ordered.find((r) => r.showTime !== false) ?? ordered[0];
    if (kept.showTime !== false) return kept;
    const donor = ordered.find((r) => r.showTime !== false);
    return donor ? { ...kept, dateFrom: donor.dateFrom, showTime: true } : kept;
  });
}

/**
 * Stored with every match's details. Details written by an earlier importer (or an
 * earlier version of this one) have another number, or none, and are downloaded
 * once more, so every match is read the same way.
 */
export const DETAILS_VERSION = 2;

/** Halftime, referees and the players with their goals and sanctions. */
export function buildDetails(detail) {
  const homeId = detail.homeParticipant.id;
  const awayId = detail.visitingParticipant.id;
  const half = (teamId) => {
    const entry = (detail.resultData ?? []).find(
      (r) => r.name === 'period-half' && r.matchPart === 1 && r.participantId === teamId,
    );
    return intOrNull(entry?.value);
  };
  let homeHalftime = half(homeId);
  let awayHalftime = half(awayId);
  if (homeHalftime === null || awayHalftime === null) {
    homeHalftime = null;
    awayHalftime = null;
  }

  const order = { referee1: 1, referee2: 2 };
  const referees = (detail.people ?? [])
    .filter((p) => p.type in order)
    .sort((a, b) => order[a.type] - order[b.type])
    .map((p) => tidy(`${p.firstName} ${p.lastName}`))
    .filter(Boolean);

  // The per-player statistics of the roster are sometimes left unfilled (matches
  // with two-minute suspensions but zeros there), while the event list is
  // complete. So the events are counted too and the larger number is taken.
  const fromEvents = new Map();
  for (const event of detail.matchEvents ?? []) {
    const athleteId = event.athlete?.id;
    if (athleteId === undefined) continue;
    const counts = fromEvents.get(athleteId) ?? { goals: 0, twoMinutes: 0, yellowCards: 0, redCards: 0 };
    if (event.eventType === 'goal' || event.eventType === 'goal-penalty') counts.goals++;
    if (event.eventType === 'penalty') counts.twoMinutes++;
    if (event.eventType === 'yellow-card') counts.yellowCards++;
    if (event.eventType === 'red-card') counts.redCards++;
    fromEvents.set(athleteId, counts);
  }

  const players = (lineup) =>
    (lineup ?? []).map((athlete) => {
      const stats = Object.fromEntries((athlete.matchStatistics ?? []).map((s) => [s.name, intOrNull(s.value) ?? 0]));
      const events = fromEvents.get(athlete.id) ?? { goals: 0, twoMinutes: 0, yellowCards: 0, redCards: 0 };
      const jersey = (athlete.additionalData ?? []).find((d) => d.name === 'jersey-number');
      return {
        number: intOrNull(jersey?.value),
        name: tidy(`${athlete.firstName} ${athlete.lastName}`),
        goals: Math.max(stats.goals ?? 0, events.goals),
        twoMinutes: Math.max(stats['penalty-2m'] ?? 0, events.twoMinutes),
        // "N" is a caution (the yellow card); "D" and "DT" are disqualifications (red).
        yellowCards: Math.max(stats['penalty-n'] ?? 0, events.yellowCards),
        redCards: Math.max((stats['penalty-d'] ?? 0) + (stats['penalty-dt'] ?? 0), events.redCards),
      };
    });

  return {
    homeHalftime,
    awayHalftime,
    referees,
    homePlayers: players(detail.homeParticipantLineup),
    awayPlayers: players(detail.visitingParticipantLineup),
    hasFullRoster: true,
    importVersion: DETAILS_VERSION,
  };
}

function sameLocalDay(a, b) {
  return slovakDay(a) === slovakDay(b);
}

/**
 * The match as the app stores it. [raw] is the match as the competition page
 * lists it; [detail] is its own page when that has been downloaded (it also has
 * the rosters). What the federation does not know stays as it was: the venue
 * an admin typed, and a kickoff time an admin set while the federation has none.
 */
export function buildMatchDoc({ competition, leagueName, id, raw, detail = null, existing = null }) {
  const source = detail ?? raw;
  const kind = matchKind(source);
  const homeIsOurs = source.homeParticipant.id === competition.teamId;
  const opponent = homeIsOurs ? source.visitingParticipant : source.homeParticipant;
  const opponentName = tidy(opponent.name);

  const league = competition.competitionName ?? leagueName ?? '';
  const round = intOrNull(source.round);

  const kickoff = new Date(source.dateFrom);
  let dateTime = kickoff;
  let timeUnknown = source.showTime === false;
  if (timeUnknown) {
    dateTime = slovakMidnight(kickoff);
    if (existing && existing.timeUnknown === false && sameLocalDay(existing.dateTime, kickoff)) {
      dateTime = existing.dateTime;
      timeUnknown = false;
    }
  }

  let homeScore = null;
  let awayScore = null;
  if (kind !== 'upcoming') {
    const home = intOrNull(source.homeParticipantResult);
    const away = intOrNull(source.visitingParticipantResult);
    if (home !== null && away !== null) {
      homeScore = home;
      awayScore = away;
    }
  }

  // A match that is over but has no result (the federation lists some like that) has nothing to detail.
  let details = null;
  if (kind === 'live' || (kind === 'finished' && homeScore !== null)) {
    details = detail ? buildDetails(detail) : existing?.details ?? null;
  }

  const existingOpponent = existing ? (existing.homeTeam === OUR_TEAM_NAME ? existing.awayTeam : existing.homeTeam) : null;
  const opponentLogoUrl =
    opponent.logoEntity?.url ?? (existingOpponent === opponentName ? existing?.opponentLogoUrl ?? null : null);

  return {
    category: competition.category,
    dateTime,
    timeUnknown,
    homeTeam: homeIsOurs ? OUR_TEAM_NAME : opponentName,
    awayTeam: homeIsOurs ? opponentName : OUR_TEAM_NAME,
    competition: round !== null ? `${league} · ${round}. kolo` : league,
    venue: existing?.venue ?? '',
    homeScore,
    awayScore,
    details,
    opponentLogoUrl,
    live: kind === 'live',
    szhId: source.id,
  };
}

/**
 * Whether a finished match needs its own page downloaded: nothing was stored
 * yet, or the result or the live state changed since.
 */
export function needsDetail(raw, existing) {
  if (matchKind(raw) === 'upcoming') return false;
  if (matchKind(raw) === 'finished' && intOrNull(raw.homeParticipantResult) === null) return false;
  if (!existing || !existing.details || existing.details.hasFullRoster !== true) return true;
  if (existing.details.importVersion !== DETAILS_VERSION) return true;
  if (existing.live === true) return true;
  if (matchKind(raw) === 'finished') {
    return (
      existing.homeScore !== intOrNull(raw.homeParticipantResult) ||
      existing.awayScore !== intOrNull(raw.visitingParticipantResult)
    );
  }
  return true;
}

/** A league table as the app stores it. */
export function buildStandingsDoc({ competition, rows, now }) {
  return {
    category: competition.category,
    updatedAt: now,
    rows: rows
      .filter((r) => Number.isInteger(r.position) && r.team && r.played !== null && r.goalsFor !== null && r.goalsAgainst !== null && r.points !== null)
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        position: r.position,
        team: tidy(r.team),
        played: r.played,
        goalsFor: r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        points: r.points,
        logoUrl: r.logoUrl ?? null,
        isOurs: r.teamId === competition.teamId,
      })),
  };
}

/** Plain-value comparison of two stored documents (dates compared as instants). */
export function sameDoc(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(value) {
  if (value instanceof Date) return { $date: value.getTime() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, normalize(value[k])]),
    );
  }
  return value;
}
