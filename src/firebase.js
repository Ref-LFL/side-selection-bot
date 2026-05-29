const { applicationDefault, cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function initializeFirebaseAdmin(config) {
  if (!getApps().length) {
    const hasInlineServiceAccount =
      config.firebaseProjectId && config.firebaseClientEmail && config.firebasePrivateKey;

    if (hasInlineServiceAccount) {
      initializeApp({
        credential: cert({
          projectId: config.firebaseProjectId,
          clientEmail: config.firebaseClientEmail,
          privateKey: config.firebasePrivateKey
        })
      });
    } else {
      initializeApp({
        credential: applicationDefault(),
        projectId: config.firebaseProjectId || undefined
      });
    }
  }

  return getFirestore();
}

module.exports = {
  initializeFirebaseAdmin
};
