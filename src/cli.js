import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { SiteClient } from './http.js';
import { MemoryStore, ReadOnlyStore } from './store.js';
import { liveCandidates, runBaseline, runDaemon, runLive } from './sync.js';

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'auto' },
    'dry-run': { type: 'boolean', default: false },
    'max-minutes': { type: 'string', default: '330' },
    interval: { type: 'string', default: '60' },
  },
});

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

async function makeStore() {
  const credentials = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credentials) {
    if (!args['dry-run']) {
      throw new Error('Chýba FIREBASE_SERVICE_ACCOUNT (kľúč servisného účtu Firebase). Na skúšku bez zápisu použite --dry-run.');
    }
    log('Bez FIREBASE_SERVICE_ACCOUNT: skúška na prázdnej databáze, nič sa nezapisuje.');
    return new ReadOnlyStore(new MemoryStore(), log);
  }
  const { FirestoreStore } = await import('./firestore-store.js');
  const store = new FirestoreStore(credentials);
  return args['dry-run'] ? new ReadOnlyStore(store, log) : store;
}

async function main() {
  const mode = args.mode;
  if (!['auto', 'baseline', 'live'].includes(mode)) throw new Error(`Neznámy režim: ${mode}`);

  const store = await makeStore();
  const client = new SiteClient();
  const matches = await store.loadMatches();
  log(`V databáze je ${matches.size} zápasov zo SZH. Režim: ${mode}${args['dry-run'] ? ' (skúška)' : ''}`);

  let failed = false;

  if (mode === 'auto') {
    // The whole match day in one run (see runDaemon): the everyday pass when it is due,
    // every match that is on followed every minute, and a wait in between.
    const summary = await runDaemon({
      client,
      store,
      log,
      maxMinutes: Number(args['max-minutes']),
      intervalMs: Number(args.interval) * 1000,
    });
    log(
      `Hotovo: ${summary.baselines} hlavných sťahovaní, ${summary.polls} stiahnutí zápasov naživo, ` +
        `${summary.writes} zápisov, ${summary.finished} skončených zápasov`,
    );
    for (const warning of summary.warnings) log(`Upozornenie: ${warning}`);
    for (const error of summary.baselineErrors) log(`CHYBA: ${error}`);
    for (const error of summary.errors.slice(-5)) log(`Chyba pri sledovaní: ${error}`);
    // A hiccup of the federation's site in one of the many passes of a long day is not a failure of
    // the run (it would also stop the next run from being started); only when every pass failed.
    failed ||= summary.baselines > 0 && summary.baselinesWithErrors === summary.baselines;
    if (summary.continueNeeded) {
      // The workflow starts the next run when it finds this file.
      writeFileSync('continue.flag', '1');
      log('Zápasový deň ešte neskončil: spustí sa ďalší beh.');
    }
  } else if (mode === 'baseline') {
    const result = await runBaseline({ client, store, log });
    const s = result.summary;
    log(`Zápasy: ${s.added} nových, ${s.updated} zmenených, ${s.unchanged} bez zmeny; tabuľky zapísané: ${s.standingsWritten}`);
    for (const warning of s.warnings) log(`Upozornenie: ${warning}`);
    for (const error of s.errors) log(`CHYBA: ${error}`);
    failed ||= s.errors.length > 0;
  } else {
    const candidates = liveCandidates(matches, new Date());
    if (candidates.size === 0) {
      log('Žiadny zápas sa nehrá ani sa čoskoro nezačne.');
    } else {
      log(`Sledujem naživo: ${[...candidates.keys()].join(', ')}`);
      const summary = await runLive({
        client,
        store,
        matches,
        log,
        maxMinutes: Number(args['max-minutes']),
        intervalMs: Number(args.interval) * 1000,
      });
      log(`Naživo: ${summary.polls} stiahnutí, ${summary.writes} zápisov, ${summary.finished} skončených zápasov`);
      for (const error of summary.errors.slice(-5)) log(`CHYBA: ${error}`);
    }
  }

  log(`Stiahnuté z webu zväzu: ${client.requests} stránok, ${(client.bytes / 1e6).toFixed(1)} MB`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
