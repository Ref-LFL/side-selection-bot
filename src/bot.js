const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { buildSideSelectionMessage } = require("./embeds");
const {
  canUseSideSelection,
  GuildSettingsService,
  parseTimerRoleCommand
} = require("./guild-settings");
const { parseSideCommand, SessionError } = require("./sessions");

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function memberIsAdministrator(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

function getMemberRoleIds(member) {
  return Array.from(member.roles.cache.keys());
}

function getEffectiveAllowedRole(message, guildSetting) {
  if (!guildSetting?.allowedRoleId) {
    return null;
  }

  return message.guild.roles.cache.get(guildSetting.allowedRoleId) ?? null;
}

async function memberCanUseSideSelection(message, guildSettingsService) {
  const guildSetting = await guildSettingsService.getGuildSetting(message.guild.id);
  const allowedRole = getEffectiveAllowedRole(message, guildSetting);

  return canUseSideSelection({
    isAdministrator: memberIsAdministrator(message.member),
    memberRoleIds: getMemberRoleIds(message.member),
    allowedRoleId: allowedRole?.id ?? null
  });
}

async function handleTimerRoleCommand(message, guildSettingsService) {
  const parsedCommand = parseTimerRoleCommand(message.content);

  if (!parsedCommand) {
    return false;
  }

  if (!message.guild || !message.member) {
    await message.reply("This command can only be used in a server.");
    return true;
  }

  if (!parsedCommand.isValid) {
    await message.reply(parsedCommand.message);
    return true;
  }

  if (!memberIsAdministrator(message.member)) {
    await message.reply("Only server administrators can change who can use side selection.");
    return true;
  }

  if (parsedCommand.action === "view") {
    const guildSetting = await guildSettingsService.getGuildSetting(message.guild.id);
    const allowedRole = getEffectiveAllowedRole(message, guildSetting);

    if (!allowedRole) {
      await message.reply("No role is configured. Only server administrators can use !side.");
      return true;
    }

    await message.reply(`The current role allowed to use !side is ${allowedRole}.`);
    return true;
  }

  if (parsedCommand.action === "clear") {
    await guildSettingsService.clearAllowedRole(message.guild.id);
    await message.reply("Role access has been cleared. Only server administrators can use !side now.");
    return true;
  }

  if (parsedCommand.action === "set") {
    const role = message.mentions.roles.get(parsedCommand.roleId) ?? message.guild.roles.cache.get(parsedCommand.roleId);

    if (!role) {
      await message.reply("Please mention a valid server role.");
      return true;
    }

    await guildSettingsService.setAllowedRole({
      guildId: message.guild.id,
      roleId: role.id,
      roleName: role.name,
      updatedBy: message.author.id
    });

    await message.reply(
      `Users with the role ${role} can now use !side. Server administrators can always use it too.`
    );
    return true;
  }

  await message.reply(parsedCommand.message);
  return true;
}

function buildSelectionUrl(publicBaseUrl, sessionId) {
  return `${publicBaseUrl}/side.html?id=${encodeURIComponent(sessionId)}`;
}

async function syncDiscordMessage(client, session, config) {
  if (!session.messageId) {
    return;
  }

  const selectionUrl = buildSelectionUrl(config.publicBaseUrl, session.id);

  try {
    const channel = await client.channels.fetch(session.channelId);

    if (!channel || !channel.isTextBased()) {
      return;
    }

    const message = await channel.messages.fetch(session.messageId);
    await message.edit(
      buildSideSelectionMessage({
        session,
        selectionUrl
      })
    );
  } catch (error) {
    console.error(`Failed to sync the Discord message for session ${session.id}.`, error);
  }
}

function parseButtonCustomId(customId) {
  const match = /^side:(RED|BLUE):([0-9a-f-]+)$/i.exec(customId);

  if (!match) {
    return null;
  }

  return {
    side: match[1].toUpperCase(),
    sessionId: match[2]
  };
}

function createExpirationScheduler(sessions) {
  const timeouts = new Map();

  function cancel(sessionId) {
    const existingTimeout = timeouts.get(sessionId);

    if (!existingTimeout) {
      return;
    }

    clearTimeout(existingTimeout);
    timeouts.delete(sessionId);
  }

  function schedule(session) {
    cancel(session.id);

    if (session.status !== "PENDING") {
      return;
    }

    const remainingMs = session.deadlineAt - Date.now();
    const timeoutDelay = Math.max(0, Math.min(remainingMs, MAX_TIMER_DELAY_MS));

    const timeout = setTimeout(async () => {
      timeouts.delete(session.id);

      try {
        const latestSession = await sessions.getSessionSnapshot(session.id);

        if (latestSession.status !== "PENDING") {
          return;
        }

        if (latestSession.deadlineAt - Date.now() > MAX_TIMER_DELAY_MS) {
          schedule(latestSession);
          return;
        }

        await sessions.expireSession(session.id);
      } catch (error) {
        console.error(`Failed to process session expiration for ${session.id}.`, error);
      }
    }, timeoutDelay);

    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    timeouts.set(session.id, timeout);
  }

  function stopAll() {
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout);
    }

    timeouts.clear();
  }

  return {
    cancel,
    schedule,
    stopAll
  };
}

