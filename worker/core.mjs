export const VALID_SIDES = new Set(["RED", "BLUE"]);
export const DEFAULT_SIDE = "BLUE";
export const ADMINISTRATOR_PERMISSION = 0x8n;
export const EPHEMERAL_FLAG = 64;
export const INTERACTION_RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_UPDATE_MESSAGE: 6
};

const SIDE_LABELS = {
  RED: "Red Side",
  BLUE: "Blue Side"
};

const DEADLINE_TIMESTAMP_REGEX = /^<t:(\d{1,13}):([tTdDfFrR])>$/;
const DEADLINE_INTEGER_REGEX = /^\d{1,13}$/;

export class SessionError extends Error {
  constructor(message, code, statusCode, session = null) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.statusCode = statusCode;
    this.session = session;
  }
}

export function getSideLabel(side) {
  return SIDE_LABELS[side] ?? side;
}

export function parseDeadlineInput(value, defaultDurationMs, nowMs = Date.now()) {
  if (value === undefined || value === null || value === "") {
    return {
      deadlineAt: nowMs + defaultDurationMs,
      deadlineSource: "DURATION"
    };
  }

  const trimmedValue = String(value).trim();
  const timestampMatch = DEADLINE_TIMESTAMP_REGEX.exec(trimmedValue);

  if (timestampMatch) {
    const unixSeconds = Number.parseInt(timestampMatch[1], 10);

    if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) {
      throw new SessionError("Please provide a valid Discord timestamp.", "INVALID_DEADLINE", 400);
    }

    return {
      deadlineAt: unixSeconds * 1000,
      deadlineSource: "TIMESTAMP"
    };
  }

  if (DEADLINE_INTEGER_REGEX.test(trimmedValue)) {
    const numericValue = Number.parseInt(trimmedValue, 10);

    if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
      throw new SessionError("Please provide a valid Unix timestamp.", "INVALID_DEADLINE", 400);
    }

    return {
      deadlineAt: trimmedValue.length >= 12 ? numericValue : numericValue * 1000,
      deadlineSource: "TIMESTAMP"
    };
  }

  throw new SessionError(
    "Please provide a Unix timestamp like 1780480800 or a Discord timestamp like <t:1780480800:F>.",
    "INVALID_DEADLINE",
    400
  );
}

export function memberIsAdministrator(permissionsValue) {
  const permissions = permissionsValue === undefined || permissionsValue === null ? 0n : BigInt(permissionsValue);
  return (permissions & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION;
}

export function canUseSideSelection({ isAdministrator, memberRoleIds, allowedRoleId }) {
  if (isAdministrator) {
    return true;
  }

  if (!allowedRoleId) {
    return false;
  }

  return memberRoleIds.includes(allowedRoleId);
}

export function canControlPendingSelection({ session, isAdministrator, memberRoleIds, allowedRoleId }) {
  if (isAdministrator) {
    return true;
  }

  if (session?.pingRoleId) {
    return memberRoleIds.includes(session.pingRoleId);
  }

  return canUseSideSelection({ isAdministrator, memberRoleIds, allowedRoleId });
}

export function canCancelSideSelection({ isAdministrator, memberRoleIds, allowedRoleId }) {
  return canUseSideSelection({ isAdministrator, memberRoleIds, allowedRoleId });
}

export function buildSelectionUrl(publicBaseUrl, sessionId) {
  return `${String(publicBaseUrl).replace(/\/+$/, "")}/side.html?id=${encodeURIComponent(sessionId)}`;
}

function getDeadlineLabel(session) {
  return `<t:${Math.floor(session.deadlineAt / 1000)}:F>`;
}

function getRelativeDeadlineLabel(session) {
  return `<t:${Math.floor(session.deadlineAt / 1000)}:R>`;
}

function getStartedByLabel(session) {
  return session.createdBy ? `<@${session.createdBy}>` : "Unknown";
}

function getSelectedByLabel(session) {
  if (!session.selectedBy) {
    return "System";
  }

  if (session.selectedBy === "web") {
    return "Selection page";
  }

  if (/^\d+$/.test(session.selectedBy)) {
    return `<@${session.selectedBy}>`;
  }

  return session.selectedBy;
}

function getPingRoleLabel(session) {
  return session.pingRoleId ? `<@&${session.pingRoleId}>` : null;
}

function buildButtons(session, disabled) {
  const sessionId = session.id;
  const hasPendingChoice = session.status === "PENDING" && Boolean(session.selectedSide);
  const lockLabel = hasPendingChoice ? `Lock ${getSideLabel(session.selectedSide)}` : "Lock Side";

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          custom_id: `side:RED:${sessionId}`,
          label: "Red Side",
          style: disabled ? 2 : 4,
          disabled
        },
        {
          type: 2,
          custom_id: `side:BLUE:${sessionId}`,
          label: "Blue Side",
          style: disabled ? 2 : 1,
          disabled
        }
      ]
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          custom_id: `side:LOCK:${sessionId}`,
          label: lockLabel,
          style: disabled ? 2 : 3,
          disabled: disabled || !hasPendingChoice
        },
        {
          type: 2,
          custom_id: `side:CANCEL:${sessionId}`,
          label: "Cancel",
          style: 2,
          disabled
        }
      ]
    }
  ];
}

