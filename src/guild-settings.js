const TIMER_ROLE_COMMAND_USAGE =
  "Usage: !timer role view, !timer role clear, or !timer role @Role.";

function extractRoleIdFromMention(roleMention) {
  const match = /^<@&(\d+)>$/.exec(roleMention);
  return match ? match[1] : null;
}

function parseTimerRoleCommand(messageContent) {
  const trimmedContent = messageContent.trim();

  if (!trimmedContent.toLowerCase().startsWith("!timer")) {
    return null;
  }

  if (/^!timer\s+role\s+view\s*$/i.test(trimmedContent)) {
    return {
      isTimerCommand: true,
      isValid: true,
      action: "view"
    };
  }

  if (/^!timer\s+role\s+clear\s*$/i.test(trimmedContent)) {
    return {
      isTimerCommand: true,
      isValid: true,
      action: "clear"
    };
  }

  const setMatch = /^!timer\s+role\s*:?\s*(<@&\d+>)(?:\s+allow\s+to\s+use(?:d)?)?\s*$/i.exec(
    trimmedContent
  );

  if (setMatch) {
    return {
      isTimerCommand: true,
      isValid: true,
      action: "set",
      roleId: extractRoleIdFromMention(setMatch[1])
    };
  }

  return {
    isTimerCommand: true,
    isValid: false,
    message: TIMER_ROLE_COMMAND_USAGE
  };
}

function canUseSideSelection({ isAdministrator, memberRoleIds, allowedRoleId }) {
  if (isAdministrator) {
    return true;
  }

  if (!allowedRoleId) {
    return false;
  }

  return memberRoleIds.includes(allowedRoleId);
}

class GuildSettingsService {
  constructor({ store }) {
    this.store = store;
  }

  async getGuildSetting(guildId) {
    return this.store.get(guildId);
  }

  async setAllowedRole({ guildId, roleId, roleName, updatedBy, updatedAt = Date.now() }) {
    return this.store.save({
      guildId,
      allowedRoleId: roleId,
      allowedRoleName: roleName,
      updatedBy,
      updatedAt
    });
  }

  async clearAllowedRole(guildId) {
    await this.store.delete(guildId);
  }
}

module.exports = {
  GuildSettingsService,
  TIMER_ROLE_COMMAND_USAGE,
  canUseSideSelection,
  extractRoleIdFromMention,
  parseTimerRoleCommand
};
