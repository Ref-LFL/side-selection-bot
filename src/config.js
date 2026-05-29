const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function readString(name, fallback) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === null || rawValue === "" ? fallback : rawValue;

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Environment variable ${name} must be set.`);
  }

  return value.trim();
}

function readOptionalString(name) {
  const value = process.env[name];

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function readPositiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return value;
}

const sideDurationSeconds = readPositiveInteger("SIDE_DURATION_SECONDS", 300);

module.exports = {
  rootDir: path.resolve(__dirname, ".."),
  discordToken: readOptionalString("DISCORD_TOKEN"),
  discordClientId: readOptionalString("DISCORD_CLIENT_ID"),
  publicBaseUrl: readString(
    "PUBLIC_BASE_URL",
    "https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY"
  ).replace(/\/+$/, ""),
  sideDurationSeconds,
  sideDurationMs: sideDurationSeconds * 1000,
  firebaseProjectId: readOptionalString("FIREBASE_PROJECT_ID"),
  firebaseClientEmail: readOptionalString("FIREBASE_CLIENT_EMAIL"),
  firebasePrivateKey: readOptionalString("FIREBASE_PRIVATE_KEY")?.replace(/\\n/g, "\n") ?? null,
  firestoreCollectionName: readString("FIRESTORE_COLLECTION_NAME", "sideSessions"),
  guildSettingsCollectionName: readString("GUILD_SETTINGS_COLLECTION_NAME", "guildSettings")
};
