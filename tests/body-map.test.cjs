const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Tests run against the concatenated JS bundle so they don't require
// a browser or ES-module loader. All source files are plain scripts executed
// in order within a shared VM context.
const ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

function stripModuleSyntax(src){
  // Remove any import lines and strip the export keyword so the code can run
  // as a classic script in vm. Multi-line import blocks are handled by removing
  // lines from an `import` keyword up to the matching terminating `;`.
  const lines = src.split('\n');
  const out = [];
  let inImport = false;
  for (const line of lines) {
    if (inImport) {
      if (line.includes(';')) inImport = false;
      continue;
    }
    if (/^\s*import[\s{]/.test(line)) {
      if (!line.includes(';')) inImport = true;
      continue;
    }
    out.push(line.replace(/^\s*export\s+default\s+/, '').replace(/^\s*export\s+/, ''));
  }
  return out.join('\n');
}

function loadBodymap(){
  const raw = read('js/modules/bodymap.data.js');
  return 'const BM_DATA = ' + stripModuleSyntax(raw);
}

// app.js embeds its own defaults (DC, DE, DAYS, KG_PER_LB, …) just like the
// original single-file app, so we only prepend BM_DATA and a Firebase shim.
const firebaseShim = `
function _noop(){}
var _fakeAuth = { onAuthStateChanged: _noop, signInWithEmailAndPassword: _noop, createUserWithEmailAndPassword: _noop, signInWithPopup: _noop, signOut: _noop, sendPasswordResetEmail: _noop, currentUser:null };
var _fakeDb = { collection: () => ({ doc: () => ({ get: async () => ({ exists:false, data: () => ({}) }), set: async () => ({}) }) }) };
var firebase = { initializeApp: _noop, app: () => ({}), auth: () => _fakeAuth, firestore: () => _fakeDb };
firebase.auth.GoogleAuthProvider = function(){ this.setCustomParameters = _noop; };
function installErrorHandler(){}
`;

const appSrc = stripModuleSyntax(read('js/app.js'))
  // strip the expose/_expose/boot block at the end
  .replace(/\n\/\/ ── Expose public API[\s\S]*$/, '');

const script = [loadBodymap(), firebaseShim, appSrc].join('\n');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(' ').filter(n => n !== name).join(' '); },
      toggle: name => {
        const has = this.classList.contains(name);
        this.classList[has ? 'remove' : 'add'](name);
        return !has;
      }
    };
  }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  prepend(node) { this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
  querySelector(selector) {
    if (selector === 'svg' && this.innerHTML.includes('<svg ')) return new Element('svg');
    return null;
  }
}

function app() {
  const nodes = new Map();
  const storage = new Map();
  const document = {
    createElement: tag => new Element(tag),
    getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => []
  };
  // Provide a minimal DOMParser stub so appendTrustedSvg does not crash.
  class FakeDoc {
    constructor() { this.documentElement = { localName:'svg', children:[], attributes:[], getElementsByTagName:()=>[] }; }
  }
  class DOMParser { parseFromString(){ return new FakeDoc(); } }
  const context = vm.createContext({
    console,
    document,
    DOMParser,
    window: { addEventListener() {}, scrollTo() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    firebase: {
      initializeApp() {},
      auth: () => ({ onAuthStateChanged() {} }),
      firestore: () => ({}),
      auth: { GoogleAuthProvider: function(){} }
    },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {}
  });
  vm.runInContext(script, context, { filename: 'app.js' });
  const api = vm.runInContext('({inferWorkoutMuscles,workoutMuscleSets,buildBodyMap,buildWorkoutMuscleCard,bmLevel,wkFinish,p1SwitchUser,normWorkout,workoutMusclesFor,workoutNewPRs,wkCapturePRBaseline,renderWorkoutPRs,p1OnExerciseRenamed,openAddExModal,saveEx,openEditExModal,saveEditEx,getExMuscles,setExMuscles,sanitizeData})', context);
  return { api, context, nodes, storage, run: code => vm.runInContext(code, context) };
}

const plain = value => JSON.parse(JSON.stringify(value));
const sets = (n, unit = 'kg', weight = 50) => Array.from({ length: n }, () => ({ weight, reps: 10, unit }));
const exercise = (name, n, cat = 'other') => ({ name, cat, sets: sets(n) });

function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].join(' ');
}

