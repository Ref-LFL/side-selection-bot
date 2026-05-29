const assert = require("node:assert/strict");
const { buildSelectionUrl } = require("../src/bot");
const {
  canUseSideSelection,
  GuildSettingsService,
  parseTimerRoleCommand
} = require("../src/guild-settings");
const { parseSideCommand, SessionError, SideSelectionService } = require("../src/sessions");
const { InMemoryGuildSettingsStore, InMemorySessionStore } = require("../src/store");

async function main() {
  const now = Date.UTC(2026, 4, 29, 10, 0, 0);
  const defaultDurationMs = 300000;

  const defaultCommand = parseSideCommand("!side", defaultDurationMs, now);
  assert.ok(defaultCommand);
  assert.equal(defaultCommand.isValid, true);
  assert.equal(defaultCommand.deadlineSource, "DURATION");
  assert.equal(defaultCommand.deadlineAt, now + defaultDurationMs);

  const timestampCommand = parseSideCommand("!side <t:1780480800:F>", defaultDurationMs, now);
  assert.ok(timestampCommand);
  assert.equal(timestampCommand.isValid, true);
  assert.equal(timestampCommand.deadlineSource, "TIMESTAMP");
  assert.equal(timestampCommand.deadlineAt, 1780480800 * 1000);

  const invalidCommand = parseSideCommand("!side tomorrow", defaultDurationMs, now);
  assert.ok(invalidCommand);
  assert.equal(invalidCommand.isValid, false);

  assert.equal(parseSideCommand("hello world", defaultDurationMs, now), null);

  const timerViewCommand = parseTimerRoleCommand("!timer role view");
  assert.ok(timerViewCommand);
  assert.equal(timerViewCommand.isValid, true);
  assert.equal(timerViewCommand.action, "view");

  const timerClearCommand = parseTimerRoleCommand("!timer role clear");
  assert.ok(timerClearCommand);
  assert.equal(timerClearCommand.isValid, true);
  assert.equal(timerClearCommand.action, "clear");

  const timerSetCommand = parseTimerRoleCommand("!timer role <@&1234567890>");
  assert.ok(timerSetCommand);
  assert.equal(timerSetCommand.isValid, true);
  assert.equal(timerSetCommand.action, "set");
  assert.equal(timerSetCommand.roleId, "1234567890");

  const timerSetFriendlyCommand = parseTimerRoleCommand("!timer role:<@&1234567890> allow to used");
  assert.ok(timerSetFriendlyCommand);
  assert.equal(timerSetFriendlyCommand.isValid, true);
  assert.equal(timerSetFriendlyCommand.action, "set");

  const timerInvalidCommand = parseTimerRoleCommand("!timer role maybe");
  assert.ok(timerInvalidCommand);
  assert.equal(timerInvalidCommand.isValid, false);

  assert.equal(parseTimerRoleCommand("!side"), null);

  const guildSettingsService = new GuildSettingsService({
    store: new InMemoryGuildSettingsStore()
  });

  assert.equal(await guildSettingsService.getGuildSetting("guild-1"), null);

  await guildSettingsService.setAllowedRole({
    guildId: "guild-1",
    roleId: "role-1",
    roleName: "Tournament Admin",
    updatedBy: "user-1",
    updatedAt: now
  });

  const storedSetting = await guildSettingsService.getGuildSetting("guild-1");
  assert.equal(storedSetting.allowedRoleId, "role-1");
  assert.equal(storedSetting.allowedRoleName, "Tournament Admin");

  assert.equal(
    canUseSideSelection({
      isAdministrator: true,
      memberRoleIds: [],
      allowedRoleId: null
    }),
    true
  );

  assert.equal(
    canUseSideSelection({
      isAdministrator: false,
      memberRoleIds: [],
      allowedRoleId: null
    }),
    false
  );

  assert.equal(
    canUseSideSelection({
      isAdministrator: false,
      memberRoleIds: ["role-1"],
      allowedRoleId: "role-1"
    }),
    true
  );

  assert.equal(
    canUseSideSelection({
      isAdministrator: false,
      memberRoleIds: ["role-2"],
      allowedRoleId: "role-1"
    }),
    false
  );

  await guildSettingsService.clearAllowedRole("guild-1");
  assert.equal(await guildSettingsService.getGuildSetting("guild-1"), null);

  let currentTime = now;
  const sessions = new SideSelectionService({
    store: new InMemorySessionStore(),
    sideDurationMs: defaultDurationMs,
    now: () => currentTime
  });

  const futureSession = await sessions.createSession({
    guildId: "guild-1",
    channelId: "channel-1",
    deadlineAt: now + 600000,
    deadlineSource: "TIMESTAMP"
  });

  assert.equal(futureSession.status, "PENDING");
  assert.equal(futureSession.selectedSide, null);

  const attachedSession = await sessions.attachMessage(futureSession.id, "message-1");
  assert.equal(attachedSession.messageId, "message-1");

  const selectedSession = await sessions.selectSide(futureSession.id, "RED", "tester");
  assert.equal(selectedSession.status, "SELECTED");
  assert.equal(selectedSession.selectedSide, "RED");
  assert.equal(selectedSession.selectedBy, "tester");

  const alreadyExpiredSession = await sessions.createSession({
    guildId: "guild-2",
    channelId: "channel-2",
    deadlineAt: now - 1000,
    deadlineSource: "TIMESTAMP"
  });

  assert.equal(alreadyExpiredSession.status, "EXPIRED");
  assert.equal(alreadyExpiredSession.selectedSide, "BLUE");

  const expiringSession = await sessions.createSession({
    guildId: "guild-3",
    channelId: "channel-3",
    deadlineAt: now + 1000,
    deadlineSource: "TIMESTAMP"
  });

  currentTime = now + 2000;

  await assert.rejects(
    () => sessions.selectSide(expiringSession.id, "BLUE", "tester"),
    (error) =>
      error instanceof SessionError &&
      error.code === "EXPIRED" &&
      error.session &&
      error.session.selectedSide === "BLUE"
  );

  const expiredSnapshot = await sessions.getSession(expiringSession.id);
  assert.equal(expiredSnapshot.status, "EXPIRED");
  assert.equal(expiredSnapshot.selectedSide, "BLUE");

  const pendingSessions = await sessions.listPendingSessions();
  assert.equal(pendingSessions.length, 0);

  const selectionUrl = buildSelectionUrl("https://example.github.io/side-selection-bot", futureSession.id);
  assert.equal(
    selectionUrl,
    `https://example.github.io/side-selection-bot/side.html?id=${encodeURIComponent(futureSession.id)}`
  );

  console.log("Local verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
