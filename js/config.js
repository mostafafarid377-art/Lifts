// ── Firebase config & default seed data ───────────────
export const firebaseConfig = {
  apiKey: "AIzaSyBYhRhYbbbNSXf0zH86wWbE_YaRiccXLaU",
  authDomain: "lifts-ec71b.firebaseapp.com",
  projectId: "lifts-ec71b",
  storageBucket: "lifts-ec71b.firebasestorage.app",
  messagingSenderId: "981398459733",
  appId: "1:981398459733:web:fe7c9a7bb38b3fa1140bdc"
};

export const DC = [
  {id:'push', label:'Push', color:'#ff5c35'},
  {id:'pull', label:'Pull', color:'#35b8ff'},
  {id:'legs', label:'Legs', color:'#4fff91'},
  {id:'upper',label:'Upper',color:'#ffbb35'},
  {id:'other',label:'Other',color:'#999999'}
];

export const DE = {
  push: ['Incline BP Machine','Flat DB Bench Press','Pec Deck','Shoulder Press Machine','Cable Lateral Raises','DB Lateral Raises','Triceps Pushdown','Triceps Overhead Extension','Push Ups'],
  pull: ['Lat Pulldown','T-Bar Row','Seated Row Machine','Back Extension','Reverse Pec Deck','Preacher Curl','Hammer Curl','Incline Curl','Shrugs','Pull Ups'],
  legs: ['Smith Squats','Hip Thrust','Leg Extension','Lying Leg Curl','Adductors','Calf Raises','Leg Curl','Reverse Curl'],
  upper:['Incline BP Machine','T-Bar Row','Seated Lateral Raises','Pec Deck','Lat Pulldown','Preacher Curl','Triceps Pushdown','Reverse Curl'],
  other:['Abs','Push Ups','Pull Ups']
};

export const SEED = {
  'Incline BP Machine':        [{date:'2026-04-30',sets:[{weight:35,reps:8,unit:'kg'},{weight:35,reps:8,unit:'kg'}]}],
  'Flat DB Bench Press':       [{date:'2026-04-30',sets:[{weight:25,reps:9,unit:'kg'}]}],
  'Pec Deck':                  [{date:'2026-04-30',sets:[{weight:190,reps:8,unit:'lb'},{weight:190,reps:8,unit:'lb'},{weight:190,reps:8,unit:'lb'}]}],
  'Shoulder Press Machine':    [{date:'2026-04-30',sets:[{weight:59,reps:7,unit:'kg'},{weight:59,reps:7,unit:'kg'}]}],
  'Cable Lateral Raises':      [{date:'2026-04-30',sets:[{weight:40,reps:8,unit:'lb'},{weight:40,reps:8,unit:'lb'},{weight:40,reps:8,unit:'lb'}]}],
  'Triceps Pushdown':          [{date:'2026-04-30',sets:[{weight:50,reps:12,unit:'lb'},{weight:50,reps:12,unit:'lb'}]}],
  'Triceps Overhead Extension':[{date:'2026-04-30',sets:[{weight:90,reps:7,unit:'lb'},{weight:90,reps:7,unit:'lb'}]}],
  'T-Bar Row':                 [{date:'2026-04-30',sets:[{weight:65,reps:7,unit:'kg'},{weight:65,reps:7,unit:'kg'},{weight:65,reps:7,unit:'kg'}]}],
  'Lat Pulldown':              [{date:'2026-04-30',sets:[{weight:95,reps:9,unit:'lb'},{weight:95,reps:9,unit:'lb'},{weight:95,reps:9,unit:'lb'}]}],
  'Seated Row Machine':        [{date:'2026-04-30',sets:[{weight:90,reps:7,unit:'kg'},{weight:90,reps:7,unit:'kg'}]}],
  'Reverse Pec Deck':          [{date:'2026-04-30',sets:[{weight:150,reps:7,unit:'lb'},{weight:150,reps:7,unit:'lb'}]}],
  'Preacher Curl':             [{date:'2026-04-30',sets:[{weight:32,reps:4,unit:'kg'},{weight:32,reps:4,unit:'kg'}]}],
  'Incline Curl':              [{date:'2026-04-30',sets:[{weight:12.5,reps:7,unit:'kg'}]}],
  'Smith Squats':              [{date:'2026-04-30',sets:[{weight:60,reps:8,unit:'kg'}]}],
  'Hip Thrust':                [{date:'2026-04-30',sets:[{weight:50,reps:10,unit:'kg'}]}],
  'Lying Leg Curl':            [{date:'2026-04-30',sets:[{weight:120,reps:8,unit:'lb'}]}],
  'Adductors':                 [{date:'2026-04-30',sets:[{weight:150,reps:12,unit:'lb'}]}],
  'Pull Ups':                  [{date:'2026-04-30',sets:[{weight:0,reps:5,unit:'kg'}]}],
};

export const MUSCLES = [
  {id:'chest',label:'Chest'},{id:'traps',label:'Traps'},{id:'lats',label:'Lats'},{id:'lowerback',label:'Lower Back'},{id:'frontdelts',label:'Front Delts'},{id:'sidedelts',label:'Side Delts'},{id:'reardelts',label:'Rear Delts'},
  {id:'biceps',label:'Biceps'},{id:'triceps',label:'Triceps'},{id:'forearms',label:'Forearms'},{id:'quads',label:'Quads'},
  {id:'hamstrings',label:'Hamstrings'},{id:'glutes',label:'Glutes'},{id:'adductors',label:'Adductors'},{id:'calves',label:'Calves'},{id:'abs',label:'Abs'}
];

export const DAYS = [
  {k:'sunday',l:'Sunday',s:'Sun'},{k:'monday',l:'Monday',s:'Mon'},{k:'tuesday',l:'Tuesday',s:'Tue'},
  {k:'wednesday',l:'Wednesday',s:'Wed'},{k:'thursday',l:'Thursday',s:'Thu'},{k:'friday',l:'Friday',s:'Fri'},
  {k:'saturday',l:'Saturday',s:'Sat'}
];

export const KG_PER_LB = 0.45359237;
export const WEIGHT_EPS_KG = 0.01;
export const SAVE_TIMEOUT_MS = 15000;
export const SAVE_MAX_RETRIES = 5;
