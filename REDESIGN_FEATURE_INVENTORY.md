# LIFTS redesign — feature-preservation inventory

Baseline inspection only; no production application files were modified during this phase.

## Repository and baseline

- Active branch: `arena/3409bcf6-lifts`
- Working tree was clean before inventory/prototype work.
- Architecture: single-page static HTML/CSS/vanilla JavaScript application; Firebase Authentication and Firestore persistence; Chart.js for progress visualization; no package manifest/build step.
- Existing regression suite: `node --test tests/*.test.cjs` — **21 passed, 0 failed** at baseline.
- Browser-level validation of remote Firebase sign-in/sync is not part of the current automated suite; the app source and configured integration are preserved.

## Screens, navigation, and capabilities discovered

### 1. Authentication (outside the app shell)
- Sign-in and account creation tabs; email/password; confirm password; password visibility toggles; forgot-password flow; Google sign-in; inline errors/loading; Firebase auth state.
- Dependencies: `#auth-screen`, Firebase Auth SDK/config (`js/firebase.js`, `js/config.js`), `doAuth`, `doGoogle`, `doForgot`, `doSignOut`, `switchTab`, `togglePass`.

### 2. Start / dashboard
- Current day, dashboard content, workout-start entry points, active-workout resume banner, streak banner and quick stats.
- Dependencies: `#s-start`, `#wk-banner`, streak nodes, `renderStart`, `wkStart`, navigation `go`.

### 3. Plan / schedule
- Weekly split/schedule, routine assignments, add/replace/remove day routines, routine management entry point.
- Dependencies: `#s-plan`, `#pl-week`, `#pl-routines`, day-picker modal; `renderPlan`, `dpOpen`, `dpPick`, `planRemove`.

### 4. Active workout
- Routine-based workout start, elapsed-duration ticker, planned exercise list, logged set display, add exercise, remove unlogged exercise, open exercise logger, finish confirmation, save/discard behavior, active-workout local restoration and cloud safety copies.
- Dependencies: `#s-workout`, `#wk-list`, finish modal and workout summary; `wkStart`, `renderWorkout`, `wkOpenEx`, `wkAddExercise`, `wkRemoveEx`, `wkAskFinish`, `wkFinish`, persistence/restore helpers.

### 5. Exercise logging and library
- Category filters, search, date selection, exercise picker, onboarding/default library, custom categories/exercises, kg/lb entry, set rows, reps and weights, add/remove/edit sets, save/cancel, last-session placeholders, warm-up calculator/presets.
- Dependencies: `#s-log`, category pills, picker, log form, warm-up panel; `renderPicker`, `selectEx`, `setUnit`, `addSet`, `saveLog`, `cancelLog`, `calcWarmup`, `toggleWarmup`.
- Management screen allows exercise search, categories/splits, reorder, edit/delete exercises, edit muscle associations, add category/exercise/split, and custom muscle creation.

### 6. Rest timer
- Floating timer, countdown, exercise label, presets (60/90/120/180 seconds), add 30 seconds, stop, sound/beep behavior.
- Dependencies: `#timer-bar`; `startTimer`, `setTimer`, `addTimerSeconds`, `stopTimer`, `updateTimerDisplay`, `beep`.

### 7. History
- Searchable per-exercise history and completed-workout records; workout detail expansion with sets and muscle map; return/view actions.
- Dependencies: `#s-history`, `#hlist`; `renderHistory`, `renderWorkoutHistory`, selected workout state.

### 8. Progress
- Exercise selector; personal best/goal card; stats, charts, sessions/set details; exercise-specific weight goals; personal-record celebration; workout muscle map.
- Dependencies: `#s-progress`, `#progex`, `#pgoal`, `#pstats`, `#pchart`, `#psess`, `#msets-wrap`; `renderProgress`, `renderGoal`, goal modal and `checkExerciseGoalCelebration`.

### 9. Streak and calendar
- Current/best/total workout streaks, configurable rest days, month navigation, calendar workout/rest indicators.
- Dependencies: `#s-streak`, streak summary, rest-day controls, calendar; `renderStreak`, `changeRestDays`, `calPrev`, `calNext`, `renderCal`.

### 10. Profile and settings
- Profile identity and activity stats, body-weight logging and history, body-weight goal and projected pace guidance, kg/lb selection, data export (CSV/JSON, all-time/month/custom date range), sign out.
- Dependencies: `#s-profile`, body-weight/goal modals, export controls; `renderProfile`, body stats and export functions, `doSignOut`.

### 11. Workout completion
- Duration/exercise/set/PR summary, new PR list, front/back muscle map, view workout in History, Done/return to dashboard; keyboard escape/focus handling.
- Dependencies: `#wk-summary`, `#ws-*`, `buildWorkoutMuscleCard`, `renderWorkoutPRs`, `wkSummaryView`, `wkSummaryDone`.

### 12. Shared navigation, modals, and feedback
- Five-item fixed navigation: Profile, Manage, Start, Progress, Streak; screens also include plan/workout/history/log flows.
- Exercise/category/split/routine/day-picker/goal/body-weight/export/finish modals, backdrop dismissal where implemented, toast notifications, sync status indicator, active-workout banner.
- Preserve all IDs consumed by JavaScript, inline event handlers, global action names, keyboard behavior, and state transitions.

## Data, integration, and logic contracts to preserve

- Firebase email/password and Google authentication; reset-password/sign-out; account-specific Firestore user documents.
- Local storage safety snapshots, queued saves/retries, cloud sync indicators, pending workout safety copies and active-workout restore behavior.
- Existing serialized record shapes and normalization/sanitization/migration logic in `js/app.js`, `js/state.js`, and `js/utils.js`; do not rename fields or alter backend contracts.
- Exercise/category/routine/split/schedule data, workout logs/sets, goals, body-weight logs, rest-day preferences, history, PR baseline snapshots, muscle snapshots, and custom muscles.
- Central kg/lb conversions and date/session handling; Chart.js data visualization; no framework/build system.
- Existing production files before redesign: `index.html`, `css/styles.css`, `js/app.js`, `js/config.js`, `js/firebase.js`, `js/state.js`, `js/utils.js`, `js/modules/bodymap.data.js`; existing regression test `tests/body-map.test.cjs`.

## Preservation checklist for a later approved implementation

- [ ] Keep every screen, navigation route, modal, visible control, and action above.
- [ ] Keep every existing element ID used by JavaScript and all handlers/action names.
- [ ] Keep auth providers, Firestore schema, sync, local backup/restore, and account isolation.
- [ ] Keep workouts, plans, routines, exercise/category editing, sets, dates, units, warm-ups, timer and rest-day settings.
- [ ] Keep history, PR rules/celebrations, goals, charts, stats, body-weight, streaks, muscle maps, export, and profile actions.
- [ ] Run existing regression tests and add/perform focused feature checks; do not claim untested remote backend/browser flows.
- [ ] Compare production screens against this inventory before reporting completion.

## Current known validation gaps

- Baseline automated coverage is concentrated on workout/muscle-map and app initialization behavior.
- No browser automation or live Firebase credentials were exercised; authentication, cloud round-trips, timer sound, visual responsiveness, and export download UX remain unverified in this baseline check.
- No known regression failure was reported by the baseline suite.
