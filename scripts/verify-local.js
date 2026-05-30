const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("node:url");

async function importModule(relativePath) {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, "..", relativePath));
  return import(moduleUrl.href);
}

async function main() {
  const now = Date.UTC(2026, 4, 29, 10, 0, 0);
  const defaultDurationMs = 300000;
  const core = await importModule("worker/core.mjs");
  const commands = await importModule("worker/commands.mjs");

  const defaultDeadline = core.parseDeadlineInput(null, defaultDurationMs, now);
  assert.equal(defaultDeadline.deadlineSource, "DURATION");
  assert.equal(defaultDeadline.deadlineAt, now + defaultDurationMs);

  const unixDeadline = core.parseDeadlineInput("1780480800", defaultDurationMs, now);
  assert.equal(unixDeadline.deadlineSource, "TIMESTAMP");
  assert.equal(unixDeadline.deadlineAt, 1780480800 * 1000);

  const discordDeadline = core.parseDeadlineInput("<t:1780480800:F>", defaultDurationMs, now);
  assert.equal(discordDeadline.deadlineSource, "TIMESTAMP");
  assert.equal(discordDeadline.deadlineAt, 1780480800 * 1000);

  assert.throws(
    () => core.parseDeadlineInput("tomorrow", defaultDurationMs, now),
    (error) => error instanceof core.SessionError && error.code === "INVALID_DEADLINE"
  );

  const session = core.createSessionRecord({
    id: "session-1",
    guildId: "guild-1",
    channelId: "channel-1",
    createdBy: "user-1",
    pingRoleId: "role-1",
    pingRoleName: "Galions",
    deadlineAt: now + 600000,
    deadlineSource: "TIMESTAMP",
    sideDurationMs: defaultDurationMs,
    nowMs: now
  });

  assert.equal(session.status, "PENDING");
  assert.equal(session.selectedSide, null);
  assert.equal(session.pingRoleId, "role-1");

  const selectionUrl = core.buildSelectionUrl("https://example.github.io/side-selection-bot", session.id);
  assert.equal(
    selectionUrl,
    `https://example.github.io/side-selection-bot/side.html?id=${encodeURIComponent(session.id)}`
  );

  const pendingMessage = core.buildSideSelectionMessage(session, "https://example.github.io/side-selection-bot", {
    mentionMode: "ping"
  });
  assert.equal(pendingMessage.content, "<@&role-1>");
  assert.equal(pendingMessage.components.length, 2);
  assert.equal(pendingMessage.components[0].components[0].style, 4);
  assert.equal(pendingMessage.components[0].components[1].style, 1);
  assert.equal(pendingMessage.components[1].components[0].label, "Lock Side");
  assert.equal(pendingMessage.components[1].components[0].disabled, true);
  assert.equal(pendingMessage.components[1].components[1].label, "Cancel");

  const tentativeMessage = core.buildSideSelectionMessage(
    {
      ...session,
      selectedSide: "BLUE",
      selectedBy: "user-2"
    },
    "https://example.github.io/side-selection-bot"
  );
  assert.equal(tentativeMessage.embeds[0].fields[0].name, "Current Choice");
  assert.equal(tentativeMessage.components[1].components[0].label, "Lock Blue Side");
  assert.equal(tentativeMessage.components[1].components[0].disabled, false);

  const selectedMessage = core.buildSideSelectionMessage(
    {
      ...session,
      status: "SELECTED",
      selectedSide: "RED",
      selectedBy: "123456789"
    },
    "https://example.github.io/side-selection-bot"
  );
  assert.equal(selectedMessage.embeds[0].title, "Red Side Selected");
  assert.equal(selectedMessage.components[0].components[0].style, 2);
  assert.equal(selectedMessage.components[0].components[1].style, 2);
  assert.equal(selectedMessage.components[1].components[0].disabled, true);
  assert.equal(selectedMessage.components[1].components[1].disabled, true);

  const expiredMessage = core.buildSideSelectionMessage(
    {
      ...session,
      status: "EXPIRED",
      selectedSide: "BLUE"
    },
    "https://example.github.io/side-selection-bot"
  );
  assert.equal(expiredMessage.embeds[0].title, "Blue Side Applied");

  const cancelledMessage = core.buildSideSelectionMessage(
    {
      ...session,
      status: "CANCELLED",
      selectedBy: "123456789"
    },
    "https://example.github.io/side-selection-bot"
  );
  assert.equal(cancelledMessage.embeds[0].title, "Side Selection Cancelled");

  const publicSession = core.toPublicSession(session, now + 1000);
  assert.equal(publicSession.id, "session-1");
  assert.equal(publicSession.createdAt, now);
  assert.equal(publicSession.durationSeconds, 600);

  assert.equal(
    core.canUseSideSelection({
      isAdministrator: true,
      memberRoleIds: [],
      allowedRoleId: null
    }),
    true
  );
  assert.equal(
    core.canUseSideSelection({
      isAdministrator: false,
      memberRoleIds: [],
      allowedRoleId: null
    }),
    false
  );
  assert.equal(
    core.canUseSideSelection({
      isAdministrator: false,
      memberRoleIds: ["role-1"],
      allowedRoleId: "role-1"
    }),
    true
  );
  assert.equal(
    core.canControlPendingSelection({
      session,
      isAdministrator: false,
      memberRoleIds: ["role-1"],
      allowedRoleId: null
    }),
    true
  );
  assert.equal(
    core.canControlPendingSelection({
      session,
      isAdministrator: false,
      memberRoleIds: ["staff-role"],
      allowedRoleId: "staff-role"
    }),
    false
  );
  assert.equal(
    core.canCancelSideSelection({
      isAdministrator: false,
      memberRoleIds: ["staff-role"],
      allowedRoleId: "staff-role"
    }),
    true
  );
  assert.equal(
    core.buildResultNotification({
      ...session,
      status: "CANCELLED"
    }),
    "<@user-1>\n- Side selection cancelled."
  );

  assert.equal(commands.SLASH_COMMANDS.length, 2);
  assert.equal(commands.SLASH_COMMANDS[0].name, "side");
  assert.equal(commands.SLASH_COMMANDS[1].name, "timer");
  assert.deepEqual(commands.parseTimerRoleOptions([{ name: "role", options: [{ name: "view" }] }]), {
    action: "view"
  });
  assert.deepEqual(
    commands.parseTimerRoleOptions([
      {
        name: "role",
        options: [
          {
            name: "set",
            options: [{ name: "role", value: "1234567890" }]
          }
        ]
      }
    ]),
    {
      action: "set",
      roleId: "1234567890"
    }
  );

  await importModule("worker/index.mjs");

  console.log("Local verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
