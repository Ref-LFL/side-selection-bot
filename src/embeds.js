const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

const SIDE_LABELS = {
  RED: "Red Side",
  BLUE: "Blue Side"
};

function getSideLabel(side) {
  return SIDE_LABELS[side] ?? side;
}

function formatDurationFromMs(durationMs) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));

  if (seconds % 60 === 0) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }

  return `${seconds} seconds`;
}

function getDeadlineLabel(session) {
  return `<t:${Math.floor(session.deadlineAt / 1000)}:F>`;
}

function buildButtons(sessionId, disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`side:RED:${sessionId}`)
      .setLabel("Red Side")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`side:BLUE:${sessionId}`)
      .setLabel("Blue Side")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

function buildPendingEmbed(session, selectionUrl) {
  const description =
    session.deadlineSource === "TIMESTAMP"
      ? "A team must choose their side before the scheduled deadline."
      : `A team has ${formatDurationFromMs(session.deadlineAt - session.createdAt)} to choose their side.`;

  const timeField =
    session.deadlineSource === "TIMESTAMP"
      ? { name: "Selection deadline", value: getDeadlineLabel(session), inline: true }
      : {
          name: "Time limit",
          value: formatDurationFromMs(session.deadlineAt - session.createdAt),
          inline: true
        };

  return new EmbedBuilder()
    .setColor(0x1f6feb)
    .setTitle("Side Selection Started")
    .setDescription(description)
    .addFields(
      { name: "Status", value: "Waiting for side selection", inline: true },
      timeField,
      { name: "Default side", value: "Blue Side", inline: true },
      { name: "Selection page", value: `[Open side selection](${selectionUrl})`, inline: false }
    )
    .setTimestamp(new Date(session.createdAt));
}

function buildSelectedEmbed(session) {
  const sideLabel = getSideLabel(session.selectedSide);
  const color = session.selectedSide === "RED" ? 0xd73a49 : 0x1f6feb;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle("Side Selection Completed")
    .setDescription(`The selected side is: ${sideLabel}`)
    .addFields(
      { name: "Status", value: "Completed", inline: true },
      { name: "Selected side", value: sideLabel, inline: true }
    )
    .setTimestamp(new Date(session.createdAt));
}

function buildExpiredEmbed(session) {
  return new EmbedBuilder()
    .setColor(0x6e7681)
    .setTitle("Side Selection Expired")
    .setDescription("No answer has been given in the time given, you will play Blue Side.")
    .addFields(
      { name: "Status", value: "Expired", inline: true },
      { name: "Selected side", value: getSideLabel(session.selectedSide || "BLUE"), inline: true }
    )
    .setTimestamp(new Date(session.createdAt));
}

function buildSideSelectionMessage({ session, selectionUrl }) {
  const isPending = session.status === "PENDING";
  const embed =
    session.status === "SELECTED"
      ? buildSelectedEmbed(session)
      : session.status === "EXPIRED"
        ? buildExpiredEmbed(session)
        : buildPendingEmbed(session, selectionUrl);

  return {
    embeds: [embed],
    components: [buildButtons(session.id, !isPending)]
  };
}

module.exports = {
  buildSideSelectionMessage,
  getSideLabel
};
