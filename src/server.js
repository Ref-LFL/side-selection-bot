const config = require("./config");
const { initializeFirebaseAdmin } = require("./firebase");
const { startBot } = require("./bot");
const { SideSelectionService } = require("./sessions");
const { FirestoreGuildSettingsStore, FirestoreSessionStore } = require("./store");

async function bootstrap() {
  const firestore = initializeFirebaseAdmin(config);
  const store = new FirestoreSessionStore({
    firestore,
    collectionName: config.firestoreCollectionName
  });
  const guildSettingsStore = new FirestoreGuildSettingsStore({
    firestore,
    collectionName: config.guildSettingsCollectionName
  });
  const sessions = new SideSelectionService({
    store,
    sideDurationMs: config.sideDurationMs
  });

  const client = await startBot({ sessions, store, guildSettingsStore, config });
  console.log(`Selection page base URL: ${config.publicBaseUrl}`);
  console.log("Discord bot started successfully.");

  return { client, firestore, guildSettingsStore, sessions, store };
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error("Failed to start the application.", error);
    process.exit(1);
  });
}

module.exports = {
  bootstrap
};
