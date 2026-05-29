const { randomUUID } = require("crypto");

const VALID_SIDES = new Set(["RED", "BLUE"]);
const SIDE_COMMAND_REGEX = /^!side(?:\s+<t:(\d{1,13}):([tTdDfFrR])>)?\s*$/i;
const SIDE_COMMAND_USAGE = "Usage: !side or !side <t:UNIX_TIMESTAMP:F>.";

class SessionError extends Error {
  constructor(message, code, statusCode, session = null) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.statusCode = statusCode;
    this.session = session;
  }
}

function parseSideCommand(messageContent, defaultDurationMs, nowMs = Date.now()) {
  const trimmedContent = messageContent.trim();

  if (!trimmedContent.toLowerCase().startsWith("!side")) {
    return null;
  }

  const match = SIDE_COMMAND_REGEX.exec(trimmedContent);

  if (!match) {
    return {
      isSideCommand: true,
      isValid: false,
      message: SIDE_COMMAND_USAGE
    };
  }

  if (!match[1]) {
    return {
      isSideCommand: true,
      isValid: true,
      deadlineAt: nowMs + defaultDurationMs,
      deadlineSource: "DURATION"
    };
  }

  const unixSeconds = Number.parseInt(match[1], 10);

  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) {
    return {
      isSideCommand: true,
      isValid: false,
      message: SIDE_COMMAND_USAGE
    };
  }

  return {
    isSideCommand: true,
    isValid: true,
    deadlineAt: unixSeconds * 1000,
    deadlineSource: "TIMESTAMP"
  };
}

class SideSelectionService {
  constructor({ store, sideDurationMs, defaultSide = "BLUE", now = () => Date.now() }) {
    this.store = store;
    this.sideDurationMs = sideDurationMs;
    this.defaultSide = defaultSide;
    this.now = now;

    if (!VALID_SIDES.has(defaultSide)) {
      throw new Error("The default side must be either RED or BLUE.");
    }
  }

  async createSession({ guildId, channelId, deadlineAt, deadlineSource = "DURATION", messageId = "" }) {
    const createdAt = this.now();
    const normalizedDeadlineAt =
      Number.isFinite(deadlineAt) && deadlineAt > 0 ? Math.trunc(deadlineAt) : createdAt + this.sideDurationMs;
    const expiredImmediately = normalizedDeadlineAt <= createdAt;

    return this.store.create({
      id: randomUUID(),
      guildId,
      channelId,
      messageId,
      createdAt,
      deadlineAt: normalizedDeadlineAt,
      deadlineSource,
      selectedSide: expiredImmediately ? this.defaultSide : null,
      status: expiredImmediately ? "EXPIRED" : "PENDING",
      selectedBy: null,
      resolvedAt: expiredImmediately ? createdAt : null
    });
  }

  async attachMessage(id, messageId) {
    const session = await this.store.update(id, (currentSession) => ({
      ...currentSession,
      messageId
    }));

    if (!session) {
      throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
    }

    return session;
  }

  async getSession(id) {
    return this.store.get(id);
  }

  async getSessionSnapshot(id) {
    const session = await this.getSessionOrThrow(id);

    if (session.status === "PENDING" && this.isExpired(session)) {
      return this.expireSession(id);
    }

    return session;
  }

  async listPendingSessions() {
    const pendingSessions = await this.store.listPending();
    const resolvedSessions = [];

    for (const session of pendingSessions) {
      if (this.isExpired(session)) {
        resolvedSessions.push(await this.expireSession(session.id));
        continue;
      }

      resolvedSessions.push(session);
    }

    return resolvedSessions;
  }

  toPublicSession(session) {
    return {
      id: session.id,
      createdAt: session.createdAt,
      deadlineAt: session.deadlineAt,
      deadlineSource: session.deadlineSource,
      selectedSide: session.selectedSide,
      status: session.status,
      remainingSeconds: this.getRemainingSeconds(session),
      durationSeconds: this.getDurationSeconds(session)
    };
  }

  getDurationSeconds(session) {
    return Math.max(0, Math.round((session.deadlineAt - session.createdAt) / 1000));
  }

  getRemainingSeconds(session) {
    if (session.status !== "PENDING") {
      return 0;
    }

    const remainingMs = session.deadlineAt - this.now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  async selectSide(id, side, selectedBy = null) {
    const normalizedSide = this.validateSide(side);
    const resolvedAt = this.now();
    let expiredSelectionError = null;

    const updatedSession = await this.store.update(id, (currentSession) => {
      if (currentSession.status === "SELECTED") {
        throw new SessionError("A side has already been selected.", "ALREADY_SELECTED", 409, currentSession);
      }

      if (currentSession.status === "EXPIRED") {
        throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, currentSession);
      }

      if (this.isExpired(currentSession, resolvedAt)) {
        expiredSelectionError = new SessionError(
          "The side selection timer has expired.",
          "EXPIRED",
          409,
          {
            ...currentSession,
            selectedSide: this.defaultSide,
            status: "EXPIRED",
            selectedBy: null,
            resolvedAt
          }
        );

        return expiredSelectionError.session;
      }

      return {
        ...currentSession,
        selectedSide: normalizedSide,
        status: "SELECTED",
        selectedBy: selectedBy || null,
        resolvedAt
      };
    });

    if (!updatedSession) {
      throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
    }

    if (expiredSelectionError) {
      throw expiredSelectionError;
    }

    return updatedSession;
  }

  async expireSession(id) {
    const resolvedAt = this.now();
    const updatedSession = await this.store.update(id, (currentSession) => {
      if (currentSession.status !== "PENDING") {
        return undefined;
      }

      if (!this.isExpired(currentSession, resolvedAt)) {
        return undefined;
      }

      return {
        ...currentSession,
        selectedSide: this.defaultSide,
        status: "EXPIRED",
        selectedBy: null,
        resolvedAt
      };
    });

    if (!updatedSession) {
      throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
    }

    return updatedSession;
  }

  async getSessionOrThrow(id) {
    const session = await this.getSession(id);

    if (!session) {
      throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
    }

    return session;
  }

  validateSide(side) {
    if (!VALID_SIDES.has(side)) {
      throw new SessionError("The selected side is invalid.", "INVALID_SIDE", 400);
    }

    return side;
  }

  isExpired(session, nowMs = this.now()) {
    return nowMs >= session.deadlineAt;
  }
}

module.exports = {
  SessionError,
  SIDE_COMMAND_USAGE,
  SideSelectionService,
  VALID_SIDES,
  parseSideCommand
};
