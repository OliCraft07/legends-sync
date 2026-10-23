import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { MATCH_PREFIX } from './store.js';

/**
 * The club app's Firestore database (collections `matches` and `standings`),
 * written with a service account, which the database rules do not apply to.
 * The documents have exactly the fields the app's `matchToMap` and
 * `standingsToMap` write.
 */
export class FirestoreStore {
  constructor(serviceAccountJson) {
    const credentials = JSON.parse(serviceAccountJson);
    const app = getApps()[0] ?? initializeApp({ credential: cert(credentials) });
    this.db = getFirestore(app);
  }

  async loadMatches() {
    const snapshot = await this.db.collection('matches').get();
    const matches = new Map();
    for (const doc of snapshot.docs) {
      if (!doc.id.startsWith(MATCH_PREFIX)) continue;
      const data = doc.data();
      if (!(data.dateTime instanceof Timestamp)) continue;
      matches.set(doc.id, { ...data, dateTime: data.dateTime.toDate() });
    }
    return matches;
  }

  async loadStandings() {
    const snapshot = await this.db.collection('standings').get();
    const standings = new Map();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!(data.updatedAt instanceof Timestamp)) continue;
      standings.set(doc.id, { ...data, updatedAt: data.updatedAt.toDate() });
    }
    return standings;
  }

  async saveMatches(entries) {
    await this.#writeAll('matches', entries, (doc) => ({ ...doc, dateTime: Timestamp.fromDate(doc.dateTime) }));
  }

  async saveStandings(entries) {
    await this.#writeAll('standings', entries, (doc) => ({ ...doc, updatedAt: Timestamp.fromDate(doc.updatedAt) }));
  }

  async #writeAll(collection, entries, toData) {
    for (let start = 0; start < entries.length; start += 400) {
      const batch = this.db.batch();
      for (const { id, doc } of entries.slice(start, start + 400)) {
        batch.set(this.db.collection(collection).doc(id), toData(doc));
      }
      await batch.commit();
    }
  }
}
