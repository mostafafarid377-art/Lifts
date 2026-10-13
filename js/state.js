// ── Centralized application state ─────────────────────
// All mutable shared state lives here so modules can
// import a single reference and never get duplicate copies.
import { DC, DE, DAYS } from './config.js';

function emptySchedule(){ const s={}; DAYS.forEach(d=>{ s[d.k]=[]; }); return s; }

export const state = {
  // Categories, exercises, session data
  CATS: [...DC],
  EX: JSON.parse(JSON.stringify(DE)),
  DATA: {},
  // Muscle tracking
  MSETS: {},
  CUSTOM_MUSCLES: [],
  HIDDEN_MUSCLES: new Set(),
  // Splits
  SPLITS: [],
  activeSplitId: null,
  // Auth
  currentUser: null,
  dataLoadedUid: null,
  // Log form state
  selDay: 'all',
  selEx: null,
  selCatCtx: null,
  sets: [],
  unit: 'kg',
  modalCats: new Set(),
  authMode: 'login',
  logDateAuto: null,
  // Routines / Schedule / Workouts (Phase 1)
  ROUTINES: [],
  SCHEDULE: emptySchedule(),
  WORKOUTS: [],
  ACTIVE_WORKOUT: null,
  AW_UPDATED: 0,
  wkReturn: false,
  // Calendar (streak view)
  calMonth: 0,
  calYear: 0,
  // Save queue
  SV: null,
  loadSeq: 0,
  // Data repair/unplaced
  UNPLACED: {},
  EXTRA: {},
  REPAIR: { dropped: 0, unplaced: 0 },
  NORM_UID: null,
  // Timer state
  timer: null,
  timerEnd: 0,
  timerInterval: null,
  // Workout ticker
  wkTimer: null,
  wkLastRecord: null,
  // Toast
  toastTimer: null,
  // Body-weight editor
  wlValue: 0,
  wlUnit: 'kg',
  wlShowAll: false,
  // Export
  expRange: 'all',
  expFormat: 'csv',
  // Exercise picker
  xp: { mode: null, add: null },
  // Editing context for modals
  editCtx: { name: null, fromCatId: null },
  modalCtx: { type: null, id: null, preDay: null, replaceId: null },
  // Goal editing
  goalCtx: { name: null, unit: 'kg' },
  wgCtx: { weightKg: 0, track: null },
  // Calendars / onboarding
  onboardingDone: false,
};

export function resetPhase1(){
  state.ROUTINES = [];
  state.SCHEDULE = emptySchedule();
  state.WORKOUTS = [];
  state.ACTIVE_WORKOUT = null;
  state.AW_UPDATED = 0;
}

export { emptySchedule };
