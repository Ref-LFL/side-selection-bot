const countdownElement = document.getElementById("countdown");
const progressFillElement = document.getElementById("progress-fill");
const redButton = document.getElementById("red-button");
const blueButton = document.getElementById("blue-button");
const statusElement = document.getElementById("status");
const metaElement = document.getElementById("meta");

const sessionId = new URL(window.location.href).searchParams.get("id");
const sideSelectionConfig = window.SIDE_SELECTION_CONFIG || {};
const apiBaseUrl = typeof sideSelectionConfig.apiBaseUrl === "string" ? sideSelectionConfig.apiBaseUrl.replace(/\/+$/, "") : "";

const state = {
  createdAt: Date.now(),
  deadlineAt: Date.now() + 300000,
  selectedSide: null,
  status: "PENDING",
  durationMs: 300000,
  deadlineSource: "DURATION",
  isSubmitting: false,
  mode: "loading"
};

let countdownIntervalId = null;
let pollIntervalId = null;

class SessionViewError extends Error {
  constructor(code, message, session = null) {
    super(message);
    this.name = "SessionViewError";
    this.code = code;
    this.session = session;
  }
}

function hasApiConfig() {
  return Boolean(apiBaseUrl);
}

function getSideLabel(side) {
  return side === "RED" ? "Red Side" : "Blue Side";
}

function getRemainingMilliseconds() {
  if (state.status !== "PENDING") {
    return 0;
  }

  return Math.max(0, state.deadlineAt - Date.now());
}

function getStatusMessage() {
  if (state.mode === "loading") {
    return "Waiting for side selection...";
  }

  if (state.mode === "config-error") {
    return "This page is not configured yet.";
  }

  if (state.mode === "missing") {
    return "This side selection session could not be found.";
  }

  if (state.status === "CANCELLED") {
    return "This side selection has been cancelled.";
  }

  if (state.status === "SELECTED") {
    return `The selected side is: ${getSideLabel(state.selectedSide)}`;
  }

  if (state.status === "PENDING" && state.selectedSide) {
    return `Current choice: ${getSideLabel(state.selectedSide)}. Waiting for lock confirmation.`;
  }

  if (state.status === "EXPIRED" || getRemainingMilliseconds() === 0) {
    return "No answer has been given in the time given, you will play Blue Side.";
  }

  return "Waiting for side selection...";
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      seconds
    ).padStart(2, "0")}`;
  }

  if (totalSeconds >= 3600) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      seconds
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function render() {
  const remainingMilliseconds = getRemainingMilliseconds();
  const progressRatio = state.durationMs > 0 ? remainingMilliseconds / state.durationMs : 0;
  const isLocked =
    state.mode === "loading" ||
    state.mode === "config-error" ||
    state.mode === "missing" ||
    state.isSubmitting ||
    state.status !== "PENDING" ||
    remainingMilliseconds === 0;

  countdownElement.textContent = formatCountdown(remainingMilliseconds);
  progressFillElement.style.transform = `scaleX(${Math.max(0, Math.min(1, progressRatio))})`;
  redButton.disabled = isLocked;
  blueButton.disabled = isLocked;
  statusElement.textContent = getStatusMessage();

  if (state.mode === "loading") {
    metaElement.textContent = "Loading side selection...";
    return;
  }

  if (state.mode === "config-error") {
    metaElement.textContent = "Add your Worker URL to side-config.js.";
    return;
  }

  if (state.mode === "missing") {
    metaElement.textContent = "Please check the link and try again.";
    return;
  }

  if (state.status === "CANCELLED") {
    metaElement.textContent = "Selection is closed.";
    return;
  }

  metaElement.textContent = state.isSubmitting
    ? "Saving your side selection..."
    : state.selectedSide && state.status === "PENDING"
      ? "The current choice can still change until it is locked or the timer ends."
      : "Choose from this page or from Discord.";
}

function normalizeSession(sessionData) {
  return {
    id: sessionData.id || sessionId,
    createdAt: Number(sessionData.createdAt) || Date.now(),
    deadlineAt: Number(sessionData.deadlineAt || sessionData.expiresAt) || Date.now(),
    deadlineSource: sessionData.deadlineSource || "DURATION",
    selectedSide: sessionData.selectedSide ?? null,
    status: sessionData.status || "PENDING",
    durationSeconds: Number(sessionData.durationSeconds) || 300
  };
}

function applySession(sessionData) {
  const session = normalizeSession(sessionData);

  state.createdAt = session.createdAt;
  state.deadlineAt = session.deadlineAt;
  state.deadlineSource = session.deadlineSource;
  state.selectedSide = session.selectedSide;
  state.status = session.status;
  state.durationMs = Math.max(0, session.durationSeconds * 1000 || session.deadlineAt - session.createdAt);
  state.mode = "ready";

  if (state.status === "PENDING") {
    startPolling();
  } else {
    stopPolling();
  }

  render();
}

async function refreshSession() {
  const response = await fetch(`${apiBaseUrl}/api/side/${encodeURIComponent(sessionId)}`, {
    cache: "no-store"
  });

  if (response.status === 404) {
    state.mode = "missing";
    stopPolling();
    render();
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch the session: ${response.status}`);
  }

  const session = normalizeSession(await response.json());
  applySession(session);
  return session;
}

