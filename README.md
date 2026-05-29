# Discord Side Selection Bot

This project provides a Discord bot in Node.js plus a static side-selection page for GitHub Pages. The bot stores every session in Firebase Firestore, posts the public page link in Discord, and updates the Discord message when a side is selected or when the deadline expires.

All user-facing text in the bot and the web page is written in English.

## Commands

### `!side`

Starts a normal five-minute side-selection session.

### `!side <t:1780480800:F>`

Starts a side-selection session that stays open until the exact Discord timestamp in the command.

Example:

```text
!side <t:1780480800:F>
```

This example uses the absolute deadline `2026-06-03T10:00:00Z`, which is Wednesday, June 3, 2026 at 12:00:00 PM in Europe/Paris.

If the deadline is already in the past when the command is used, the session is immediately resolved to `Blue Side`.

### `!timer role @Role`

Lets a server administrator choose which role can use `!side`.

### `!timer role view`

Shows the current configured role for `!side`.

### `!timer role clear`

Removes the configured role. After that, only Discord server administrators can use `!side`.

## What The Bot Does

- If no role is configured, only Discord server administrators can use `!side`
- Server administrators can configure a role with `!timer role @Role`
- If a role is configured, users with that role can use `!side`
- Server administrators can always use `!side`
- Creates a unique Firestore-backed session
- Posts a Discord embed with Red Side and Blue Side buttons
- Generates a GitHub Pages URL in the format `side.html?id=SESSION_ID`
- Lets teams choose from Discord or from the web page
- Locks the first valid side choice
- Defaults to `Blue Side` after the deadline

## Architecture

- Discord bot: Node.js + `discord.js`
- Shared storage: Firebase Firestore
- Public timer page: static files in `public/`, intended for GitHub Pages
- Firebase admin access: `firebase-admin` in the bot
- Public page access: Firebase Web SDK loaded from Firebase's browser modules CDN

## Project Structure

```text
src/
  bot.js
  config.js
  embeds.js
  firebase.js
  guild-settings.js
  server.js
  sessions.js
  store.js
public/
  firebase-config.js
  side.css
  side.html
  side.js
scripts/
  verify-local.js
firestore.rules
.env.example
package.json
README.md
```

## Requirements

- Node.js 18 or newer
- A Discord application with a bot user
- A Firebase project with Firestore enabled
- The Discord **Message Content Intent** enabled

## Install Dependencies

```bash
npm install
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
PUBLIC_BASE_URL=https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY
SIDE_DURATION_SECONDS=300
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIRESTORE_COLLECTION_NAME=sideSessions
GUILD_SETTINGS_COLLECTION_NAME=guildSettings
```

### Variable Notes

- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_CLIENT_ID`: Your Discord application client ID
- `PUBLIC_BASE_URL`: Your GitHub Pages base URL
- `SIDE_DURATION_SECONDS`: Used by the plain `!side` command
- `FIREBASE_PROJECT_ID`: Firebase project ID
- `FIREBASE_CLIENT_EMAIL`: Service account client email
- `FIREBASE_PRIVATE_KEY`: Service account private key, with `\n` kept as escaped newlines in `.env`
- `FIRESTORE_COLLECTION_NAME`: Firestore collection used by the bot and the page
- `GUILD_SETTINGS_COLLECTION_NAME`: Firestore collection used for per-server role settings

## Firebase Setup

1. Create a Firebase project.
2. Enable **Cloud Firestore**.
3. Create a service account for the bot.
4. Put the service account values into `.env`.
5. Open [firestore.rules](<O:/Users/Bot 5m Discord/firestore.rules>) and publish those rules in Firestore.

The included rules allow:

- Public reads of side-selection documents
- Public updates only for valid side picks from the web page
- No public creation or deletion

## GitHub Pages Setup

The files in [public](<O:/Users/Bot 5m Discord/public>) are meant to be deployed to GitHub Pages.

Before publishing, edit [public/firebase-config.js](<O:/Users/Bot 5m Discord/public/firebase-config.js>) and replace the placeholder values:

```js
window.SIDE_SELECTION_FIREBASE_CONFIG = {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_FIREBASE_WEB_APP_ID",
  messagingSenderId: "YOUR_FIREBASE_MESSAGING_SENDER_ID",
  collectionName: "sideSessions"
};
```

Make sure `collectionName` matches `FIRESTORE_COLLECTION_NAME`.

## Invite The Bot

1. Open the Discord Developer Portal.
2. Select your application.
3. Go to **OAuth2** -> **URL Generator**.
4. Enable the `bot` scope.
5. Grant permissions such as:
   - `View Channels`
   - `Send Messages`
   - `Embed Links`
   - `Read Message History`
6. Invite the bot to your server.

Manual URL format:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot
```

## Run The Bot

```bash
npm start
```

The bot uses Firestore as the shared source of truth. GitHub Pages only hosts the static timer page.

## Local Verification

Run the built-in verification script:

```bash
npm run verify
```

This checks:

- `!side` command parsing
- `!side <t:...:F>` command parsing
- `!timer role` command parsing
- Per-server role settings behavior
- Selection locking
- Blue-side default on expiration
- GitHub Pages link generation

## How To Test In Discord

1. Start the bot with `npm start`.
2. Make sure your GitHub Pages site is live and `PUBLIC_BASE_URL` points to it.
3. As a Discord server administrator, run `!timer role view`.
4. Run `!timer role @YourStaffRole`.
5. Test `!side`.
6. Test `!side <t:1780480800:F>`.
7. Confirm that:
   - The Discord embed appears
   - The GitHub Pages link opens correctly
   - The web page countdown updates live
   - Red Side and Blue Side lock correctly
   - A past deadline resolves to Blue Side
   - `!timer role clear` returns the bot to administrator-only usage

## Known Limitation

The Discord message auto-update on expiration depends on the Node.js bot staying online. If the bot is offline, Firestore still stores the session, but Discord will not be updated until the bot runs again.

## Future Improvement

- Add GitHub Actions deployment for GitHub Pages
- Add bot hosting instructions for Cloud Run, Railway, Render, or a VPS
- Add automatic cleanup for old Firestore session documents
- Add authenticated admin tools for session history
