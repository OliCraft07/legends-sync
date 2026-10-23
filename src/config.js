// Season 2026/27 on slovakhandball.sk. The federation creates new competition
// pages every season: update these numbers when a new season starts (see README).
//
//   level   the number in https://slovakhandball.sk/levels/<level>/<stage>
//   stage   the second number there (the part of the competition, "Základná časť")
//   teamId  our team's number on the site (it is in the match data of that page)
//
// `category` is the name the app uses for the category (the Dart enum `Category`).
// `competitionName` is what the app shows before the round; without it the
// league's own name on the site is used.

/** Our team's name in the app's data (the app shows its own name per category). */
export const OUR_TEAM_NAME = 'Legends Šaľa';

export const SITE_URL = 'https://slovakhandball.sk';

export const competitions = [
  { category: 'mladsiZiaci', level: 282, stage: 301, teamId: 7050 },
  { category: 'starsiZiaci', level: 286, stage: 308, teamId: 7274 },
  { category: 'mladsiDorastenci', level: 237, stage: 259, teamId: 6581, competitionName: '1. liga' },
  { category: 'starsiDorastenci', level: 236, stage: 258, teamId: 6569, competitionName: '1. liga' },
  { category: 'muzi', level: 235, stage: 257, teamId: 6650, competitionName: '1. liga' },
];

/** How the match states of the site are read. Anything else counts as "in progress". */
export const STATE_FINISHED = 'Finished';
export const STATE_UPCOMING = 'Upcoming';

/** Live polling: from this long before the kickoff... */
export const LIVE_LEAD_MINUTES = 10;
/** ...until this long after it (youth matches last about 1 h 15 min, men's about 1 h 30 min). */
export const LIVE_TRAIL_MINUTES = 150;
