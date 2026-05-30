import { DEFAULT_SIDE, SessionError, VALID_SIDES, isExpired } from "./core.mjs";

function mapSessionRecord(record) {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    guildId: record.guild_id,
    channelId: record.channel_id,
    createdBy: record.created_by,
    pingRoleId: record.ping_role_id,
    pingRoleName: record.ping_role_name,
    messageId: record.message_id,
    createdAt: Number(record.created_at),
    deadlineAt: Number(record.deadline_at),
    deadlineSource: record.deadline_source,
    selectedSide: record.selected_side,
    status: record.status,
    selectedBy: record.selected_by,
    resolvedAt: record.resolved_at === null ? null : Number(record.resolved_at),
    starterNotifiedAt: record.starter_notified_at === null ? null : Number(record.starter_notified_at)
  };
}

function mapGuildSettingRecord(record) {
  if (!record) {
    return null;
  }

  return {
    guildId: record.guild_id,
    allowedRoleId: record.allowed_role_id,
    allowedRoleName: record.allowed_role_name,
    updatedBy: record.updated_by,
    updatedAt: Number(record.updated_at)
  };
}

function getChangeCount(result) {
  return Number(result?.meta?.changes ?? 0);
}

export async function createSession(env, session) {
  await env.DB.prepare(
    `INSERT INTO sessions (
      id,
      guild_id,
      channel_id,
      created_by,
      ping_role_id,
      ping_role_name,
      message_id,
      created_at,
      deadline_at,
      deadline_source,
      selected_side,
      status,
      selected_by,
      resolved_at,
      starter_notified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.id,
      session.guildId,
      session.channelId,
      session.createdBy,
      session.pingRoleId,
      session.pingRoleName,
      session.messageId,
      session.createdAt,
      session.deadlineAt,
      session.deadlineSource,
      session.selectedSide,
      session.status,
      session.selectedBy,
      session.resolvedAt,
      session.starterNotifiedAt
    )
    .run();

  return session;
}

export async function getSession(env, id) {
  const record = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  return mapSessionRecord(record);
}

export async function updateSessionMessageId(env, id, messageId) {
  await env.DB.prepare("UPDATE sessions SET message_id = ? WHERE id = ?").bind(messageId, id).run();
}

export async function getGuildSetting(env, guildId) {
  const record = await env.DB.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").bind(guildId).first();
  return mapGuildSettingRecord(record);
}

export async function setGuildSetting(env, setting) {
  await env.DB.prepare(
    `INSERT INTO guild_settings (
      guild_id,
      allowed_role_id,
      allowed_role_name,
      updated_by,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      allowed_role_id = excluded.allowed_role_id,
      allowed_role_name = excluded.allowed_role_name,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`
  )
    .bind(setting.guildId, setting.allowedRoleId, setting.allowedRoleName, setting.updatedBy, setting.updatedAt)
    .run();

  return setting;
}

export async function clearGuildSetting(env, guildId) {
  await env.DB.prepare("DELETE FROM guild_settings WHERE guild_id = ?").bind(guildId).run();
}

export async function chooseSessionSide(env, id, side, selectedBy, nowMs = Date.now()) {
  if (!VALID_SIDES.has(side)) {
    throw new SessionError("The selected side is invalid.", "INVALID_SIDE", 400);
  }

  const selectionResult = await env.DB.prepare(
    `UPDATE sessions
      SET selected_side = ?, selected_by = ?
      WHERE id = ? AND status = 'PENDING' AND deadline_at > ?`
  )
    .bind(side, selectedBy, id, nowMs)
    .run();

  if (getChangeCount(selectionResult) > 0) {
    return getSession(env, id);
  }

  const currentSession = await getSession(env, id);

  if (!currentSession) {
    throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
  }

  if (currentSession.status === "PENDING" && isExpired(currentSession, nowMs)) {
    const expiredSession = await expireSession(env, id, nowMs);
    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, expiredSession);
  }

  if (currentSession.status === "SELECTED") {
    throw new SessionError("A side has already been locked.", "ALREADY_SELECTED", 409, currentSession);
  }

  if (currentSession.status === "EXPIRED") {
    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, currentSession);
  }

  if (currentSession.status === "CANCELLED") {
    throw new SessionError("This side selection has been cancelled.", "CANCELLED", 409, currentSession);
  }

  throw new SessionError("The side selection could not be updated.", "UPDATE_FAILED", 500, currentSession);
}

export async function lockSession(env, id, nowMs = Date.now()) {
  const lockResult = await env.DB.prepare(
    `UPDATE sessions
      SET status = 'SELECTED', resolved_at = ?
      WHERE id = ? AND status = 'PENDING' AND deadline_at > ? AND selected_side IS NOT NULL`
  )
    .bind(nowMs, id, nowMs)
    .run();

  if (getChangeCount(lockResult) > 0) {
    return getSession(env, id);
  }

  const currentSession = await getSession(env, id);

  if (!currentSession) {
    throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
  }

  if (currentSession.status === "PENDING" && isExpired(currentSession, nowMs)) {
    const expiredSession = await expireSession(env, id, nowMs);
    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, expiredSession);
  }

  if (currentSession.status === "PENDING" && !currentSession.selectedSide) {
    throw new SessionError("Choose a side before locking it.", "NO_SIDE_SELECTED", 409, currentSession);
  }

  if (currentSession.status === "SELECTED") {
    throw new SessionError("A side has already been locked.", "ALREADY_SELECTED", 409, currentSession);
  }

  if (currentSession.status === "EXPIRED") {
    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, currentSession);
  }

  if (currentSession.status === "CANCELLED") {
    throw new SessionError("This side selection has been cancelled.", "CANCELLED", 409, currentSession);
  }

  throw new SessionError("The side selection could not be locked.", "UPDATE_FAILED", 500, currentSession);
}

export async function cancelSession(env, id, cancelledBy, nowMs = Date.now()) {
  const cancelResult = await env.DB.prepare(
    `UPDATE sessions
      SET selected_side = NULL, status = 'CANCELLED', selected_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'PENDING' AND deadline_at > ?`
  )
    .bind(cancelledBy, nowMs, id, nowMs)
    .run();

  if (getChangeCount(cancelResult) > 0) {
    return getSession(env, id);
  }

  const currentSession = await getSession(env, id);

  if (!currentSession) {
    throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
  }

  if (currentSession.status === "CANCELLED") {
    throw new SessionError("This side selection has already been cancelled.", "ALREADY_CANCELLED", 409, currentSession);
  }

  if (currentSession.status === "SELECTED") {
    throw new SessionError("A side has already been locked.", "ALREADY_SELECTED", 409, currentSession);
  }

  if (currentSession.status === "EXPIRED" || isExpired(currentSession, nowMs)) {
    const expiredSession =
      currentSession.status === "PENDING" ? await expireSession(env, id, nowMs) : currentSession;
    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, expiredSession);
  }

  throw new SessionError("The side selection could not be cancelled.", "UPDATE_FAILED", 500, currentSession);
}

export async function selectSession(env, id, side, selectedBy, nowMs = Date.now()) {
  if (!VALID_SIDES.has(side)) {
    throw new SessionError("The selected side is invalid.", "INVALID_SIDE", 400);
  }

  const selectionResult = await env.DB.prepare(
    `UPDATE sessions
      SET selected_side = ?, status = 'SELECTED', selected_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'PENDING' AND deadline_at > ?`
  )
    .bind(side, selectedBy, nowMs, id, nowMs)
    .run();

  if (getChangeCount(selectionResult) > 0) {
    return getSession(env, id);
  }

  const expiredResult = await env.DB.prepare(
    `UPDATE sessions
      SET selected_side = ?, status = 'EXPIRED', selected_by = NULL, resolved_at = ?
      WHERE id = ? AND status = 'PENDING' AND deadline_at <= ?`
  )
    .bind(DEFAULT_SIDE, nowMs, id, nowMs)
    .run();

  if (getChangeCount(expiredResult) > 0) {
    const expiredSession = await getSession(env, id);
    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, expiredSession);
  }

  const currentSession = await getSession(env, id);

  if (!currentSession) {
    throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
  }

  if (currentSession.status === "SELECTED") {
    throw new SessionError("A side has already been selected.", "ALREADY_SELECTED", 409, currentSession);
  }

  if (currentSession.status === "CANCELLED") {
    throw new SessionError("This side selection has been cancelled.", "CANCELLED", 409, currentSession);
  }

  if (currentSession.status === "EXPIRED" || isExpired(currentSession, nowMs)) {
    if (currentSession.status === "PENDING") {
      return expireSession(env, id, nowMs);
    }

    throw new SessionError("The side selection timer has expired.", "EXPIRED", 409, currentSession);
  }

  throw new SessionError("The side selection could not be completed.", "UPDATE_FAILED", 500, currentSession);
}

export async function expireSession(env, id, nowMs = Date.now()) {
  const result = await env.DB.prepare(
    `UPDATE sessions
      SET selected_side = COALESCE(selected_side, ?),
          status = CASE WHEN selected_side IS NULL THEN 'EXPIRED' ELSE 'SELECTED' END,
          resolved_at = ?
      WHERE id = ? AND status = 'PENDING' AND deadline_at <= ?`
  )
    .bind(DEFAULT_SIDE, nowMs, id, nowMs)
    .run();

  const session = await getSession(env, id);

  if (!session) {
    throw new SessionError("The side selection session could not be found.", "NOT_FOUND", 404);
  }

  if (getChangeCount(result) === 0 && session.status === "PENDING" && !isExpired(session, nowMs)) {
    return session;
  }

  return session;
}

export async function ensureCurrentSessionState(env, id, nowMs = Date.now()) {
  const session = await getSession(env, id);

  if (!session) {
    return null;
  }

  if (session.status === "PENDING" && isExpired(session, nowMs)) {
    return expireSession(env, id, nowMs);
  }

  return session;
}

export async function listExpiredPendingSessions(env, nowMs = Date.now(), limit = 50) {
  const result = await env.DB.prepare(
    "SELECT id FROM sessions WHERE status = 'PENDING' AND deadline_at <= ? ORDER BY deadline_at ASC LIMIT ?"
  )
    .bind(nowMs, limit)
    .all();

  const rows = Array.isArray(result.results) ? result.results : [];
  const sessions = [];

  for (const row of rows) {
    sessions.push(await expireSession(env, row.id, nowMs));
  }

  return sessions;
}

export async function markStarterNotified(env, id, nowMs = Date.now()) {
  const result = await env.DB.prepare(
    "UPDATE sessions SET starter_notified_at = ? WHERE id = ? AND starter_notified_at IS NULL"
  )
    .bind(nowMs, id)
    .run();

  return getChangeCount(result) > 0;
}