test('the complete application script parses and initializes', () => {
  assert.ok(script);
  assert.doesNotThrow(() => app());
});

test('every exercise in the existing default library has a muscle mapping', () => {
  const { run } = app();
  const unmapped = plain(run('[...new Set(Object.values(DE).flat())].filter(name=>!inferWorkoutMuscles(name,"other").length)'));
  assert.deepEqual(unmapped, []);
});

test('specific exercises take precedence over broad name rules, including singular presses', () => {
  const { api } = app();
  const cases = [
    ['Shoulder Press Machine', ['frontdelts', 'sidedelts', 'triceps']],
    ['Dumbbell Chest Press', ['chest', 'frontdelts', 'triceps']],
    ['Incline DB Press', ['chest', 'frontdelts', 'triceps']],
    ['Leg Press', ['quads', 'glutes']],
    ['Cable Lat Pulldown Full Range Of Motion', ['lats', 'biceps']],
    ['Barbell Bent Over Row', ['lats', 'reardelts', 'biceps']],
    ['Reverse Pec Deck', ['reardelts', 'traps']],
    ['Face Pull', ['reardelts', 'traps']],
    ['Lying Leg Curl', ['hamstrings']],
    ['Reverse Curl', ['forearms', 'biceps']],
    ['Bench Dips', ['triceps']],
    ['Upright Row', ['sidedelts', 'traps']],
    ['Straight-arm Pulldown', ['lats']],
    ['Romanian Deadlift', ['hamstrings', 'glutes', 'lowerback']],
    ['Cable Fly', ['chest']],
    ['Hip Adduction', ['adductors']],
    ['Crunch', ['abs']],
    ['  PUSH-UPS  ', ['chest', 'frontdelts', 'triceps']]
  ];
  for (const [name, expected] of cases) {
    assert.deepEqual(plain(api.inferWorkoutMuscles(name, 'other')), expected, name);
  }
});

test('custom lifts use muscle-specific category labels, not entire Push/Pull/Legs splits', () => {
  const { api, run } = app();
  run('CATS.push({id:"custom_chest",label:"Chest",color:"#fff"})');
  assert.deepEqual(plain(api.inferWorkoutMuscles('My custom lift', 'custom_chest')), ['chest']);
  assert.deepEqual(plain(api.inferWorkoutMuscles('My custom lift', 'Rear Delts')), ['reardelts']);
  assert.deepEqual(plain(api.inferWorkoutMuscles('My custom lift', 'Quadriceps')), ['quads']);
  for (const cat of ['push', 'pull', 'legs', 'upper', 'other', 'Constructor', 'toString']) {
    assert.deepEqual(plain(api.inferWorkoutMuscles('My custom lift', cat)), [], cat);
  }
});

test('only this workout’s logged sets contribute, regardless of history, manual totals or units', () => {
  const { api, run } = app();
  run('MSETS={chest:99,biceps:88}; DATA={"Bench Press":[{date:"2026-10-13",cat:"push",sets:[{weight:50,reps:10}]}]}');
  const workout = { exercises: [
    exercise('Bench Press', 3, 'push'),
    exercise('Pec Deck', 2, 'push'),
    { name: 'Triceps Pushdown', cat: 'push', sets: sets(4, 'lb', 100) },
    exercise('Squat', 0, 'legs')
  ] };
  assert.deepEqual(plain(api.workoutMuscleSets(workout)), {
    counts: { chest: 5, frontdelts: 3, triceps: 7 }, unmapped: []
  });
  assert.deepEqual(plain(run('MSETS')), { chest: 99, biceps: 88 });
  assert.deepEqual(plain(api.workoutMuscleSets({ exercises: [exercise('Preacher Curl', 1)] })), {
    counts: { biceps: 1 }, unmapped: []
  });
});

