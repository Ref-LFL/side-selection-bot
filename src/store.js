function cloneSession(session) {
  return session ? JSON.parse(JSON.stringify(session)) : null;
}

function cloneGuildSetting(setting) {
  return setting ? JSON.parse(JSON.stringify(setting)) : null;
}

class InMemorySessionStore {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
  }

  async create(session) {
    const storedSession = cloneSession(session);
    this.sessions.set(storedSession.id, storedSession);
    this.notify(storedSession, "added");
    return cloneSession(storedSession);
  }

  async get(id) {
    return cloneSession(this.sessions.get(id) ?? null);
  }

  async update(id, updater) {
    const currentSession = this.sessions.get(id);

    if (!currentSession) {
      return null;
    }

    const nextSession = updater(cloneSession(currentSession));

    if (nextSession === undefined) {
      return cloneSession(currentSession);
    }

    const storedSession = cloneSession(nextSession);
    this.sessions.set(id, storedSession);
    this.notify(storedSession, "modified");
    return cloneSession(storedSession);
  }

  async listPending() {
    return Array.from(this.sessions.values())
      .filter((session) => session.status === "PENDING")
      .map((session) => cloneSession(session));
  }

  onSnapshot(listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(session, changeType) {
    for (const listener of this.listeners) {
      Promise.resolve(listener(cloneSession(session), changeType)).catch((error) => {
        console.error("Failed to process an in-memory session update.", error);
      });
    }
  }
}

class FirestoreSessionStore {
  constructor({ firestore, collectionName = "sideSessions" }) {
    this.firestore = firestore;
    this.collection = firestore.collection(collectionName);
  }

  async create(session) {
    const storedSession = cloneSession(session);
    await this.collection.doc(storedSession.id).set(storedSession);
    return cloneSession(storedSession);
  }

  async get(id) {
    const snapshot = await this.collection.doc(id).get();
    return snapshot.exists ? cloneSession(snapshot.data()) : null;
  }

  async update(id, updater) {
    const docRef = this.collection.doc(id);
    let result = null;

    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);

      if (!snapshot.exists) {
        result = null;
        return;
      }

      const currentSession = cloneSession(snapshot.data());
      const nextSession = updater(cloneSession(currentSession));

      if (nextSession === undefined) {
        result = cloneSession(currentSession);
        return;
      }

      const storedSession = cloneSession(nextSession);
      transaction.set(docRef, storedSession);
      result = storedSession;
    });

    return cloneSession(result);
  }

  async listPending() {
    const snapshot = await this.collection.where("status", "==", "PENDING").get();
    return snapshot.docs.map((document) => cloneSession(document.data()));
  }

  onSnapshot(listener) {
    return this.collection.onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          Promise.resolve(listener(cloneSession(change.doc.data()), change.type)).catch((error) => {
            console.error("Failed to process a Firestore session update.", error);
          });
        }
      },
      (error) => {
        console.error("Firestore session listener failed.", error);
      }
    );
  }
}

class InMemoryGuildSettingsStore {
  constructor() {
    this.settings = new Map();
  }

  async get(guildId) {
    return cloneGuildSetting(this.settings.get(guildId) ?? null);
  }

  async save(setting) {
    const storedSetting = cloneGuildSetting(setting);
    this.settings.set(storedSetting.guildId, storedSetting);
    return cloneGuildSetting(storedSetting);
  }

  async delete(guildId) {
    this.settings.delete(guildId);
  }
}

class FirestoreGuildSettingsStore {
  constructor({ firestore, collectionName = "guildSettings" }) {
    this.collection = firestore.collection(collectionName);
  }

  async get(guildId) {
    const snapshot = await this.collection.doc(guildId).get();
    return snapshot.exists ? cloneGuildSetting(snapshot.data()) : null;
  }

  async save(setting) {
    const storedSetting = cloneGuildSetting(setting);
    await this.collection.doc(storedSetting.guildId).set(storedSetting);
    return cloneGuildSetting(storedSetting);
  }

  async delete(guildId) {
    await this.collection.doc(guildId).delete();
  }
}

module.exports = {
  FirestoreGuildSettingsStore,
  FirestoreSessionStore,
  InMemoryGuildSettingsStore,
  InMemorySessionStore
};