function buildPendingEmbed(session, selectionUrl) {
  const fields = [
    {
      name: "Deadline",
      value: `${getRelativeDeadlineLabel(session)}\n${getDeadlineLabel(session)}`,
      inline: false
    },
    {
      name: "Selection Page",
      value: `[Open side selection](${selectionUrl})`,
      inline: false
    },
    {
      name: "Started By",
      value: getStartedByLabel(session),
      inline: true
    }
  ];

  if (session.selectedSide) {
    fields.unshift({
      name: "Current Choice",
      value: `${getSideLabel(session.selectedSide)}\nWaiting for lock confirmation.`,
      inline: false
    });
  }

  const pingRoleLabel = getPingRoleLabel(session);

  if (pingRoleLabel) {
    fields.push({
      name: "Team",
      value: pingRoleLabel,
      inline: true
    });
  }

  return {
    title: "Side Selection",
    description: session.selectedSide
      ? "A side has been chosen. Lock it before the deadline, or the current choice will lock automatically when time runs out."
      : "Choose Red Side or Blue Side before the deadline, then confirm with Lock Side.",
    footer: {
      text: "TimesUp Tournament Timer"
    },
    timestamp: new Date(session.createdAt).toISOString(),
    fields
  };
}

function buildSelectedEmbed(session) {
  const sideLabel = getSideLabel(session.selectedSide);
  const fields = [
    { name: "Selected Side", value: sideLabel, inline: true },
    { name: "Started By", value: getStartedByLabel(session), inline: true }
  ];
  const selectedByLabel = getSelectedByLabel(session);

  if (selectedByLabel) {
    fields.push({ name: "Selected By", value: selectedByLabel, inline: true });
  }

  const pingRoleLabel = getPingRoleLabel(session);

  if (pingRoleLabel) {
    fields.push({
      name: "Team",
      value: pingRoleLabel,
      inline: true
    });
  }

  return {
    title: `${sideLabel} Selected`,
    description: "Side selection is locked.",
    color: session.selectedSide === "RED" ? 0xd73a49 : 0x1f6feb,
    footer: {
      text: "TimesUp Tournament Timer"
    },
    timestamp: new Date(session.createdAt).toISOString(),
    fields
  };
}

function buildCancelledEmbed(session) {
  const fields = [
    { name: "Started By", value: getStartedByLabel(session), inline: true },
    { name: "Cancelled By", value: getSelectedByLabel(session), inline: true }
  ];
  const pingRoleLabel = getPingRoleLabel(session);

  if (pingRoleLabel) {
    fields.push({
      name: "Team",
      value: pingRoleLabel,
      inline: true
    });
  }

  return {
    title: "Side Selection Cancelled",
    description: "This side selection has been cancelled.",
    color: 0x6b7280,
    footer: {
      text: "TimesUp Tournament Timer"
    },
    timestamp: new Date(session.createdAt).toISOString(),
    fields
  };
}