test('empty, malformed and unlogged entries are ignored, while zero-weight bodyweight sets count', () => {
  const { api } = app();
  assert.deepEqual(plain(api.workoutMuscleSets(null)), { counts: {}, unmapped: [] });
  assert.deepEqual(plain(api.workoutMuscleSets({ exercises: {} })), { counts: {}, unmapped: [] });
  const workout = { exercises: [
    null,
    { name: 'Squat' },
    exercise('Leg Curl', 0),
    { name: 'Bench Press', sets: [{ weight: NaN, reps: 10 }, { weight: 50 }, { weight: -1, reps: 10 }, { weight: 10, reps: 0 }] },
    { name: 'Push Ups', sets: sets(2, 'kg', 0) }
  ] };
  assert.deepEqual(plain(api.workoutMuscleSets(workout)), {
    counts: { chest: 2, frontdelts: 2, triceps: 2 }, unmapped: []
  });
});

test('unknown exercises are reported honestly and their names are rendered only as text', () => {
  const { api } = app();
  const name = '<img src=x onerror=alert(1)>';
  const workout = { exercises: [exercise(name, 2), exercise(name, 1)] };
  assert.deepEqual(plain(api.workoutMuscleSets(workout)), { counts: {}, unmapped: [name] });
  const card = api.buildWorkoutMuscleCard(workout);
  assert.match(textOf(card), /No muscle matches yet/);
  const note = card.children.find(node => node.className.includes('wk-muscle-unmapped'));
  assert.ok(note.textContent.includes(name));
  assert.equal(note.innerHTML, '');
});

test('saved muscle snapshots survive exercise renames and normalization', () => {
  const { api } = app();
  const record = {
    id: 'w_snapshot', date: '2026-10-13', name: 'Push Day',
    exercises: [{ name: 'Renamed custom lift', cat: 'deleted_category', muscles: ['chest', 'chest', 'invalid', 'triceps'], sets: sets(3) }]
  };
  const loaded = api.normWorkout(plain(record));
  assert.deepEqual(plain(api.workoutMuscleSets(loaded)), {
    counts: { chest: 3, triceps: 3 }, unmapped: []
  });
  assert.deepEqual(plain(api.workoutMusclesFor({ name: 'Bench Press', muscles: [] })), []);
  assert.deepEqual(plain(api.workoutMusclesFor({ name: 'Bench Press' })), ['chest', 'frontdelts', 'triceps']);
});

test('a same-named exercise logged in two categories contributes both sets, not other sessions', () => {
  const { api } = app();
  assert.deepEqual(plain(api.workoutMuscleSets({ exercises: [
    exercise('Bench Press', 2, 'push'), exercise('Bench Press', 3, 'upper')
  ] })), { counts: { chest: 5, frontdelts: 5, triceps: 5 }, unmapped: [] });
});

test('heat levels are finite and bounded, including neutral and empty states', () => {
  const { api } = app();
  for (const [count, max, level] of [[0, 4, 0], [-1, 4, 0], [1, 4, 1], [2, 4, 2], [3, 4, 3], [4, 4, 4], [10, 4, 4], [3, 0, 4], [NaN, 4, 0]]) {
    assert.equal(api.bmLevel(count, max), level);
  }
});

test('every front/back map has unique gradient ids, even when Progress is hidden', () => {
  const { api } = app();
  const maps = [api.buildBodyMap({ frontdelts: 20 }, 20), api.buildBodyMap({ sidedelts: 3 }, 3, true), api.buildBodyMap({}, 1, true)];
  const ids = maps.flatMap(map => [...map.innerHTML.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]));
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, ids.length);
  for (const map of maps) {
    const own = new Set([...map.innerHTML.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]));
    for (const [, ref] of map.innerHTML.matchAll(/url\(#([^)]+)\)/g)) assert.ok(own.has(ref));
    assert.ok(map.innerHTML.includes('<span>Front</span><span>Back</span>'));
  }
  assert.ok(maps[1].innerHTML.includes('No sets'));
  assert.ok(maps[1].innerHTML.includes('More sets'));
  assert.ok(maps[0].innerHTML.includes('#e8ff47'));
  assert.ok(maps[1].innerHTML.includes('#3bd65e'));
  assert.ok(!maps[1].innerHTML.includes('#e8ff47'));
});

