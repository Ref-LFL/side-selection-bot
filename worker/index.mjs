import { findOption, parseTimerRoleOptions } from "./commands.mjs";
import {
  EPHEMERAL_FLAG,
  INTERACTION_RESPONSE_TYPE,
  SessionError,
  buildResultNotification,
  buildSideSelectionMessage,
  canCancelSideSelection,
  canControlPendingSelection,
  canUseSideSelection,
  createSessionRecord,
  memberIsAdministrator,
  parseDeadlineInput,
  toPublicSession
} from "./core.mjs";
import {
  cancelSession,
  chooseSessionSide,
  clearGuildSetting,
  createSession,
  ensureCurrentSessionState,
  getGuildSetting,
  getSession,
  lockSession,
  listExpiredPendingSessions,
  markStarterNotified,
  selectSession,
  setGuildSetting,
  updateSessionMessageId
} from "./store.mjs";

const BUTTON_CUSTOM_ID_REGEX = /^side:(RED|BLUE|LOCK|CANCEL):([0-9a-f-]+)$/i;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

function getSideDurationMs(env) {
  const seconds = Number.parseInt(env.SIDE_DURATION_SECONDS ?? "300", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 300000;
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function textResponse(content, status = 200, extraHeaders = {}) {
  return new Response(content, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...extraHeaders
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function optionsResponse() {
  return withCors(new Response(null, { status: 204 }));
}

function hexToBytes(hex) {
  const normalizedHex = String(hex).trim();
  const bytes = new Uint8Array(normalizedHex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalizedHex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

async function verifyDiscordSignature(body, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) {
    return false;
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKey),
      {
        name: "Ed25519"
      },
      false,
      ["verify"]
    );

    return crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      hexToBytes(signature),
      new TextEncoder().encode(`${timestamp}${body}`)
    );
  } catch (error) {
    console.error("Failed to verify the Discord interaction signature.", error);
    return false;
  }
}

async function discordApi(env, path, init = {}) {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord API request failed (${response.status}): ${errorText}`);
  }

  return response;
}

async function fetchOriginalInteractionMessage(env, interactionToken) {
  const response = await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch the original interaction response (${response.status}): ${errorText}`);
  }

  return response.json();
}

function getInteractionUser(interaction) {
  return interaction.member?.user ?? interaction.user ?? null;
}

function getInteractionUserId(interaction) {
  return getInteractionUser(interaction)?.id ?? null;
}

function getInteractionMemberRoles(interaction) {
  return Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
}

function buildEphemeralResponse(content) {
  return jsonResponse({
    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: EPHEMERAL_FLAG
    }
  });
}

function buildSilentButtonAck() {
  return jsonResponse({
    type: INTERACTION_RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE
  });
}

function parseButtonSelection(customId) {
  const match = BUTTON_CUSTOM_ID_REGEX.exec(customId);

  if (!match) {
    return null;
  }

  return {
    action: match[1].toUpperCase(),
    sessionId: match[2]
  };
}

function buildSelectionPermissionError(session) {
  if (session?.pingRoleId) {
    return "Only the tagged team role or a server administrator can choose and lock the side.";
  }

  return "You do not have permission to manage this side selection.";
}

function buildCancelPermissionError() {
  return "Only server administrators or the configured timer role can cancel a side selection.";
}

async function syncSessionMessage(env, session) {
  if (!session?.messageId) {
    return;
  }

  const payload = buildSideSelectionMessage(session, env.PUBLIC_BASE_URL, {
    mentionMode: "silent"
  });

  await discordApi(env, `/channels/${session.channelId}/messages/${session.messageId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

async function notifyStarterIfNeeded(env, session) {
  if (!session || !session.createdBy || session.starterNotifiedAt) {
    return;
  }

  const notification = buildResultNotification(session);

  if (!notification) {
    return;
  }

  const didClaimNotification = await markStarterNotified(env, session.id, Date.now());

  if (!didClaimNotification) {
    return;
  }

  await discordApi(env, `/channels/${session.channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: notification,
      allowed_mentions: {
        parse: [],
        users: [session.createdBy]
      }
    })
  });
}

async function syncAndNotify(env, session) {
  await Promise.all([syncSessionMessage(env, session), notifyStarterIfNeeded(env, session)]);
}

async function persistOriginalMessageId(env, sessionId, interactionToken) {
  try {
    const originalMessage = await fetchOriginalInteractionMessage(env, interactionToken);
    await updateSessionMessageId(env, sessionId, originalMessage.id);

    const refreshedSession = await getSession(env, sessionId);

    if (refreshedSession && refreshedSession.status !== "PENDING") {
      await syncAndNotify(env, refreshedSession);
    }
  } catch (error) {
    console.error(`Failed to persist the original message ID for session ${sessionId}.`, error);
  }
}