function buildExpiredEmbed(session) {
  const fields = [
    { name: "Result", value: getSideLabel(session.selectedSide || DEFAULT_SIDE), inline: true },
    { name: "Started By", value: getStartedByLabel(session), inline: true }
  ];
  const pingRoleLabel = getPingRoleLabel(session);

  if (pingRoleLabel) {
    fields.push({
      name: "Team",
      value: pingRoleLabel,
      inline: true
    });
  }

  return {
    title: "Blue Side Applied",
    description: "No side was selected before the deadline.",
    color: 0x1f6feb,
    footer: {
      text: "TimesUp Tournament Timer"
    },
    timestamp: new Date(session.createdAt).toISOString(),
    fields
  };
}

export function buildSideSelectionMessage(session, publicBaseUrl, { mentionMode = "silent" } = {}) {
  const isPending = session.status === "PENDING";
  const selectionUrl = buildSelectionUrl(publicBaseUrl, session.id);
  const embed =
    session.status === "SELECTED"
      ? buildSelectedEmbed(session)
      : session.status === "CANCELLED"
        ? buildCancelledEmbed(session)
      : session.status === "EXPIRED"
        ? buildExpiredEmbed(session)
        : buildPendingEmbed(session, selectionUrl);
  const message = {
    embeds: [embed],
    components: buildButtons(session, !isPending)
  };

  if (!session.pingRoleId) {
    return message;
  }

  message.content = `<@&${session.pingRoleId}>`;

  if (mentionMode === "ping") {
    message.allowed_mentions = {
      parse: [],
      roles: [session.pingRoleId]
    };
  } else {
    message.allowed_mentions = {
      parse: []
    };
  }

  return message;
}

export function buildResultNotification(session) {
  if (!session.createdBy) {
    return null;
  }

  const mention = `<@${session.createdBy}>`;

  if (session.status === "SELECTED") {
    return `${mention}\n- Side selected: ${getSideLabel(session.selectedSide)}`;
  }

  if (session.status === "EXPIRED") {
    return `${mention}\n- No side selected: Side by default = Blue Side`;
  }

  if (session.status === "CANCELLED") {
    return `${mention}\n- Side selection cancelled.`;
  }

  return null;
}

export function createSessionRecord({
  id = crypto.randomUUID(),
  guildId,
  channelId,
  createdBy = null,
  pingRoleId = null,
  pingRoleName = null,
  deadlineAt,
  deadlineSource = "DURATION",
  sideDurationMs,
  defaultSide = DEFAULT_SIDE,
  nowMs = Date.now()
}) {
  const normalizedDeadlineAt =
    Number.isFinite(deadlineAt) && deadlineAt > 0 ? Math.trunc(deadlineAt) : nowMs + sideDurationMs;
  const expiredImmediately = normalizedDeadlineAt <= nowMs;

  return {
    id,
    guildId,
    channelId,
    createdBy,
    pingRoleId,
    pingRoleName,
    messageId: null,
    createdAt: nowMs,
    deadlineAt: normalizedDeadlineAt,
    deadlineSource,
    selectedSide: expiredImmediately ? defaultSide : null,
    status: expiredImmediately ? "EXPIRED" : "PENDING",
    selectedBy: null,
    resolvedAt: expiredImmediately ? nowMs : null,
    starterNotifiedAt: null
  };
}

export function isExpired(session, nowMs = Date.now()) {
  return nowMs >= session.deadlineAt;
}

export function toPublicSession(session, nowMs = Date.now()) {
  const remainingMs = session.status === "PENDING" ? Math.max(0, session.deadlineAt - nowMs) : 0;

  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.deadlineAt,
    deadlineAt: session.deadlineAt,
    deadlineSource: session.deadlineSource,
    selectedSide: session.selectedSide,
    status: session.status,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    durationSeconds: Math.max(0, Math.round((session.deadlineAt - session.createdAt) / 1000))
  };
}