test('finishing a workout shows a session map and backs up its muscle snapshots', () => {
  const { api, run, nodes, storage } = app();
  run(`
    currentUser={uid:'test-user'};
    MSETS={chest:99};
    ACTIVE_WORKOUT={
      id:'w_test',routineId:null,routineName:'Push Day',date:'2026-10-13',startedAt:Date.now()-2700000,
      prBefore:{'Bench Press':{weight:40,reps:10,unit:'kg'}},
      exercises:[{name:'Bench Press',cat:'push'},{name:'Squat',cat:'legs'}],
      logged:{'Bench Press':{cat:'push',sets:[{weight:50,reps:10,unit:'kg'},{weight:50,reps:8,unit:'kg'}]}}
    };
  `);
  api.wkFinish();
  const record = plain(run('WORKOUTS[0]'));
  assert.equal(record.exercises.length, 1);
  assert.deepEqual(record.prs, [{ name: 'Bench Press', weight: 50, reps: 10, unit: 'kg' }]);
  assert.equal(nodes.get('ws-prs').textContent, 1);
  assert.match(textOf(nodes.get('ws-prlist')), /New PR: Bench Press/);
  assert.deepEqual(record.exercises[0].muscles, ['chest', 'frontdelts', 'triceps']);
  assert.deepEqual(plain(api.workoutMuscleSets(record)).counts, { chest: 2, frontdelts: 2, triceps: 2 });
  assert.ok(nodes.get('wk-summary').classList.contains('on'));
  assert.ok(nodes.get('wk-summary').focused);
  assert.equal(nodes.get('ws-bodymap').children.length, 1);
  assert.match(textOf(nodes.get('ws-bodymap')), /Chest 2 sets/);
  assert.deepEqual(JSON.parse(storage.get('lifts_pw_test-user'))[0].exercises[0].muscles, record.exercises[0].muscles);
  assert.deepEqual(JSON.parse(storage.get('lifts_pw_test-user'))[0].prs, record.prs);
  assert.deepEqual(plain(api.normWorkout(record)).prs, record.prs);
  assert.deepEqual(plain(run('MSETS')), { chest: 99 });
  api.wkFinish();
  assert.equal(run('WORKOUTS.length'), 1, 'double-tap does not duplicate the workout');
});

test('discarding an empty workout does not show a completion map', () => {
  const { api, run, nodes } = app();
  run("currentUser={uid:'test-user'};ACTIVE_WORKOUT={id:'empty',exercises:[],logged:{}};go=id=>{globalThis.lastGo=id}");
  api.wkFinish();
  assert.equal(run('WORKOUTS.length'), 0);
  assert.equal(run('lastGo'), 'start');
  assert.equal(nodes.get('wk-summary')?.classList.contains('on') ?? false, false);
});

test('switching accounts clears the previous workout’s map and completion state', () => {
  const { api, run, nodes } = app();
  run("gid('ws-bodymap').appendChild(mk('section','wk-muscle-card'));gid('ws-prlist').appendChild(mk('li',null,'Previous record'));gid('wk-summary').classList.add('on')");
  api.p1SwitchUser();
  assert.equal(nodes.get('ws-bodymap').innerHTML, '');
  assert.equal(nodes.get('ws-bodymap').children.length, 0);
  assert.equal(nodes.get('ws-prlist').children.length, 0);
  assert.equal(nodes.get('wk-summary').classList.contains('on'), false);
  assert.equal(run('wkLastRecord'), null);
});