async function handleSideCommand(interaction, env, ctx) {
  if (!interaction.guild_id || !interaction.member) {
    return buildEphemeralResponse("This command can only be used in a server.");
  }

  const guildSetting = await getGuildSetting(env, interaction.guild_id);
  const user = getInteractionUser(interaction);
  const isAdministrator = memberIsAdministrator(interaction.member.permissions);
  const allowedRoleId = guildSetting?.allowedRoleId ?? null;
  const memberRoleIds = getInteractionMemberRoles(interaction);

  if (!canUseSideSelection({ isAdministrator, memberRoleIds, allowedRoleId })) {
    return buildEphemeralResponse("You do not have permission to start a side selection.");
  }

  const deadlineOption = findOption(interaction.data.options, "deadline");
  const teamOption = findOption(interaction.data.options, "team");

  let deadline;

  try {
    deadline = parseDeadlineInput(deadlineOption?.value ?? null, getSideDurationMs(env), Date.now());
  } catch (error) {
    if (error instanceof SessionError) {
      return buildEphemeralResponse(error.message);
    }

    throw error;
  }

  const teamRoleId = teamOption?.value ? String(teamOption.value) : null;
  const teamRole = teamRoleId ? interaction.data.resolved?.roles?.[teamRoleId] ?? null : null;

  const session = createSessionRecord({
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    createdBy: user?.id ?? null,
    pingRoleId: teamRoleId,
    pingRoleName: teamRole?.name ?? null,
    deadlineAt: deadline.deadlineAt,
    deadlineSource: deadline.deadlineSource,
    sideDurationMs: getSideDurationMs(env),
    nowMs: Date.now()
  });

  await createSession(env, session);
  ctx.waitUntil(persistOriginalMessageId(env, session.id, interaction.token));

  if (session.status !== "PENDING") {
    ctx.waitUntil(notifyStarterIfNeeded(env, session));
  }

  return jsonResponse({
    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: buildSideSelectionMessage(session, env.PUBLIC_BASE_URL, {
      mentionMode: "ping"
    })
  });
}

async function handleTimerCommand(interaction, env) {
  if (!interaction.guild_id || !interaction.member) {
    return buildEphemeralResponse("This command can only be used in a server.");
  }

  if (!memberIsAdministrator(interaction.member.permissions)) {
    return buildEphemeralResponse("Only server administrators can change who can use side selection.");
  }

  const timerRoleAction = parseTimerRoleOptions(interaction.data.options);

  if (!timerRoleAction) {
    return buildEphemeralResponse("Use /timer role view, /timer role clear, or /timer role set.");
  }

  if (timerRoleAction.action === "view") {
    const guildSetting = await getGuildSetting(env, interaction.guild_id);

    if (!guildSetting?.allowedRoleId) {
      return buildEphemeralResponse("No role is configured. Only server administrators can use /side.");
    }

    return buildEphemeralResponse(`The current role allowed to use /side is <@&${guildSetting.allowedRoleId}>.`);
  }

  if (timerRoleAction.action === "clear") {
    await clearGuildSetting(env, interaction.guild_id);
    return buildEphemeralResponse("Role access has been cleared. Only server administrators can use /side now.");
  }

  const roleId = timerRoleAction.roleId;
  const resolvedRole = interaction.data.resolved?.roles?.[roleId] ?? null;

  if (!resolvedRole) {
    return buildEphemeralResponse("Please choose a valid server role.");
  }

  await setGuildSetting(env, {
    guildId: interaction.guild_id,
    allowedRoleId: roleId,
    allowedRoleName: resolvedRole.name,
    updatedBy: getInteractionUserId(interaction),
    updatedAt: Date.now()
  });

  return buildEphemeralResponse(
    `Users with the role <@&${roleId}> can now use /side. Server administrators can always use it too.`
  );
}

async function handleApplicationCommand(interaction, env, ctx) {
  if (interaction.data.name === "side") {
    return handleSideCommand(interaction, env, ctx);
  }

  if (interaction.data.name === "timer") {
    return handleTimerCommand(interaction, env);
  }

  return buildEphemeralResponse("This command is not supported.");
}

