// ── Firebase initialization ──────────────────────────
// Firebase 8 compat SDKs are loaded via <script> tags in index.html
// so the global `firebase` is already available. Initialise once.
import { firebaseConfig } from './config.js';

// Guard against double-init (module re-execution, tests, etc.)
try {
  firebase.app();
} catch (_) {
  firebase.initializeApp(firebaseConfig);
}

export const auth = firebase.auth();
export const db   = firebase.firestore();
export default firebase;