test('new PRs compare against pre-workout records using normalized units and rep tie-breakers', () => {
  const { api } = app();
  const before = { 'Bench Press': { weight: 50, reps: 8, unit: 'kg' } };
  assert.deepEqual(plain(api.workoutNewPRs([
    { name: 'Bench Press', sets: [{ weight: 110.23, reps: 8, unit: 'lb' }] }
  ], before)), [], 'same weight in another unit is not a PR');
  assert.deepEqual(plain(api.workoutNewPRs([
    { name: 'Bench Press', cat: 'push', sets: [{ weight: 110.23, reps: 9, unit: 'lb' }] },
    { name: 'Bench Press', cat: 'upper', sets: [{ weight: 45, reps: 12, unit: 'kg' }] }
  ], before)), [{ name: 'Bench Press', weight: 110.23, reps: 9, unit: 'lb' }], 'one PR per exercise, across categories');
  assert.deepEqual(plain(api.workoutNewPRs([
    { name: 'Bench Press', sets: [{ weight: 55, reps: 5, unit: 'kg' }] }
  ], before)), [{ name: 'Bench Press', weight: 55, reps: 5, unit: 'kg' }]);
});

test('first records count as benchmarks, while missing or corrupt PR baselines never create claims', () => {
  const { api } = app();
  const ex = exercise('Preacher Curl', 1);
  assert.equal(api.workoutNewPRs([ex], { 'Preacher Curl': null }).length, 1);
  for (const before of [undefined, null, {}, { 'Preacher Curl': 'bad' }, { 'Preacher Curl': { weight: NaN, reps: 10 } }]) {
    assert.deepEqual(plain(api.workoutNewPRs([ex], before)), []);
  }
});

test('PR baselines are captured once before logging and not guessed for an already-logged resumed workout', () => {
  const { api, run } = app();
  run('DATA={"Bench Press":[{date:"2026-10-13",cat:"push",sets:[{weight:40,reps:8,unit:"kg"}]}]}');
  const active = { logged: {} };
  api.wkCapturePRBaseline(active, 'Bench Press');
  assert.equal(active.prBefore['Bench Press'].weight, 40);
  run('DATA["Bench Press"][0].sets.push({weight:50,reps:10,unit:"kg"})');
  api.wkCapturePRBaseline(active, 'Bench Press');
  assert.equal(active.prBefore['Bench Press'].weight, 40, 'own sets cannot overwrite the baseline');
  const restored = { logged: { 'Bench Press': { sets: sets(1) } } };
  api.wkCapturePRBaseline(restored, 'Bench Press');
  assert.equal(Object.hasOwn(restored.prBefore, 'Bench Press'), false);
});

test('PR exercise names are rendered as text, never parsed as HTML', () => {
  const { api, nodes } = app();
  const name = '<img src=x onerror=alert(1)>';
  api.renderWorkoutPRs({ prs: [{ name, weight: 50, reps: 10, unit: 'kg' }] });
  const label = nodes.get('ws-prlist').children[0].children[2];
  assert.equal(label.textContent, name);
  assert.equal(label.innerHTML, '');
});

test('renaming an exercise during a workout also carries its pre-workout PR baseline', () => {
  const { api, run } = app();
  run(`ACTIVE_WORKOUT={
    exercises:[{name:'Bench Press',cat:'push'}],
    prBefore:{'Bench Press':{weight:40,reps:10,unit:'kg'}},
    logged:{'Bench Press':{cat:'push',sets:[{weight:50,reps:10,unit:'kg'}]}}
  }`);
  api.p1OnExerciseRenamed('Bench Press', 'Renamed Press');
  assert.equal(run('ACTIVE_WORKOUT.prBefore["Renamed Press"].weight'), 40);
  assert.equal(run('Object.hasOwn(ACTIVE_WORKOUT.prBefore,"Bench Press")'), false);
});