async function handleButtonInteraction(interaction, env, ctx) {
  if (!interaction.member || !interaction.guild_id) {
    return buildEphemeralResponse("This button can only be used in a server.");
  }

  const buttonSelection = parseButtonSelection(interaction.data.custom_id);

  if (!buttonSelection) {
    return buildEphemeralResponse("This button is not supported.");
  }

  const nowMs = Date.now();
  const session = await ensureCurrentSessionState(env, buttonSelection.sessionId, nowMs);

  if (!session) {
    return buildEphemeralResponse("The side selection session could not be found.");
  }

  const guildSetting = await getGuildSetting(env, interaction.guild_id);
  const isAdministrator = memberIsAdministrator(interaction.member.permissions);
  const memberRoleIds = getInteractionMemberRoles(interaction);
  const allowedRoleId = guildSetting?.allowedRoleId ?? null;

  try {
    if (buttonSelection.action === "CANCEL") {
      if (
        !canCancelSideSelection({
          isAdministrator,
          memberRoleIds,
          allowedRoleId
        })
      ) {
        return buildEphemeralResponse(buildCancelPermissionError());
      }

      const cancelledSession = await cancelSession(env, buttonSelection.sessionId, getInteractionUserId(interaction), nowMs);
      ctx.waitUntil(syncAndNotify(env, cancelledSession));
      return buildSilentButtonAck();
    }

    if (
      !canControlPendingSelection({
        session,
        isAdministrator,
        memberRoleIds,
        allowedRoleId
      })
    ) {
      return buildEphemeralResponse(buildSelectionPermissionError(session));
    }

    if (buttonSelection.action === "LOCK") {
      const lockedSession = await lockSession(env, buttonSelection.sessionId, nowMs);
      ctx.waitUntil(syncAndNotify(env, lockedSession));
      return buildSilentButtonAck();
    }

    if (buttonSelection.action === "RED" || buttonSelection.action === "BLUE") {
      const updatedSession = await chooseSessionSide(
        env,
        buttonSelection.sessionId,
        buttonSelection.action,
        getInteractionUserId(interaction),
        nowMs
      );
      ctx.waitUntil(syncSessionMessage(env, updatedSession));
      return buildSilentButtonAck();
    }

    return buildEphemeralResponse("This button is not supported.");
  } catch (error) {
    if (error instanceof SessionError) {
      if (error.session) {
        ctx.waitUntil(syncAndNotify(env, error.session));
      }

      return buildEphemeralResponse(error.message);
    }

    console.error("Failed to handle the button interaction.", error);
    return buildEphemeralResponse("The side selection could not be completed due to a server error.");
  }
}

async function handleDiscordInteractions(request, env, ctx) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const body = await request.text();
  const isValid = await verifyDiscordSignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);

  if (!isValid) {
    return textResponse("Invalid request signature.", 401);
  }

  const interaction = JSON.parse(body);

  if (interaction.type === 1) {
    return jsonResponse({ type: INTERACTION_RESPONSE_TYPE.PONG });
  }

  if (interaction.type === 2) {
    return handleApplicationCommand(interaction, env, ctx);
  }

  if (interaction.type === 3) {
    return handleButtonInteraction(interaction, env, ctx);
  }

  return buildEphemeralResponse("This interaction type is not supported.");
}

async function handleGetSession(request, env, sessionId, ctx) {
  const session = await ensureCurrentSessionState(env, sessionId, Date.now());

  if (!session) {
    return withCors(jsonResponse({ error: "Session not found." }, 404));
  }

  if (session.status !== "PENDING") {
    ctx.waitUntil(syncAndNotify(env, session));
  }

  return withCors(jsonResponse(toPublicSession(session, Date.now())));
}

async function handleSelectFromWeb(request, env, sessionId, ctx) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return withCors(jsonResponse({ error: "Invalid JSON body." }, 400));
  }

  const side = String(payload?.side ?? "").toUpperCase();

  try {
    const session = await selectSession(env, sessionId, side, "web", Date.now());
    ctx.waitUntil(syncAndNotify(env, session));
    return withCors(jsonResponse(toPublicSession(session, Date.now())));
  } catch (error) {
    if (error instanceof SessionError) {
      if (error.session) {
        ctx.waitUntil(syncAndNotify(env, error.session));
      }

      return withCors(jsonResponse({ error: error.message }, error.statusCode));
    }

    console.error("Failed to select a side from the public page.", error);
    return withCors(jsonResponse({ error: "Server error." }, 500));
  }
}

async function processExpiredSessions(env) {
  const sessions = await listExpiredPendingSessions(env, Date.now(), 50);

  await Promise.all(
    sessions.map((session) =>
      syncAndNotify(env, session).catch((error) => {
        console.error(`Failed to sync an expired session ${session.id}.`, error);
      })
    )
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (request.method === "POST" && url.pathname === "/discord/interactions") {
      return handleDiscordInteractions(request, env, ctx);
    }

    const sessionMatch = /^\/api\/side\/([^/]+)$/.exec(url.pathname);
    const sessionSelectMatch = /^\/api\/side\/([^/]+)\/select$/.exec(url.pathname);

    if (request.method === "GET" && sessionMatch) {
      return handleGetSession(request, env, decodeURIComponent(sessionMatch[1]), ctx);
    }

    if (request.method === "POST" && sessionSelectMatch) {
      return handleSelectFromWeb(request, env, decodeURIComponent(sessionSelectMatch[1]), ctx);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "discord-side-selection-worker"
      });
    }

    return textResponse("Not found.", 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(processExpiredSessions(env));
  }
};