async function startBot({ sessions, store, guildSettingsStore, config }) {
  if (!config.discordToken) {
    throw new Error("DISCORD_TOKEN is required to start the Discord bot.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });
  const expirationScheduler = createExpirationScheduler(sessions);
  const guildSettingsService = new GuildSettingsService({ store: guildSettingsStore });

  store.onSnapshot(async (session, changeType) => {
    if (session.status === "PENDING") {
      expirationScheduler.schedule(session);
      return;
    }

    expirationScheduler.cancel(session.id);

    if (changeType !== "modified" || !session.messageId || !client.isReady()) {
      return;
    }

    await syncDiscordMessage(client, session, config);
  });

  client.once("ready", async () => {
    console.log(`Discord bot logged in as ${client.user.tag}.`);

    try {
      const pendingSessions = await sessions.listPendingSessions();

      for (const session of pendingSessions) {
        expirationScheduler.schedule(session);
      }
    } catch (error) {
      console.error("Failed to schedule pending sessions on startup.", error);
    }
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) {
      return;
    }

    if (await handleTimerRoleCommand(message, guildSettingsService)) {
      return;
    }

    const parsedCommand = parseSideCommand(message.content, config.sideDurationMs);

    if (!parsedCommand) {
      return;
    }

    if (!message.guild || !message.member) {
      await message.reply("This command can only be used in a server.");
      return;
    }

    if (!parsedCommand.isValid) {
      await message.reply(parsedCommand.message);
      return;
    }

    if (!(await memberCanUseSideSelection(message, guildSettingsService))) {
      await message.reply("You do not have permission to start a side selection.");
      return;
    }

    try {
      const session = await sessions.createSession({
        guildId: message.guild.id,
        channelId: message.channel.id,
        deadlineAt: parsedCommand.deadlineAt,
        deadlineSource: parsedCommand.deadlineSource
      });

      const selectionUrl = buildSelectionUrl(config.publicBaseUrl, session.id);
      const sentMessage = await message.channel.send(
        buildSideSelectionMessage({
          session,
          selectionUrl
        })
      );

      await sessions.attachMessage(session.id, sentMessage.id);

      const latestSession = await sessions.getSessionSnapshot(session.id);
      if (latestSession.status !== "PENDING") {
        await syncDiscordMessage(client, latestSession, config);
      }
    } catch (error) {
      console.error("Failed to start a side selection session.", error);
      await message.reply("The side selection could not be started due to a server error.");
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const buttonSelection = parseButtonCustomId(interaction.customId);

    if (!buttonSelection) {
      return;
    }

    try {
      await sessions.selectSide(buttonSelection.sessionId, buttonSelection.side, interaction.user.id);
      await interaction.reply({
        content: "Side selected successfully.",
        ephemeral: true
      });
    } catch (error) {
      if (error instanceof SessionError) {
        await interaction.reply({
          content: error.message,
          ephemeral: true
        });
        return;
      }

      console.error("Failed to handle a side selection button click.", error);
      await interaction.reply({
        content: "The side selection could not be completed due to a server error.",
        ephemeral: true
      });
    }
  });

  await client.login(config.discordToken);
  return client;
}

module.exports = {
  buildSelectionUrl,
  startBot
};