test('creating an exercise with selected muscles maps it in the post-workout muscle map', () => {
  const { api, run, nodes } = app();
  api.openAddExModal('push');
  assert.equal(nodes.get('ex-muscles').children.length, 16);
  nodes.get('ex-name').value = 'Bayesian Cablestation';

  // Saving without selecting a muscle is rejected
  api.saveEx();
  assert.equal(run('EX.push.includes("Bayesian Cablestation")'), false);
  assert.match(nodes.get('toast').textContent, /Pick at least one muscle/);

  // Selecting muscles and saving persists the mapping and highlights the post-workout map
  run('modalMuscles = new Set(["chest", "frontdelts"])');
  api.saveEx();
  assert.equal(run('EX.push.includes("Bayesian Cablestation")'), true);
  assert.deepEqual(plain(api.getExMuscles('Bayesian Cablestation')), ['chest', 'frontdelts']);
  assert.deepEqual(plain(api.inferWorkoutMuscles('Bayesian Cablestation', 'push')), ['chest', 'frontdelts']);

  run(`
    currentUser={uid:'test-user'};
    ACTIVE_WORKOUT={
      id:'w_custom_ex',routineId:null,routineName:'Push Day',date:'2026-10-13',startedAt:Date.now()-1800000,
      prBefore:{'Bayesian Cablestation':null},
      exercises:[{name:'Bayesian Cablestation',cat:'push'}],
      logged:{'Bayesian Cablestation':{cat:'push',sets:[{weight:30,reps:12,unit:'kg'},{weight:30,reps:10,unit:'kg'},{weight:30,reps:10,unit:'kg'}]}}
    };
  `);
  api.wkFinish();
  const record = plain(run('WORKOUTS[0]'));
  assert.deepEqual(record.exercises[0].muscles, ['chest', 'frontdelts']);
  assert.deepEqual(plain(api.workoutMuscleSets(record)), {
    counts: { chest: 3, frontdelts: 3 }, unmapped: []
  });
  assert.match(textOf(nodes.get('ws-bodymap')), /Chest 3 sets/);
  assert.match(textOf(nodes.get('ws-bodymap')), /Front Delts 3 sets/);
});

test('editing an exercise updates its muscles, fixes past workout maps, and survives sanitizeData', () => {
  const { api, run, nodes } = app();
  run(`
    EX.pull.push('Mystery Puller');
    WORKOUTS=[{
      id:'w_past',name:'Pull Day',date:'2026-10-12',
      exercises:[{name:'Mystery Puller',cat:'pull',muscles:[],sets:[{weight:60,reps:10,unit:'kg'},{weight:60,reps:10,unit:'kg'}]}]
    }];
  `);
  assert.deepEqual(plain(api.workoutMuscleSets(run('WORKOUTS[0]'))), {
    counts: {}, unmapped: ['Mystery Puller']
  });

  api.openEditExModal('Mystery Puller', 'pull');
  assert.equal(nodes.get('editex-muscles').children.length, 16);
  nodes.get('editex-name').value = 'Seated Cable Puller';
  run('editExMuscles = new Set(["lats", "reardelts"])');
  api.saveEditEx();

  assert.deepEqual(plain(api.getExMuscles('Seated Cable Puller')), ['lats', 'reardelts']);
  assert.deepEqual(plain(api.workoutMuscleSets(run('WORKOUTS[0]'))), {
    counts: { lats: 2, reardelts: 2 }, unmapped: []
  });

  const sanitized = plain(api.sanitizeData(run('DATA')));
  assert.deepEqual(sanitized._exMuscles, { 'Seated Cable Puller': ['lats', 'reardelts'] });
});

// ── Existing recovery safeguards — Phase 3c preservation pins ──────────────
// These lock the behaviors the migration must NOT weaken: sign-out flushes
// pending writes to the OLD user before auth changes, an unsaved failure
// keeps the local snapshot and can abort sign-out, and switching accounts
// parks unsaved state under the old uid instead of dropping or reusing it.