async function submitSelection(side) {
  if (!sessionId || state.isSubmitting || state.status !== "PENDING" || getRemainingMilliseconds() === 0) {
    return;
  }

  state.isSubmitting = true;
  render();

  try {
    const response = await fetch(`${apiBaseUrl}/api/side/${encodeURIComponent(sessionId)}/select`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        side
      })
    });

    if (response.status === 404) {
      throw new SessionViewError("NOT_FOUND", "This side selection session could not be found.");
    }

    if (response.status === 409) {
      const latestSession = await refreshSession();

      if (latestSession?.status === "SELECTED") {
        throw new SessionViewError("ALREADY_SELECTED", "A side has already been selected.", latestSession);
      }

      throw new SessionViewError("EXPIRED", "The side selection timer has expired.", latestSession);
    }

    if (!response.ok) {
      throw new Error(`Failed to submit the selection: ${response.status}`);
    }

    applySession(await response.json());
  } catch (error) {
    if (error instanceof SessionViewError) {
      if (error.code === "NOT_FOUND") {
        state.mode = "missing";
        render();
        return;
      }

      if (error.session) {
        applySession(error.session);
      } else {
        await refreshSession();
      }

      return;
    }

    await refreshSession().catch(() => {
      metaElement.textContent = "Connection issue. Please try again.";
    });
  } finally {
    state.isSubmitting = false;
    render();
  }
}

function startCountdown() {
  if (countdownIntervalId) {
    return;
  }

  countdownIntervalId = window.setInterval(() => {
    render();
  }, 1000);
}

function startPolling() {
  if (pollIntervalId) {
    return;
  }

  pollIntervalId = window.setInterval(() => {
    refreshSession().catch(() => {
      metaElement.textContent = "Connection issue. Retrying...";
    });
  }, 2000);
}

function stopPolling() {
  if (!pollIntervalId) {
    return;
  }

  window.clearInterval(pollIntervalId);
  pollIntervalId = null;
}

async function initializePage() {
  if (!sessionId) {
    state.mode = "missing";
    stopPolling();
    render();
    return;
  }

  if (!hasApiConfig()) {
    state.mode = "config-error";
    stopPolling();
    render();
    return;
  }

  try {
    await refreshSession();
  } catch (error) {
    metaElement.textContent = "Connection issue. Retrying...";
  }
}

redButton.addEventListener("click", () => {
  submitSelection("RED");
});

blueButton.addEventListener("click", () => {
  submitSelection("BLUE");
});

window.addEventListener("beforeunload", () => {
  stopPolling();
});

startCountdown();
render();
initializePage();
