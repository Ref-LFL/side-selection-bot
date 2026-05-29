import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

const countdownElement = document.getElementById("countdown");
const progressFillElement = document.getElementById("progress-fill");
const redButton = document.getElementById("red-button");
const blueButton = document.getElementById("blue-button");
const statusElement = document.getElementById("status");
const metaElement = document.getElementById("meta");

const sessionId = new URL(window.location.href).searchParams.get("id");
const firebaseConfig = window.SIDE_SELECTION_FIREBASE_CONFIG || {};
const firestoreCollectionName = firebaseConfig.collectionName || "sideSessions";

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
let unsubscribeSnapshot = null;
let db = null;
let sessionRef = null;

class SessionViewError extends Error {
  constructor(code, message, session = null) {
    super(message);
    this.name = "SessionViewError";
    this.code = code;
    this.session = session;
  }
}

function hasFirebaseConfig(config) {
  return Boolean(
    config &&
      typeof config.apiKey === "string" &&
      config.apiKey &&
      typeof config.projectId === "string" &&
      config.projectId &&
      typeof config.appId === "string" &&
      config.appId
  );
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

  if (state.status === "SELECTED") {
    return `The selected side is: ${getSideLabel(state.selectedSide)}`;
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
    metaElement.textContent = "Add your Firebase values to firebase-config.js.";
    return;
  }

  if (state.mode === "missing") {
    metaElement.textContent = "Please check the link and try again.";
    return;
  }

  metaElement.textContent = state.isSubmitting
    ? "Saving your side selection..."
    : "Choose from this page or from Discord.";
}

function normalizeSession(sessionData) {
  return {
    id: sessionData.id || sessionId,
    createdAt: Number(sessionData.createdAt) || Date.now(),
    deadlineAt: Number(sessionData.deadlineAt) || Date.now(),
    deadlineSource: sessionData.deadlineSource || "DURATION",
    selectedSide: sessionData.selectedSide ?? null,
    status: sessionData.status || "PENDING"
  };
}

function applySession(sessionData) {
  const session = normalizeSession(sessionData);

  state.createdAt = session.createdAt;
  state.deadlineAt = session.deadlineAt;
  state.deadlineSource = session.deadlineSource;
  state.selectedSide = session.selectedSide;
  state.status = session.status;
  state.durationMs = Math.max(0, session.deadlineAt - session.createdAt);
  state.mode = "ready";
  render();
}

async function refreshSession() {
  const snapshot = await getDoc(sessionRef);

  if (!snapshot.exists()) {
    state.mode = "missing";
    render();
    return null;
  }

  const session = normalizeSession(snapshot.data());
  applySession(session);
  return session;
}

async function submitSelection(side) {
  if (!sessionRef || state.isSubmitting || state.status !== "PENDING" || getRemainingMilliseconds() === 0) {
    return;
  }

  state.isSubmitting = true;
  render();

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(sessionRef);

      if (!snapshot.exists()) {
        throw new SessionViewError("NOT_FOUND", "This side selection session could not be found.");
      }

      const session = normalizeSession(snapshot.data());

      if (session.status === "SELECTED") {
        throw new SessionViewError("ALREADY_SELECTED", "A side has already been selected.", session);
      }

      if (session.status === "EXPIRED" || Date.now() >= session.deadlineAt) {
        throw new SessionViewError("EXPIRED", "The side selection timer has expired.", {
          ...session,
          selectedSide: "BLUE",
          status: "EXPIRED"
        });
      }

      transaction.update(sessionRef, {
        selectedSide: side,
        status: "SELECTED",
        selectedBy: "web",
        resolvedAt: Date.now()
      });
    });
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

function startRealtimeUpdates() {
  unsubscribeSnapshot = onSnapshot(
    sessionRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        state.mode = "missing";
        render();
        return;
      }

      applySession(snapshot.data());
    },
    () => {
      metaElement.textContent = "Connection issue. Retrying...";
    }
  );
}

async function initializePage() {
  if (!sessionId) {
    state.mode = "missing";
    render();
    return;
  }

  if (!hasFirebaseConfig(firebaseConfig)) {
    state.mode = "config-error";
    render();
    return;
  }

  const { collectionName: _collectionName, ...firebaseAppConfig } = firebaseConfig;
  const app = initializeApp(firebaseAppConfig);
  db = getFirestore(app);
  sessionRef = doc(db, firestoreCollectionName, sessionId);

  try {
    const session = await refreshSession();

    if (session) {
      startRealtimeUpdates();
    }
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
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
  }
});

startCountdown();
render();
initializePage();