test('sign-out flushes pending changes to the old user before signing out, then clears the confirmed snapshot', async () => {
  const { run, storage } = app();
  run(`
    globalThis.__log = [];
    globalThis.__confirms = [];
    globalThis.__lastPayload = null;
    globalThis.confirm = (msg) => { __confirms.push(String(msg)); return true; };
    auth.signOut = () => { __log.push('signOut'); };
    db.collection = () => ({ doc: (id) => ({
      get: async () => ({ exists: false, data: () => ({}) }),
      set: async (p) => { __log.push('set:' + id); __lastPayload = p; }
    }) });
    currentUser = { uid: 'user-A', email: 'a@example.com', displayName: null };
    dataLoadedUid = 'user-A';
    SV = newSV('user-A');
    CATS = [{ id: 'push', label: 'Push', color: '#ff5c35' }];
    EX = { push: ['Bench Press'] };
    DATA = { 'Bench Press': [{ date: '2026-10-01', cat: 'push', sets: [{ weight: 50, reps: 5, unit: 'kg' }] }] };
    scheduleSave();
  `);
  assert.ok(storage.has('lifts_snap_user-A'), 'pending change mirrored into the local snapshot first');

  await run('doSignOut()');

  assert.deepEqual(plain(run('__log')), ['set:user-A', 'signOut'],
    'the old user\'s document must be written before auth.signOut()');
  assert.deepEqual(plain(run('__confirms')), ['Sign out?'], 'no unsaved warning when the flush succeeded');
  const payload = plain(run('__lastPayload'));
  assert.equal(payload.cats[0].id, 'push');
  assert.equal(payload.savedAt !== undefined && Number.isFinite(Number(payload.savedAt)), true);
  assert.equal(storage.has('lifts_snap_user-A'), false,
    'snapshot is removed only after the confirmed cloud write');
});

test('sign-out aborts with a recovery warning and keeps the local snapshot when the flush cannot save', async () => {
  const { run, storage } = app();
  run(`
    globalThis.__log = [];
    globalThis.__confirms = [];
    globalThis.__answers = [true, false];
    globalThis.confirm = (msg) => { __confirms.push(String(msg)); return __answers.shift() !== false; };
    auth.signOut = () => { __log.push('signOut'); };
    db.collection = () => ({ doc: () => ({
      get: async () => ({ exists: false, data: () => ({}) }),
      set: async () => { __log.push('set'); throw new Error('offline'); }
    }) });
    currentUser = { uid: 'user-A', email: 'a@example.com', displayName: null };
    dataLoadedUid = 'user-A';
    SV = newSV('user-A');
    CATS = [{ id: 'legs', label: 'Legs', color: '#4fff91' }];
    scheduleSave();
  `);
  assert.ok(storage.has('lifts_snap_user-A'));

  await run('doSignOut()');

  assert.deepEqual(plain(run('__log')), ['set'], 'auth.signOut() must never run after a failed flush');
  assert.equal(run('__confirms').length, 2, 'confirmation + unsaved-changes warning');
  assert.match(String(run('__confirms')[1]), /backup is stored on this device/);
  assert.ok(storage.has('lifts_snap_user-A'), 'recovery snapshot survives the aborted sign-out');
});

test('switching accounts parks unsaved changes under the old uid’s snapshot and wipes in-memory state', () => {
  const { run, storage } = app();
  run(`
    currentUser = { uid: 'user-A' };
    dataLoadedUid = 'user-A';
    SV = newSV('user-A');
    CATS = [{ id: 'legs', label: 'Legs', color: '#4fff91' }];
    EX = { legs: ['Hip Thrust'] };
    DATA = { 'Hip Thrust': [{ date: '2026-10-02', cat: 'legs', sets: [{ weight: 60, reps: 5, unit: 'kg' }] }] };
    EXTRA = { futureField: 1 };
    SV.rev = 4; SV.saved = 1;
    p1SwitchUser();
  `);

  const snap = JSON.parse(storage.get('lifts_snap_user-A'));
  assert.equal(snap.payload.cats[0].id, 'legs', 'old user\'s unsaved state parked verbatim');
  assert.equal(snap.payload.futureField, 1, 'unknown fields travel with the snapshot');
  assert.ok(Number.isFinite(Number(snap.ts)), 'snapshot keeps its timestamp for snapPick ordering');
  assert.equal(run('SV'), null, 'no save queue survives the switch');
  assert.equal(run('dataLoadedUid'), null);
  assert.equal(run('CATS.length'), 0, 'in-memory state fully wiped');
  assert.equal(run('EXTRA.futureField'), undefined);
  assert.equal(storage.has('lifts_snap_user-B'), false, 'nothing written for another account');
});
