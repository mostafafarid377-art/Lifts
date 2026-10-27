// LIFTS — modular entry point
import './firebase.js'; // init firebase; uses globals from CDN
import BM_DATA from './modules/bodymap.data.js';
// Most helpers (gid, mk, fmtW, catById, toKg, bestSet, toast, …) are declared
// in the original script body below. installErrorHandler is defined in utils
// and invoked at startup, so we bring it in explicitly.
import { installErrorHandler } from './utils.js';

// auth/db/firebase are initialised by js/firebase.js from the compat SDK CDN
// script loaded before this module in index.html.
const auth = firebase.auth();
const db   = firebase.firestore();

// Make BM_DATA a top-level const the original code expects; also expose on window
// for any devtool/debug usage.
window.BM_DATA = BM_DATA;

installErrorHandler();


// ── Defaults ──────────────────────────────────────────
const DC=[
  {id:'push', label:'Push', color:'#ff5c35'},
  {id:'pull', label:'Pull', color:'#35b8ff'},
  {id:'legs', label:'Legs', color:'#4fff91'},
  {id:'upper',label:'Upper',color:'#ffbb35'},
  {id:'other',label:'Other',color:'#999999'}
];
const DE={
  push: ['Incline BP Machine','Flat DB Bench Press','Pec Deck','Shoulder Press Machine','Cable Lateral Raises','DB Lateral Raises','Triceps Pushdown','Triceps Overhead Extension','Push Ups'],
  pull: ['Lat Pulldown','T-Bar Row','Seated Row Machine','Back Extension','Reverse Pec Deck','Preacher Curl','Hammer Curl','Incline Curl','Shrugs','Pull Ups'],
  legs: ['Smith Squats','Hip Thrust','Leg Extension','Lying Leg Curl','Adductors','Calf Raises','Leg Curl','Reverse Curl'],
  upper:['Incline BP Machine','T-Bar Row','Seated Lateral Raises','Pec Deck','Lat Pulldown','Preacher Curl','Triceps Pushdown','Reverse Curl'],
  other:['Abs','Push Ups','Pull Ups']
};
const SEED={
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

// ── Muscles ───────────────────────────────────────────
const MUSCLES=[
  {id:'chest',label:'Chest'},{id:'traps',label:'Traps'},{id:'lats',label:'Lats'},{id:'lowerback',label:'Lower Back'},{id:'frontdelts',label:'Front Delts'},{id:'sidedelts',label:'Side Delts'},{id:'reardelts',label:'Rear Delts'},
  {id:'biceps',label:'Biceps'},{id:'triceps',label:'Triceps'},{id:'forearms',label:'Forearms'},{id:'quads',label:'Quads'},
  {id:'hamstrings',label:'Hamstrings'},{id:'glutes',label:'Glutes'},{id:'adductors',label:'Adductors'},{id:'calves',label:'Calves'},{id:'abs',label:'Abs'}
];
const bmName=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const BM_CATEGORY_ALIASES={pecs:'chest',trapezius:'traps',quadriceps:'quads',hamstring:'hamstrings',glute:'glutes',calf:'calves',abdominals:'abs',core:'abs','front deltoids':'frontdelts','side deltoids':'sidedelts','rear deltoids':'reardelts'};
function normMuscleId(v){
  const s=bmName(v);
  if(!s)return null;
  const m=MUSCLES.find(x=>x.id===s||bmName(x.id)===s||bmName(x.label)===s);
  if(m)return m.id;
  return Object.hasOwn(BM_CATEGORY_ALIASES,s)?BM_CATEGORY_ALIASES[s]:null;
}
function normMuscleList(raw){
  const list=Array.isArray(raw)?raw:(typeof raw==='string'&&raw.trim()?[raw]:[]);
  const out=[];
  list.forEach(x=>{
    const id=normMuscleId(x);
    if(id&&!out.includes(id))out.push(id);
  });
  return out;
}

// ── App state ─────────────────────────────────────────
let CATS=[...DC], EX=JSON.parse(JSON.stringify(DE)), DATA={};
let MSETS={}; // manual, user-entered set counts per muscle id, e.g. {chest:10, biceps:6}
let CUSTOM_MUSCLES=[]; // user-added muscles, e.g. [{id:'custom_forearms',label:'Forearms'}]
let HIDDEN_MUSCLES=new Set(); // built-in muscle ids the user removed from their list
const allMuscles=()=>[...MUSCLES];

// DATA shape: DATA[exerciseName] = [ {date, cat, sets}, ... ]
// One shared history per exercise (same weight/PR/prefill everywhere), but each
// session remembers which category it was logged under (cat), purely so
// "Sets by Muscle" can add up the most recent session per category.
function migrateDataShape(){
  Object.keys(DATA).forEach(name=>{
    if(name.startsWith('_'))return; // skip _goals, _restDays, etc.
    const v=DATA[name];
    if(Array.isArray(v)){
      // ensure every session has a cat tag; default missing ones to primary category
      DATA[name]=v.map(s=>s.cat?s:{...s,cat:primCat(name)});
    } else if(v && typeof v==='object'){
      // previous per-category nested shape — flatten back into one shared list
      let flat=[];
      Object.keys(v).forEach(catId=>{
        (v[catId]||[]).forEach(s=>flat.push({...s,cat:catId}));
      });
      flat.sort((a,b)=>a.date.localeCompare(b.date));
      DATA[name]=flat;
    }
  });
}
// ── DATA VALIDATION (load time) ──────────────────────
// Everything read from Firestore, the local backup and the pending-workout queue passes through these before the app uses it.
// Rules: repair what is recoverable (numeric strings, missing ids/names, date formats); drop only entries with nothing
// recoverable; keep sessions that have sets but no usable date out of sight in UNPLACED (written back untouched on save);
// copy every unreadable entry to a local quarantine so nothing disappears silently. None of these functions throws.
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numOf=v=>{
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  if(typeof v==='string'){const t=v.trim().replace(/^(-?\d+),(\d+)$/,'$1.$2');if(t!==''&&Number.isFinite(Number(t)))return Number(t);}
  return null;
};
const isoOf=v=>{
  let t=null;
  if(typeof v==='string')t=v.trim();
  else if(typeof v==='number'&&Number.isInteger(v)&&v>=10000101&&v<=99991231)t=String(v);
  if(!t)return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t)||/^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if(!m)return null;
  const y=+m[1],mo=+m[2],d=+m[3];
  if(mo<1||mo>12||d<1||d>new Date(y,mo,0).getDate())return null;
  return m[1]+'-'+m[2]+'-'+m[3];
};
const textOf=v=>(typeof v==='string')?v:((typeof v==='number'&&Number.isFinite(v))?String(v):'');
const hashId=(p,o)=>{const t=JSON.stringify(o)||'';let h=5381;for(let i=0;i<t.length;i++)h=((h<<5)+h+t.charCodeAt(i))|0;return p+'_'+(h>>>0).toString(36);};
const KNOWN_FIELDS=new Set(['cats','ex','data','msets','customMuscles','hiddenMuscles','splits','activeSplitId','routines','schedule','workouts','activeWorkout','awUpdatedAt','savedAt']);
let UNPLACED={}, EXTRA={}, REPAIR={dropped:0,unplaced:0}, NORM_UID=null;
function quarantine(kind,raw){
  REPAIR.dropped++;
  if(!NORM_UID)return;
  try{
    const k='lifts_quarantine_'+NORM_UID;
    let a=[];try{a=JSON.parse(localStorage.getItem(k)||'[]');if(!Array.isArray(a))a=[];}catch(e){a=[];}
    const sig=kind+'|'+JSON.stringify(raw);
    if(a.some(x=>x&&x.sig===sig))return;
    a.push({sig,kind,ts:Date.now(),raw});
    localStorage.setItem(k,JSON.stringify(a.slice(-100)));
  }catch(e){}
}
function normSet(x){
  if(!isObj(x))return null;
  const w=numOf(x.weight),r=numOf(x.reps);
  if(w===null||r===null)return null;
  return {...x,weight:w,reps:r};
}
function normSets(raw){
  const sets=[],bad=[];
  (Array.isArray(raw)?raw:[]).forEach(x=>{const n=normSet(x);if(n)sets.push(n);else if(isObj(x))bad.push(x);});
  return {sets,bad};
}
function normSession(s){            // → {session} | {unplaced} | null
  if(!isObj(s))return null;
  const {sets,bad}=normSets(s.sets);
  if(!sets.length){if(bad.length)quarantine('session-sets-unreadable',s);return null;}
  if(bad.length)quarantine('sets-unreadable',{date:s.date,cat:s.cat,sets:bad});
  const date=isoOf(s.date);
  const out={...s,sets};
  if(typeof out.cat!=='string'||!out.cat)delete out.cat;
  if(!date)return {unplaced:out};   // valid sets, no usable date: kept untouched, hidden from the app
  out.date=date;
  return {session:out};
}
function sanitizeData(raw){
  const out={};
  if(!isObj(raw)){if(raw!=null&&!(Array.isArray(raw)&&!raw.length))quarantine('data-unreadable',raw);return out;}
  Object.keys(raw).forEach(name=>{
    const v=raw[name];
    if(name.startsWith('_')){out[name]=JSON.parse(JSON.stringify(v===undefined?null:v));return;}
    let list,flat=false;
    if(Array.isArray(v))list=v;
    else if(isObj(v)){                 // previous per-category nested shape {catId:[sessions]} — flatten
      flat=true;list=[];
      Object.keys(v).forEach(catId=>{
        const c=v[catId];
        if(Array.isArray(c))c.forEach(x=>{if(isObj(x))list.push({...x,cat:catId});});
        else if(c!=null&&c!=='')quarantine('legacy-category-unreadable',{name,catId,value:c});
      });
    }else{if(v!=null)quarantine('history-unreadable',{name,value:v});return;}
    const arr=[];
    list.forEach(x=>{
      const r=normSession(x);
      if(!r)return;
      if(r.unplaced){(UNPLACED[name]=UNPLACED[name]||[]).push(r.unplaced);REPAIR.unplaced++;}
      else arr.push(r.session);
    });
    if(flat)arr.sort((a,b)=>a.date.localeCompare(b.date));
    out[name]=arr;
  });
  if('_bodyWeight' in out){
    const bw=out._bodyWeight;
    if(Array.isArray(bw)){
      const keep=[];
      bw.forEach(e=>{
        if(!isObj(e))return;
        const val=numOf(e.value),date=isoOf(e.date);
        if(val===null){quarantine('bodyweight-no-value',e);return;}
        if(!date){(UNPLACED._bodyWeight=UNPLACED._bodyWeight||[]).push({...e,value:val});REPAIR.unplaced++;return;}
        keep.push({...e,date,value:val});
      });
      out._bodyWeight=keep;
    }else{if(bw!=null)quarantine('bodyweight-unreadable',bw);out._bodyWeight=[];}
  }
  if('_goals' in out){
    const g=out._goals,ng={};
    if(isObj(g)){
      Object.keys(g).forEach(n=>{
        const x=g[n];
        if(!isObj(x)){if(x!=null)quarantine('goal-unreadable',{name:n,goal:x});return;}
        const w=numOf(x.weight),r=numOf(x.reps);
        if(w===null||r===null){quarantine('goal-unreadable',{name:n,goal:x});return;}
        ng[n]={...x,weight:w,reps:r};
      });
    }else if(g!=null)quarantine('goals-unreadable',g);
    out._goals=ng;
  }
  if('_exMuscles' in out){
    const em=out._exMuscles,nem={};
    if(isObj(em)){
      Object.keys(em).forEach(n=>{
        if(typeof n!=='string'||!n.trim())return;
        const arr=normMuscleList(em[n]);
        if(arr.length)nem[n]=arr;
        else if(em[n]!=null&&!(Array.isArray(em[n])&&!em[n].length))quarantine('ex-muscles-unreadable',{name:n,muscles:em[n]});
      });
    }else if(em!=null)quarantine('ex-muscles-unreadable',em);
    out._exMuscles=nem;
  }
  if('_weightGoal' in out){
    const wg=out._weightGoal,val=isObj(wg)?numOf(wg.value):null;
    if(val!==null)out._weightGoal={...wg,value:val};
    else{if(wg!=null)quarantine('weight-goal-unreadable',wg);delete out._weightGoal;}
  }
  if('_restDays' in out){
    const n=numOf(out._restDays);
    if(n!==null&&Number.isInteger(n)&&n>=0)out._restDays=n;else delete out._restDays;
  }
  return out;
}
function normCats(raw){             // → array, or null when the field is missing/unreadable
  if(!Array.isArray(raw))return null;
  const out=[],seen=new Set();
  raw.forEach(c=>{
    if(!isObj(c))return;
    let id=textOf(c.id).trim()?textOf(c.id):'';
    const label=textOf(c.label).trim()?textOf(c.label):'';
    if(!id&&!label)return;
    if(!id)id=(label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||'cat');
    const lbl=label||id;
    if(seen.has(id)){
      const same=out.find(x=>x.id===id);
      if(same&&same.label===lbl)return;                  // exact duplicate
      let n=2;while(seen.has(id+'_'+n))n++;id=id+'_'+n;  // different category sharing an id → keep both
    }
    seen.add(id);
    out.push({...c,id,label:lbl,color:safeColor(c.color)});
  });
  return out;
}
function normEx(raw){               // → {catId:[names]}, or null when missing/unreadable
  if(!isObj(raw))return null;
  const out={};
  Object.keys(raw).forEach(k=>{
    const v=raw[k];let arr;
    if(Array.isArray(v))arr=v;
    else if(typeof v==='string'&&v.trim())arr=[v];
    else{if(v!=null)quarantine('exercise-list-unreadable',{cat:k,value:v});out[k]=[];return;}
    const names=[];
    arr.forEach(n=>{const t=textOf(n);if(t.trim()&&!names.includes(t))names.push(t);});
    out[k]=names;
  });
  return out;
}
function deriveCats(ex){            // category list recovered from the exercise map's keys
  return Object.keys(ex).map(k=>{const dc=DC.find(c=>c.id===k);return dc?{...dc}:{id:k,label:k.charAt(0).toUpperCase()+k.slice(1),color:'#888'};});
}
function gatherNames(data,routines,workouts){   // every exercise name the saved data still mentions, with its category hint
  const pairs=[];
  Object.keys(data||{}).forEach(n=>{
    if(n.startsWith('_')||!Array.isArray(data[n])||!data[n].length)return;
    const last=data[n].slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))).pop();
    pairs.push([n,last&&last.cat]);
  });
  routines.forEach(r=>r.exercises.forEach(e=>pairs.push([e.name,e.cat])));
  workouts.forEach(w=>w.exercises.forEach(e=>pairs.push([e.name,e.cat])));
  return pairs;
}
function placeNames(ex,cats,pairs){
  const first=cats[0]&&cats[0].id,known=new Set();
  Object.keys(ex).forEach(k=>(ex[k]||[]).forEach(n=>known.add(n)));
  pairs.forEach(([name,hint])=>{
    if(typeof name!=='string'||!name.trim()||known.has(name))return;
    const cid=cats.some(c=>c.id===hint)?hint:first;
    if(!cid)return;
    (ex[cid]=ex[cid]||[]).push(name);known.add(name);
  });
}
function rebuildEx(cats,data,routines,workouts){
  const ex={};cats.forEach(c=>{ex[c.id]=[];});
  placeNames(ex,cats,gatherNames(data,routines,workouts));
  Object.keys(ex).forEach(k=>ex[k].sort((a,b)=>a.localeCompare(b)));
  return ex;
}
function normRoutines(raw){
  if(!Array.isArray(raw)){if(raw!=null)quarantine('routines-unreadable',raw);return [];}
  const out=[],seen=new Set();
  raw.forEach(r=>{
    if(!isObj(r))return;
    const exs=[];
    (Array.isArray(r.exercises)?r.exercises:[]).forEach(e=>{
      const o=typeof e==='string'?{name:e}:e;
      if(!isObj(o))return;
      const nm=textOf(o.name);
      if(!nm.trim())return;
      exs.push({...o,name:nm,cat:(typeof o.cat==='string'&&o.cat)?o.cat:primCat(nm)});
    });
    let name=textOf(r.name),id=textOf(r.id);
    if(!name.trim()&&!exs.length&&!id)return;
    if(!name.trim())name='Routine';
    if(!id)id=hashId('rt',{name,exs});
    if(seen.has(id)){let n=2;while(seen.has(id+'_'+n))n++;id=id+'_'+n;}   // duplicate id → later routine gets its own id
    seen.add(id);
    out.push({...r,id,name,exercises:exs});
  });
  return out;
}
function normWorkout(w){            // → normalised record, or null when nothing is recoverable
  if(!isObj(w))return null;
  const exs=[];
  (Array.isArray(w.exercises)?w.exercises:[]).forEach(e=>{
    if(!isObj(e))return;
    const nm=textOf(e.name);
    const {sets,bad}=normSets(e.sets);
    const rawN=Array.isArray(e.sets)?e.sets.length:0;
    if(!nm.trim()||!sets.length){if(rawN)quarantine('workout-exercise-unreadable',e);return;}
    if(bad.length)quarantine('workout-sets-unreadable',{name:nm,sets:bad});
    exs.push({...e,name:nm,cat:(typeof e.cat==='string'&&e.cat)?e.cat:primCat(nm),sets});
  });
  if(!exs.length){quarantine('workout-unreadable',w);return null;}
  const st=numOf(w.startedAt),fi=numOf(w.finishedAt),du=numOf(w.durationSec);
  const date=isoOf(w.date)||(st!==null?localISO(new Date(st)):'')||(fi!==null?localISO(new Date(fi)):'');
  const out={...w,exercises:exs,date,name:(typeof w.name==='string'&&w.name)?w.name:'Workout'};
  if(st!==null)out.startedAt=st;else delete out.startedAt;
  if(fi!==null)out.finishedAt=fi;else delete out.finishedAt;
  if(du!==null)out.durationSec=du;else delete out.durationSec;
  return out;
}
function normWorkouts(raw){
  if(!Array.isArray(raw)){if(raw!=null)quarantine('workouts-unreadable',raw);return [];}
  const out=[],seen=new Map();
  raw.forEach(w=>{
    const n=normWorkout(w);if(!n)return;
    let id=textOf(w.id);
    if(!id)id=hashId('w',n);
    const sig=JSON.stringify({...n,id:undefined});
    if(seen.has(id)){
      if(seen.get(id)===sig)return;                       // exact duplicate (old recovery bug) → one record
      let k=2,nid=hashId('w',n);while(seen.has(nid))nid=hashId('w',{...n,k:k++});id=nid;   // different record sharing an id → keep both
    }
    seen.set(id,sig);
    out.push({...n,id});
  });
  return out;
}
function normSplits(raw){
  if(!Array.isArray(raw)){if(raw!=null)quarantine('splits-unreadable',raw);return [];}
  const out=[],seen=new Set();
  raw.forEach(sp=>{
    if(!isObj(sp))return;
    const ids=Array.isArray(sp.catIds)?sp.catIds.map(textOf).filter(Boolean):(textOf(sp.catIds)?[textOf(sp.catIds)]:[]);
    let label=textOf(sp.label)||textOf(sp.name),id=textOf(sp.id);
    if(!label&&!id&&!ids.length)return;
    if(!label)label='Split';
    if(!id)id=hashId('split',{label,ids});
    if(seen.has(id)){let n=2;while(seen.has(id+'_'+n))n++;id=id+'_'+n;}
    seen.add(id);
    out.push({...sp,id,label,catIds:ids});
  });
  return out;
}
function normMsets(raw){
  const out={};
  if(!isObj(raw)){if(raw!=null)quarantine('muscle-sets-unreadable',raw);return out;}
  Object.keys(raw).forEach(k=>{const n=numOf(raw[k]);if(n!==null)out[k]=n;else if(raw[k]!=null)quarantine('muscle-set-unreadable',{muscle:k,value:raw[k]});});
  return out;
}
function normCustomMuscles(raw){
  return (Array.isArray(raw)?raw:[]).filter(m=>isObj(m)&&textOf(m.id)&&textOf(m.label)).map(m=>({...m,id:textOf(m.id),label:textOf(m.label)}));
}
const strList=raw=>(Array.isArray(raw)?raw:(typeof raw==='string'&&raw?[raw]:[])).map(textOf).filter(Boolean);
function snapshotShapeOk(p){        // a local backup must at least look like one of our documents
  if(!isObj(p))return false;
  const opt=(k,t)=>p[k]===undefined||p[k]===null||t(p[k]);
  if(!opt('cats',Array.isArray)||!opt('ex',isObj)||!opt('data',isObj)||!opt('workouts',Array.isArray)||!opt('routines',Array.isArray)||!opt('splits',Array.isArray))return false;
  return ['cats','ex','data','workouts','routines'].some(k=>p[k]!==undefined&&p[k]!==null);
}
function quarantineSnapshot(uid,snap,reason){
  try{
    const k='lifts_snapquarantine_'+uid;
    let a=[];try{a=JSON.parse(localStorage.getItem(k)||'[]');if(!Array.isArray(a))a=[];}catch(e){a=[];}
    a.push({ts:Date.now(),reason:String(reason).slice(0,120),snapshot:snap});
    localStorage.setItem(k,JSON.stringify(a.slice(-3)));
    localStorage.removeItem(snapKey(uid));
  }catch(e){ try{localStorage.removeItem(snapKey(uid));}catch(e2){} }
  toast('A damaged local backup was set aside — using your cloud data');
}
// SPLITS: [{id, label, catIds:[]}]  activeSplitId: string|null
let SPLITS=[], activeSplitId=null;
let currentUser=null;
let selDay='all', selEx=null, selCatCtx=null, sets=[], unit='kg';
let logLast=null; // previous-session reference shown while logging inside a workout: placeholders only, never saved
let modalCats=new Set(), modalMuscles=new Set();
let authMode='login';

// ── PHASE 1 state (kept separate from CATS/EX/DATA/SPLITS) ──
// ROUTINES:       [{id,name,exercises:[{name,cat}]}]
// SCHEDULE:       {sunday:[routineId],...,saturday:[]}
// WORKOUTS:       completed workouts (snapshot incl. duration, muscle assignments and prs) — [{id,routineId,name,date,startedAt,finishedAt,durationSec,exercises:[{name,cat,muscles:[muscleId],sets:[{weight,reps,unit}]}]}]
// ACTIVE_WORKOUT: the in-progress workout or null — {id,routineId,routineName,startedAt,date,exercises:[{name,cat}],logged:{[name]:{cat,sets}},prBefore:{[name]:bestSetOrNull},updatedAt}
const DAYS=[{k:'sunday',l:'Sunday',s:'Sun'},{k:'monday',l:'Monday',s:'Mon'},{k:'tuesday',l:'Tuesday',s:'Tue'},{k:'wednesday',l:'Wednesday',s:'Wed'},{k:'thursday',l:'Thursday',s:'Thu'},{k:'friday',l:'Friday',s:'Fri'},{k:'saturday',l:'Saturday',s:'Sat'}];
function emptySchedule(){const s={};DAYS.forEach(d=>{s[d.k]=[];});return s;}
let ROUTINES=[], SCHEDULE=emptySchedule(), WORKOUTS=[], ACTIVE_WORKOUT=null, AW_UPDATED=0;
let wkReturn=false;        // true while the existing log form was opened from the active workout
let dataLoadedUid=null;    // uid whose cloud data is loaded in memory — saves are only allowed for this uid

// ── Firestore ─────────────────────────────────────────
function userRef(uid){ return db.collection('users').doc(uid); }

function applyDoc(d,uid){            // validates, then installs one document (cloud copy or local backup); throws only on a real bug
  NORM_UID=uid;UNPLACED={};EXTRA={};REPAIR={dropped:0,unplaced:0};
  const cl=v=>JSON.parse(JSON.stringify(v));
  Object.keys(d).forEach(k=>{if(!KNOWN_FIELDS.has(k)&&k!=='__proto__'&&d[k]!==undefined)EXTRA[k]=cl(d[k]);});   // fields this app doesn't own: written back untouched
  const cats=normCats(d.cats),ex=normEx(d.ex);
  if(d.cats!=null&&cats===null)quarantine('cats-unreadable',d.cats);
  if(d.ex!=null&&ex===null)quarantine('ex-unreadable',d.ex);
  const data=sanitizeData(d.data);
  // provisional categories/exercises so primCat() works while routines and workouts are validated
  if(cats&&ex){CATS=cats;EX=ex;}
  else if(cats){CATS=cats;EX={};}                    // existing document without an exercise map: rebuilt below, never replaced by the stock list
  else if(ex){CATS=deriveCats(ex);EX=ex;}            // categories lost but exercises intact: categories recovered from the exercise map
  else{CATS=cl(DC);EX=cl(DE);}                       // very old document with neither: the original default library
  const routines=normRoutines(d.routines),workouts=normWorkouts(d.workouts);
  if(cats&&!ex)EX=rebuildEx(CATS,data,routines,workouts);
  else if(!cats&&!ex)placeNames(EX,CATS,gatherNames(data,routines,workouts));   // old document: stock library + any exercise found in the saved history
  DATA=data;
  MSETS=normMsets(d.msets);
  CUSTOM_MUSCLES=normCustomMuscles(d.customMuscles);
  HIDDEN_MUSCLES=new Set(strList(d.hiddenMuscles));
  SPLITS=normSplits(d.splits);
  activeSplitId=(typeof d.activeSplitId==='string'&&SPLITS.some(x=>x.id===d.activeSplitId))?d.activeSplitId:null;
  if(MSETS.back!==undefined){ if(MSETS.lats===undefined)MSETS.lats=MSETS.back; delete MSETS.back; }
  migrateDataShape();
  p1LoadFrom({...d,routines,workouts},uid);
}
async function loadUserData(uid){
  const tok=++loadSeq;
  let snapApplied=false;
  showSync(true);
  try{
    const snap = await userRef(uid).get();
    if(tok!==loadSeq||!currentUser||currentUser.uid!==uid){showSync(false);return;} // user changed (or a newer load started) while loading — discard
    const d=snap.exists?snap.data():null;
    const localSnap=snapPick(uid,d);            // unsaved local changes from a failed/interrupted cloud save
    let applied=false;
    if(localSnap){
      if(snapshotShapeOk(localSnap)){
        try{applyDoc(localSnap,uid);applied=true;snapApplied=true;}
        catch(e){console.error('Local backup unusable:',e.message);quarantineSnapshot(uid,localSnap,e.message);}
      }else quarantineSnapshot(uid,localSnap,'unexpected structure');
    }
    if(!applied&&d){applyDoc(d,uid);applied=true;}
    if(applied){
      dataLoadedUid=uid;
    } else {
      // Brand new user — completely blank, no categories, no exercises
      CATS=[];
      EX={};
      DATA={};
      MSETS={};
      CUSTOM_MUSCLES=[];
      HIDDEN_MUSCLES=new Set();
      SPLITS=[];
      activeSplitId=null;
      UNPLACED={};EXTRA={};
      p1Reset();dataLoadedUid=uid;
      scheduleSave(); // create the user's document through the serialized save queue
    }
  }catch(e){
    console.error('Load error',e.message);
    if(tok!==loadSeq||!currentUser||currentUser.uid!==uid){showSync(false);return;}
    dataLoadedUid=null; // load failed: keep the app usable but NEVER overwrite the cloud copy with blanks
    toast('Could not load your data — changes will not be saved until you reload');
    // Fall back to defaults so app still works
    CATS=JSON.parse(JSON.stringify(DC));
    EX=JSON.parse(JSON.stringify(DE));
    DATA={};
    MSETS={};
    CUSTOM_MUSCLES=[];
    HIDDEN_MUSCLES=new Set();
    SPLITS=[];
    activeSplitId=null;
    UNPLACED={};EXTRA={};
    p1Reset();
  }
  if(dataLoadedUid===uid&&(REPAIR.dropped||REPAIR.unplaced)){
    // tell the user when something was set aside; entries that stay parked in the document don't re-announce themselves on every load
    let seen=null;try{seen=localStorage.getItem('lifts_repairnote_'+uid);}catch(e){}
    if(REPAIR.dropped>0||seen!==String(REPAIR.unplaced))toast('Some saved entries were unreadable — they were set aside and kept on this device');
    try{localStorage.setItem('lifts_repairnote_'+uid,String(REPAIR.unplaced));}catch(e){}
  }
  // changes queued before the load finished (or a recovered local snapshot) are pushed now that saving is allowed
  if(dataLoadedUid===uid&&SV&&SV.uid===uid&&(snapApplied||SV.saved<SV.rev))scheduleSave();
  showSync(false);
  bootApp();
}

// ── Save layer ───────────────────────────────────────
// Safety rules:
//  • a pending save is bound to the uid that scheduled it and is dropped if a different user is signed in
//  • nothing is written until that user's cloud data was loaded successfully (no overwriting real data with blanks)
//  • sign-out flushes the pending save to the OLD user's document before auth changes
function buildPayload(ts){
  let dataOut=DATA;
  const up=Object.keys(UNPLACED);
  if(up.length){dataOut={...DATA};up.forEach(k=>{if(Array.isArray(dataOut[k]))dataOut[k]=dataOut[k].concat(UNPLACED[k]);});}   // unreadable-date entries are written back untouched
  return {...EXTRA,   // fields this app doesn't own come first so they can never override the app's own fields below
          cats:CATS,ex:EX,data:dataOut,msets:MSETS,customMuscles:CUSTOM_MUSCLES,hiddenMuscles:[...HIDDEN_MUSCLES],splits:SPLITS,activeSplitId:activeSplitId,
          routines:ROUTINES,schedule:SCHEDULE,workouts:WORKOUTS,activeWorkout:ACTIVE_WORKOUT||null,awUpdatedAt:AW_UPDATED,savedAt:ts||Date.now()};
}
// ── Save queue (one per signed-in user) ──────────────
// • every change bumps sv.rev; drain() is the ONLY code that writes to Firestore, and runs at most one write at a time per user
// • each write sends the NEWEST state at the moment it starts, so an older snapshot can never overwrite a newer one
// • changes made during a write bump sv.rev, so the same drain loop writes again with the newest state right after
// • every change is mirrored synchronously into a local snapshot (localStorage) that is removed only after a confirmed cloud write
// • a queue belongs to one uid; it stops (writes nothing) the moment that uid is no longer the signed-in, loaded user
const SAVE_TIMEOUT_MS=15000, SAVE_MAX_RETRIES=5;
let SV=null, loadSeq=0;
function newSV(uid){return {uid,rev:0,saved:0,job:null,timer:null,retry:null,fails:0,lastTs:0};}
const svLive=sv=>!!sv&&sv===SV&&!!currentUser&&currentUser.uid===sv.uid&&dataLoadedUid===sv.uid;
const svStamp=sv=>{sv.lastTs=Math.max(Date.now(),sv.lastTs+1);return sv.lastTs;};
const snapKey=uid=>'lifts_snap_'+uid;
function snapRead(uid){try{const x=JSON.parse(localStorage.getItem(snapKey(uid))||'null');return(x&&typeof x==='object'&&x.payload&&typeof x.payload==='object')?x:null;}catch(e){return null;}}
function snapWrite(uid,payload,ts){try{localStorage.setItem(snapKey(uid),JSON.stringify({ts,payload}));return true;}catch(e){return false;}}
function snapClearIf(uid,ts){try{const x=snapRead(uid);if(x&&x.ts===ts)localStorage.removeItem(snapKey(uid));}catch(e){}}
// On load: local snapshot wins only if it is at least as new as the cloud copy; otherwise it is parked (never silently deleted).
function snapPick(uid,cloud){
  const x=snapRead(uid);if(!x)return null;
  if(Number(x.ts)>=(Number(cloud&&cloud.savedAt)||0))return x.payload;
  try{localStorage.setItem('lifts_snapconflict_'+uid,JSON.stringify(x));localStorage.removeItem(snapKey(uid));}catch(e){}
  toast('Cloud has newer data — older local changes were set aside');
  return null;
}
function withTimeout(p,ms){
  return new Promise((res,rej)=>{
    const t=setTimeout(()=>rej(new Error('save timeout')),ms);
    p.then(v=>{clearTimeout(t);res(v);},e=>{clearTimeout(t);rej(e);});
  });
}
function svFailed(sv,e){
  console.error('Save error',e);
  if(sv!==SV)return;
  const permanent=/^(permission-denied|invalid-argument|unauthenticated|failed-precondition)$/.test(String((e&&e.code)||''));
  sv.fails++;
  if(permanent||sv.fails>SAVE_MAX_RETRIES){toast('Cloud save failed — changes kept on this device');return;} // stop auto-retrying; the next change or flush tries again
  toast('Cloud save failed — retrying…');
  clearTimeout(sv.retry);
  sv.retry=setTimeout(()=>{sv.retry=null;if(svLive(sv))drain(sv);},Math.min(60000,5000*Math.pow(2,sv.fails-1)));
}
function drain(sv){
  if(sv.job)return sv.job;
  let job;
  job=Promise.resolve().then(async()=>{
    if(sv===SV)showSync(true);
    try{
      while(sv.saved<sv.rev){
        if(!svLive(sv))return false;                 // signed out / switched / not loaded: write nothing, data stays in the local snapshot
        const rev=sv.rev, ts=svStamp(sv);
        const payload=buildPayload(ts);              // newest state, captured synchronously
        const ids=new Set(WORKOUTS.map(w=>w.id));
        snapWrite(sv.uid,payload,ts);
        try{ await withTimeout(userRef(sv.uid).set(payload),SAVE_TIMEOUT_MS); }
        catch(e){ svFailed(sv,e); return false; }
        sv.saved=Math.max(sv.saved,rev);sv.fails=0;
        pendingPrune(sv.uid,ids);                    // completed-workout backups are removed only after a confirmed write
        snapClearIf(sv.uid,ts);                      // kept if a newer local snapshot was written during the write
      }
      return true;
    }finally{ if(sv.job===job)sv.job=null; if(sv===SV)showSync(false); }
  });
  sv.job=job;
  return job;
}
function scheduleSave(){
  const sv=SV;
  if(!currentUser||!sv||sv.uid!==currentUser.uid)return;
  sv.rev++;sv.fails=0;
  clearTimeout(sv.retry);sv.retry=null;              // a newer change supersedes any waiting retry (the debounce below saves everything)
  clearTimeout(sv.timer);
  if(dataLoadedUid===sv.uid){const ts=svStamp(sv);snapWrite(sv.uid,buildPayload(ts),ts);}
  sv.timer=setTimeout(()=>{sv.timer=null;if(svLive(sv))drain(sv);},900);
}
// Resolves true ONLY if every change made so far is confirmed written to the cloud; false otherwise (data stays in the local snapshot).
function flushSave(){
  const sv=SV;
  if(!sv)return Promise.resolve(true);
  clearTimeout(sv.timer);sv.timer=null;
  clearTimeout(sv.retry);sv.retry=null;
  if(sv.saved>=sv.rev&&!sv.job)return Promise.resolve(true);
  return drain(sv).then(()=>sv.saved>=sv.rev,()=>false);
}
window.addEventListener('online',()=>{
  const sv=SV;
  if(svLive(sv)&&sv.saved<sv.rev){sv.fails=0;clearTimeout(sv.retry);sv.retry=null;drain(sv);}
});

function showSync(on){
  document.getElementById('sync-bar').classList.toggle('show',on);
}

// ── Auth state ────────────────────────────────────────
auth.onAuthStateChanged(user=>{
  if(user){
    const prevUid=currentUser&&currentUser.uid;
    if(prevUid!==user.uid)p1SwitchUser(); // different account → wipe every trace of the previous one first
    currentUser=user;
    if(prevUid===user.uid&&dataLoadedUid===user.uid&&SV&&SV.uid===user.uid)return; // same account re-announced: never reload over unsaved in-memory state
    if(!SV||SV.uid!==user.uid)SV=newSV(user.uid);
    document.getElementById('auth-screen').style.display='none';
    document.getElementById('app').style.display='block';
    document.getElementById('tabbar').style.display='grid';
    const fullName=user.displayName||user.email||'';
    const name=fullName.split('@')[0].slice(0,8);
    const ub=document.getElementById('user-btn');if(ub)ub.textContent=name||'Profile';
    const sideName=document.getElementById('sidebar-name');if(sideName)sideName.textContent=fullName.split('@')[0]||'Your account';
    const sideAvatar=document.getElementById('sidebar-avatar');if(sideAvatar)sideAvatar.textContent=(fullName.split('@')[0].slice(0,2)||'?').toUpperCase();
    loadUserData(user.uid);
  } else {
    currentUser=null;
    p1SwitchUser();
    document.getElementById('auth-screen').style.display='flex';
    document.getElementById('app').style.display='none';
    document.getElementById('tabbar').style.display='none';
  }
});

// ── Auth actions ─────────────────────────────────────
function switchTab(mode){
  authMode=mode;
  document.querySelectorAll('.auth-tab').forEach((t,i)=>{
    t.classList.toggle('on',(mode==='login'&&i===0)||(mode==='signup'&&i===1));
  });
  const p2wrap=document.getElementById('pass2-wrap');
  if(p2wrap) p2wrap.style.display=mode==='signup'?'block':'none';
  document.getElementById('auth-btn-label').textContent=mode==='login'?'Sign In':'Create Account';
  document.getElementById('auth-err').textContent='';
  const fw=document.getElementById('forgot-wrap');
  if(fw) fw.style.display=mode==='login'?'block':'none';
}

function togglePass(id,btn){
  const inp=document.getElementById(id);
  if(!inp)return;
  inp.type=inp.type==='password'?'text':'password';
  btn.textContent=inp.type==='password'?'SHOW':'HIDE';
}

async function doForgot(){
  const email=document.getElementById('auth-email').value.trim();
  const errEl=document.getElementById('auth-err');
  const loadEl=document.getElementById('auth-loading');
  if(!email){errEl.textContent='Enter your email above first';return;}
  if(!auth){errEl.textContent='Service unavailable';return;}
  errEl.textContent='';
  loadEl.textContent='Sending reset email...';
  try{
    await auth.sendPasswordResetEmail(email);
    errEl.style.color='var(--ac)';
    errEl.textContent='Reset email sent! Check your inbox.';
    setTimeout(()=>{errEl.style.color='var(--rd)';errEl.textContent='';},5000);
  }catch(e){
    errEl.textContent=friendlyErr(e.code||'unknown');
  }
  loadEl.textContent='';
}

async function doAuth(){
  const emailEl=document.getElementById('auth-email');
  const passEl=document.getElementById('auth-pass');
  const pass2El=document.getElementById('auth-pass2');
  const err=document.getElementById('auth-err');
  const loading=document.getElementById('auth-loading');
  const email=(emailEl?emailEl.value:'').trim();
  const pass=passEl?passEl.value:'';
  const pass2=pass2El?pass2El.value:'';
  err.textContent='';
  if(!email||!pass){err.textContent='Please fill in all fields';return;}
  if(authMode==='signup'&&pass!==pass2){err.textContent='Passwords do not match';return;}
  if(pass.length<6){err.textContent='Password must be at least 6 characters';return;}
  loading.textContent='Please wait...';
  try{
    if(authMode==='login') await auth.signInWithEmailAndPassword(email,pass);
    else await auth.createUserWithEmailAndPassword(email,pass);
  }catch(e){
    console.error('Auth error:',e.code, e.message);
    err.textContent=friendlyErr(e.code||'unknown');
  }
  loading.textContent='';
}

async function doGoogle(){
  const errEl=document.getElementById('auth-err');
  const loadEl=document.getElementById('auth-loading');
  errEl.textContent='';
  loadEl.textContent='Opening Google...';
  try{
    const provider=new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({prompt:'select_account'});
    await auth.signInWithPopup(provider);
    loadEl.textContent='';
  }catch(e){
    if(e.code==='auth/popup-closed-by-user'||e.code==='auth/cancelled-popup-request'){
      errEl.textContent='Cancelled — please try again';
    } else {
      errEl.textContent=friendlyErr(e.code||'unknown');
    }
    loadEl.textContent='';
  }
}

async function doSignOut(){
  if(!confirm('Sign out?'))return;
  // push pending changes to THIS user's document before the account changes (4s cap so offline can't hang sign-out)
  if(currentUser){
    const uid=currentUser.uid;
    let saved=false;
    try{ saved=await Promise.race([flushSave(),new Promise(r=>setTimeout(()=>r(false),4000))]); }catch(e){}
    if(!saved){
      const kept=!!snapRead(uid);
      if(!confirm(kept?'Your latest changes are NOT in the cloud yet. A backup is stored on this device and will upload the next time you sign in to this account here. Sign out anyway?'
                      :'Your latest changes could not be saved. Sign out anyway and lose them?'))return;
    }
  }
  await auth.signOut();
  // Reset app state
  CATS=[];EX={};DATA={};
  // Reset auth UI fully so Google button works again
  document.getElementById('auth-email').value='';
  document.getElementById('auth-pass').value='';
  document.getElementById('auth-pass2').value='';
  document.getElementById('auth-err').textContent='';
  document.getElementById('auth-loading').textContent='';
  document.getElementById('auth-btn-label').textContent='Sign In';
  document.getElementById('auth-pass2').style.display='none';
  authMode='login';
  document.querySelectorAll('.auth-tab').forEach((t,i)=>t.classList.toggle('on',i===0));
}

function friendlyErr(code){
  return({
    'auth/invalid-email':'Invalid email address',
    'auth/user-not-found':'No account with that email',
    'auth/wrong-password':'Incorrect password',
    'auth/invalid-credential':'Wrong email or password',
    'auth/email-already-in-use':'Email already registered — sign in instead',
    'auth/weak-password':'Password too weak (min 6 chars)',
    'auth/popup-closed-by-user':'Google sign-in cancelled',
    'auth/network-request-failed':'Network error — check connection',
    'auth/too-many-requests':'Too many attempts — try again later',
  })[code]||'Error: '+code;
}

// ── Boot app ─────────────────────────────────────────
// ── ONBOARDING ───────────────────────────────────────
// Guides a brand-new account through 3 steps using existing modals — no new
// data structures, just a conditional banner based on current CATS/EX/DATA state.
function renderOnboarding(){
  const wrap=document.getElementById('onboard-wrap');if(!wrap)return;
  wrap.innerHTML='';

  if(DATA._onboardingSkipped)return;

  const hasCat=CATS.length>0;
  const hasEx=CATS.some(c=>(EX[c.id]||[]).length>0);
  const hasLog=Object.keys(DATA).some(n=>!n.startsWith('_')&&sessionsFor(n).length>0);

  let step;
  if(!hasCat)step=1;
  else if(!hasEx)step=2;
  else if(!hasLog)step=3;
  else return; // fully done — nothing to show, ever again

  const steps=document.createElement('div');steps.className='ob-steps';
  for(let i=1;i<=3;i++){
    const s=document.createElement('div');
    s.className='ob-step'+(i<step?' done':i===step?' current':'');
    steps.appendChild(s);
  }

  const card=document.createElement('div');card.className='ob-card';
  const num=document.createElement('div');num.className='ob-num';num.textContent='Step '+step+' of 3';
  const title=document.createElement('div');title.className='ob-title';
  const sub=document.createElement('div');sub.className='ob-sub';
  const btn=document.createElement('button');btn.className='ob-btn';

  if(step===1){
    title.textContent='Add your first category';
    sub.textContent="Categories group your exercises — like Push, Pull, or Legs. Let's create one to get started.";
    btn.textContent='+ Add Category';
    btn.addEventListener('click',()=>openModal('newcat'));
  } else if(step===2){
    title.textContent='Add your first exercise';
    sub.textContent='Now add an exercise to "'+(CATS[0]?CATS[0].label:'your category')+'" — like Bench Press or Squat.';
    btn.textContent='+ Add Exercise';
    btn.addEventListener('click',()=>{
      const cat=CATS[0];if(!cat)return;
      openAddExModal(cat.id);
    });
  } else if(step===3){
    title.textContent='Log your first set';
    sub.textContent='Almost there — tap an exercise below and log your first set.';
    btn.style.display='none';
  }

  card.appendChild(num);card.appendChild(title);card.appendChild(sub);
  if(btn.style.display!=='none')card.appendChild(btn);

  const skip=document.createElement('button');skip.className='ob-skip';skip.textContent='Skip setup for now';
  skip.addEventListener('click',()=>{
    DATA._onboardingSkipped=true;
    scheduleSave();
    renderOnboarding();
  });
  card.appendChild(skip);

  wrap.appendChild(steps);
  wrap.appendChild(card);
}

let logDateAuto=null; // the auto-filled quick-log date; refreshed after midnight only while the user hasn't picked another date
function bootApp(){
  applySavedProfilePrefs();
  const step=(name,fn)=>{ try{ fn(); }catch(e){ console.error(name+' failed:',e); } };
  step('set logdate',()=>{ logDateAuto=localISO(); document.getElementById('logdate').value=logDateAuto; });
  step('buildCatPills',buildCatPills);
  step('renderPicker',renderPicker);
  step('buildProgSel',buildProgSel);
  step('renderMuscleSets',renderMuscleSets);
  step('renderOnboarding',renderOnboarding);
  step('p1Boot',p1Boot);
  step('refreshOpenScreen',()=>{ const cur=document.querySelector('.scr.on'); if(cur) go(cur.id.replace('s-','')); });
}

// ── Helpers ──────────────────────────────────────────
const catById  = id=>CATS.find(c=>c.id===id);
const catColor = id=>catById(id)?.color||'#888';
const catLabel = id=>catById(id)?.label||id;
const primCat  = name=>{for(const c of CATS)if((EX[c.id]||[]).includes(name))return c.id;return CATS[0]?.id||'other';};
const allNames = ()=>[...new Set(CATS.flatMap(c=>EX[c.id]||[]))].sort();
// ── Safe rendering ────────────────────────────────────
// Values that come from the user or Firestore (exercise/category names, dates, weights, units, reps…) are only ever put
// into the page with textContent / createElement / CSSOM — never concatenated into an HTML string.
// The only markup still parsed from a string is the weight-chart SVG (numbers + constants); it goes through this strict allowlist.
const SVG_OK_EL=new Set(['svg','defs','lineargradient','stop','line','text','path','circle','rect','g','polyline']);
const SVG_OK_ATTR=new Set(['class','viewbox','xmlns','id','x','y','x1','x2','y1','y2','cx','cy','r','d','fill','stroke','stroke-width','stroke-dasharray','stroke-linejoin','stroke-linecap','text-anchor','offset','stop-color','stop-opacity','width','height','points','style']);
function appendTrustedSvg(parent,svgStr){
  let doc;try{doc=new DOMParser().parseFromString(svgStr,'image/svg+xml');}catch(e){return null;}
  const root=doc.documentElement;
  if(!root||root.localName!=='svg'||doc.getElementsByTagName('parsererror').length)return null;
  const clean=el=>{
    Array.from(el.children).forEach(ch=>{if(!SVG_OK_EL.has(ch.localName.toLowerCase())){ch.remove();return;}clean(ch);});
    Array.from(el.attributes).forEach(a=>{
      const n=a.name.toLowerCase();
      if(!SVG_OK_ATTR.has(n)||(n==='style'&&!/^[\w\s:;#.,%()-]*$/.test(a.value))||/javascript:|url\((?!#)/i.test(a.value))el.removeAttribute(a.name);
    });
  };
  clean(root);
  const node=document.importNode(root,true);parent.appendChild(node);return node;
}
// Colours loaded from saved data are applied via CSSOM; accept only plain colour syntax so a tampered value can't be
// something like url(https://…) that would make the browser fetch an outside address.
const safeColor=c=>(typeof c==='string'&&/^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%\/-]+\)|[a-z]{3,20})$/i.test(c.trim()))?c.trim():'#888';
const fmtDate  = d=>{if(!d||typeof d!=='string')return'';const[,m,dy]=d.split('-');const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1];return mo?mo+' '+ +dy:d;};
// ── UNIT NORMALIZATION (BEGIN) ───────────────────────
// Stored weights are NEVER converted. Everything that compares / sorts / divides
// weights goes through these helpers so kg and lb are always compared in kg.
// Missing / unknown unit => 'kg' (the app's historical default).
const KG_PER_LB=0.45359237;
const WEIGHT_EPS_KG=0.01; // 10 g — absorbs rounding like 66.14 lb vs 30 kg, far below any real plate increment
const unitOf=u=>(typeof u==='string'&&/^lbs?$/i.test(u.trim()))?'lb':'kg';
function toKg(weight,unit='kg'){
  const w=Number(weight);
  if(!isFinite(w))return 0;
  return unitOf(unit)==='lb'?w*KG_PER_LB:w;
}
function fromKg(weight,unit='kg'){
  const w=Number(weight);
  if(!isFinite(w))return 0;
  return unitOf(unit)==='lb'?w/KG_PER_LB:w;
}
// Convert between units; returns the value untouched when units already match (no float noise).
function convertWeight(w,from,to){
  return unitOf(from)===unitOf(to)?Number(w):fromKg(toKg(w,from),to);
}
// -1 / 0 / 1 : is weight A lighter / equal / heavier than weight B (unit-safe, tolerance-aware)
function compareWeights(aW,aU,bW,bU){
  const d=toKg(aW,aU)-toKg(bW,bU);
  return Math.abs(d)<=WEIGHT_EPS_KG?0:(d>0?1:-1);
}
// -1 / 0 / 1 : is set A worse / equal / better than set B (weight first, reps as tie-breaker)
function compareSets(a,b){
  const c=compareWeights(a.weight,a.unit,b.weight,b.unit);
  if(c!==0)return c;
  const ra=Number(a.reps)||0, rb=Number(b.reps)||0;
  return ra===rb?0:(ra>rb?1:-1);
}
// ── UNIT NORMALIZATION (END) ─────────────────────────
// Unit switches in the entry forms (log rows, goal field, body-weight picker) convert FROM an exact base value each time:
// the number the user typed, or the stored value the field was filled from. kg→lb→kg therefore returns the original digits
// instead of re-rounding an already-rounded number, and a switch never just relabels a number as the other unit.
const fmtW=n=>String(+Number(n).toFixed(2));                                          // up to 2 decimals, no trailing zeros
const rowFromSet=s=>({w:String(s.weight),r:String(s.reps),u:unitOf(s.unit),o:{w:Number(s.weight),u:unitOf(s.unit),shown:String(s.weight)}});
const getPR    = sessions=>{let pr=null;sessions.forEach(s=>(s.sets||[]).forEach(set=>{if(!pr||compareSets(set,pr)>0)pr={...set,unit:unitOf(set.unit),date:s.date};}));return pr;};
const bestSet  = sess=>(sess.sets&&sess.sets.length)?sess.sets.reduce((b,s)=>compareSets(s,b)>0?s:b,sess.sets[0]):{weight:0,reps:0,unit:'kg'};

let toastTimer=null;
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('on');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('on'),2200);
}

// ── Cat pills ────────────────────────────────────────
function buildCatPills(){
  const w=document.getElementById('catpills');w.innerHTML='';
  const mk=(id,label)=>{
    const b=document.createElement('button');
    b.className='pill'+(selDay===id?' on':'');
    b.textContent=label;
    b.onclick=()=>{selDay=id;document.querySelectorAll('.pill').forEach(p=>p.classList.remove('on'));b.classList.add('on');renderPicker();};
    w.appendChild(b);
  };
  mk('all','All');
  const activeSplit=SPLITS.find(s=>s.id===activeSplitId);
  const visibleCats=activeSplit?CATS.filter(c=>(activeSplit.catIds||[]).includes(c.id)):CATS;
  // if a split filtered out the category currently selected, fall back to "all"
  if(selDay!=='all'&&!visibleCats.some(c=>c.id===selDay))selDay='all';
  visibleCats.forEach(c=>mk(c.id,c.label));
}

// ── LOG ──────────────────────────────────────────────
function renderPicker(){
  const q=document.getElementById('exsearch').value.toLowerCase();
  const w=document.getElementById('picker');
  if(selEx){w.innerHTML='';return;}
  w.innerHTML='';
  let list=selDay==='all'?allNames():[...(EX[selDay]||[])];
  if(q)list=list.filter(n=>n.toLowerCase().includes(q));
  if(!list.length){w.innerHTML='<div class="empty">No exercises found</div>';return;}
  list.forEach(name=>{
    try{
      const cat=primCat(name);
      const ctxCat=selDay==='all'?cat:selDay;
      // Always show the exercise's true shared history/PR, regardless of which
      // category tab you're viewing from — weight and PR are the same everywhere.
      const sessions=sessionsFor(name);
      const last=sessions.slice(-1)[0];
      const pr=sessions.length?getPR(sessions):null;
      const b=document.createElement('button');b.className='pitem';
      const dot=document.createElement('span');dot.className='dot';dot.style.background=catColor(cat);
      const inner=document.createElement('span');inner.style.cssText='display:flex;flex-direction:column;gap:3px;flex:1';
      const n=document.createElement('span');n.textContent=name;
      const sub=document.createElement('span');sub.style.cssText='font-size:.57rem;color:var(--m1)';
      if(last){
        sub.appendChild(document.createTextNode(last.date+' · '+(last.sets||[]).map(s=>s.weight+(s.unit||'')+'×'+s.reps).join(', ')+(pr?' ':'')));
        if(pr){const prs=document.createElement('span');prs.style.color='var(--ac)';prs.textContent='· PR '+pr.weight+pr.unit+'×'+pr.reps;sub.appendChild(prs);}
      } else {
        sub.textContent='No history';
      }
      inner.appendChild(n);inner.appendChild(sub);
      b.appendChild(dot);b.appendChild(inner);
      b.addEventListener('click',()=>selectEx(name,ctxCat));
      w.appendChild(b);
    }catch(e){
      console.error('renderPicker item error for "'+name+'":',e);
      const b=document.createElement('button');b.className='pitem';
      b.style.borderColor='var(--rd,#ff5c5c)';
      const n=document.createElement('span');n.textContent=name;
      const sub=document.createElement('span');sub.style.cssText='font-size:.57rem;color:var(--rd,#ff5c5c);display:block';
      sub.textContent='⚠ Data error: '+e.message+' — tap to reset this exercise\'s history';
      const inner=document.createElement('span');inner.style.cssText='display:flex;flex-direction:column;gap:3px;flex:1';
      inner.appendChild(n);inner.appendChild(sub);
      b.appendChild(inner);
      b.addEventListener('click',()=>{
        if(confirm('This exercise\'s saved data is corrupted and can\'t be read. Reset its history so you can log it again? (This clears old sessions for "'+name+'" only.)')){
          delete DATA[name];
          scheduleSave();
          toast('Reset — try logging it again');
          renderPicker();
        }
      });
      w.appendChild(b);
    }
  });
}

// Returns a normalized, flat, date-sorted session array for an exercise —
// self-healing in case DATA[name] is still sitting in an old shape that the
// startup migration missed (so a stale entry can never silently break logging).
function sessionsFor(name){
  const v=DATA[name];
  if(!v)return [];
  const clean=arr=>arr
    .filter(s=>s&&s.date) // drop anything without even a date — unusable
    .map(s=>({...s,sets:Array.isArray(s.sets)?s.sets.filter(x=>x&&typeof x.weight==='number'&&typeof x.reps==='number'):[]}))
    .filter(s=>s.sets.length); // drop sessions that ended up with zero valid sets
  if(Array.isArray(v))return clean(v);
  if(typeof v==='object'){
    let flat=[];
    Object.keys(v).forEach(catId=>{
      (v[catId]||[]).forEach(s=>flat.push({...s,cat:catId}));
    });
    flat=clean(flat);
    flat.sort((a,b)=>a.date.localeCompare(b.date));
    DATA[name]=flat; // fix it in place so this only ever happens once
    return flat;
  }
  return [];
}

function selectEx(name,catId){
  try{
    selEx=name;selCatCtx=catId;sets=[];logLast=null;
    document.getElementById('lftitle').textContent=name+(catId?' · '+catLabel(catId):'');
    document.getElementById('logwrap').style.display='block';
    document.getElementById('picker').innerHTML='';
    document.getElementById('exsearch').style.display='none';
    document.getElementById('catpills').style.display='none';
    // Prefill from the exercise's true last session (shared across all categories),
    // so weight/reps are always consistent no matter which tab you logged from.
    const last=sessionsFor(name).slice(-1)[0];
    if(last){
      last.sets.forEach(s=>sets.push(rowFromSet(s)));
      if(last.sets[0])setUnit(last.sets[0].unit||'kg');
    }else sets.push({w:'',r:'',u:unit});
    renderSets();
  }catch(e){
    console.error('selectEx error:',e);
    toast('Could not open exercise: '+e.message);
  }
}

function cancelLog(){
  hideWarmup();
  selEx=null;selCatCtx=null;sets=[];logLast=null;
  document.getElementById('logwrap').style.display='none';
  document.getElementById('exsearch').style.display='block';
  document.getElementById('catpills').style.display='flex';
  renderPicker();
  if(wkReturn){wkReturn=false;go('workout');} // opened from the active workout → go back to it
}

function setUnit(u){
  u=unitOf(u);
  sets.forEach(st=>{
    const o=st.o;
    if(o&&st.w===o.shown){ // the row still shows its base value → show the same weight in the new unit
      st.w=(unitOf(o.u)===u)?String(o.w):fmtW(convertWeight(o.w,o.u,u));
      o.shown=st.w;
    }
    if(st.lw!=null&&st.lu&&st.lu!==u){ st.lw=Math.round(convertWeight(st.lw,st.lu,u)*100)/100; st.lu=u; } // keep "last time" placeholders in the shown unit
    st.u=u;
  });
  unit=u;
  document.getElementById('ukg').classList.toggle('on',u==='kg');
  document.getElementById('ulb').classList.toggle('on',u==='lb');
  renderSets();
}

function renderSets(){
  const w=document.getElementById('slist');w.innerHTML='';
  // Inside a workout, the previous session is only a reference: its numbers stay as input
  // placeholders, so they can never be saved as if they were sets done in this workout.
  if(logLast&&Array.isArray(logLast.sets)&&logLast.sets.length){
    const hint=document.createElement('div');hint.className='lasthint';
    hint.textContent='Last session'+(logLast.date?' ('+fmtDate(logLast.date)+')':'')+': '+
      logLast.sets.map(s=>fmtW(s.weight)+(s.unit||'kg')+' × '+s.reps).join(' · ');
    w.appendChild(hint);
  }
  sets.forEach((st,i)=>{
    const row=document.createElement('div');row.className='srow';
    const num=document.createElement('div');num.className='snum';num.textContent=i+1;
    const wi=document.createElement('input');wi.className='sinp';wi.type='number';wi.step='.5';wi.min='0';wi.inputMode='decimal';
    wi.placeholder=(st.w===''&&st.lw!=null)?fmtW(st.lw)+' '+unit:'Weight ('+unit+')';wi.value=st.w;
    wi.addEventListener('input',()=>{sets[i].w=wi.value;sets[i].u=unit;const n=parseFloat(wi.value);sets[i].o=isFinite(n)?{w:n,u:unit,shown:wi.value}:null;});
    const ri=document.createElement('input');ri.className='sinp';ri.type='number';ri.min='1';ri.inputMode='numeric';
    ri.placeholder=(st.r===''&&st.lr!=null)?String(st.lr):'Reps';ri.value=st.r;
    ri.addEventListener('input',()=>{sets[i].r=ri.value;});
    const db=document.createElement('button');db.className='dsbtn';db.textContent='✕';
    db.addEventListener('click',()=>{if(sets.length>1){sets.splice(i,1);renderSets();}});
    row.appendChild(num);row.appendChild(wi);row.appendChild(ri);row.appendChild(db);
    w.appendChild(row);
  });
}

function addSet(){
  const last=sets.slice(-1)[0];
  sets.push({w:last?last.w:'',r:last?last.r:'',u:unit,o:(last&&last.o)?{...last.o}:null});
  renderSets();
}

function saveLog(){
  try{
    if(!selEx)return;
    const valid=sets.filter(s=>s.w!==''&&s.r!=='');
    if(!valid.length){toast('Add at least one set');return;}
    const date=document.getElementById('logdate').value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!isoOf(date)){toast('Pick a valid date');return;}
    const catId=selCatCtx||primCat(selEx);
    const exName=selEx;
    const arr=sessionsFor(exName);
    DATA[exName]=arr; // ensure it's normalized/attached even if it was empty before
    const aw=ACTIVE_WORKOUT;
    const wid=(aw&&date===aw.date)?aw.id:null; // sets logged inside a workout belong to that workout's own session
    if(wid)wkCapturePRBaseline(aw,exName); // capture BEFORE these sets enter the shared exercise history
    // Each workout keeps its own entry (wid), so starting a new workout can never append its sets
    // to an earlier session — even when both happen on the same day. Quick logs outside a
    // workout keep the original one-entry-per-exercise/date/category behaviour.
    const idx=wid?arr.findIndex(e=>e.wid===wid&&e.cat===catId):arr.findIndex(e=>e.date===date&&e.cat===catId);
    const entry={date,cat:catId,sets:valid.map(s=>({weight:parseFloat(s.w),reps:parseInt(s.r),unit:s.u||unit}))};
    const dataEntry=wid?{...entry,wid}:entry;
    if(idx>=0)arr[idx]=dataEntry;else arr.push(dataEntry);
    arr.sort((a,b)=>a.date.localeCompare(b.date));
    scheduleSave();toast('Saved ✓');
    wkRecordLogged(exName,catId,entry);
    startTimer(exName);
    cancelLog();buildProgSel();renderMuscleSets();renderOnboarding();
    checkExerciseGoalCelebration(exName);
  }catch(e){
    console.error('saveLog error:',e);
    toast('Save failed: '+e.message);
  }
}

// ── HISTORY ──────────────────────────────────────────
function renderHistory(){
  const q=document.getElementById('hsearch').value.toLowerCase();
  const w=document.getElementById('hlist');w.innerHTML='';
  const nW=renderWorkoutHistory(w,q);
  let names=Object.keys(DATA).filter(n=>!n.startsWith('_')&&sessionsFor(n).length);
  if(q)names=names.filter(n=>n.toLowerCase().includes(q));
  if(!names.length&&!nW){w.innerHTML='<div class="empty">Nothing logged yet</div>';return;}
  if(nW&&names.length)w.appendChild(mk('div','m-slabel','By exercise'));
  names.sort().forEach(name=>{
    const sessions=sessionsFor(name);if(!sessions.length)return;
    const pr=getPR(sessions);
    const el=document.createElement('div');el.className='hent';
    const hdr=document.createElement('div');hdr.className='hhdr';
    const hdot=document.createElement('span');hdot.className='dot';hdot.style.background=catColor(primCat(name));
    hdr.append(hdot,mk('span','hname',name),mk('span','hmeta',sessions.length+' session'+(sessions.length>1?'s':'')),mk('span','hchev','▼'));
    hdr.addEventListener('click',()=>el.classList.toggle('op'));
    const body=document.createElement('div');body.className='hbody';
    sessions.slice().reverse().forEach(s=>{
      const blk=document.createElement('div');blk.className='sblk';
      const chips=document.createElement('div');chips.className='schips';
      s.sets.forEach(set=>{
        const isPR=pr&&s.date===pr.date&&set.reps===pr.reps&&compareWeights(set.weight,set.unit,pr.weight,pr.unit)===0;
        const chip=mk('span','chip',set.weight+(set.unit||'kg')+' × '+set.reps);
        if(isPR)chip.appendChild(mk('span','prbadge','PR'));
        chips.appendChild(chip);
      });
      const sdate=mk('div','sdate',fmtDate(s.date)+' ');
      const stag=mk('span',null,'· '+catLabel(s.cat));stag.style.cssText='color:var(--m1);font-size:.55rem';
      sdate.appendChild(stag);
      blk.append(sdate,chips);
      body.appendChild(blk);
    });
    const db=document.createElement('button');db.className='btn brd';db.style.cssText='font-size:.55rem;padding:6px 11px;margin-top:6px';db.textContent='Delete all logs';
    db.addEventListener('click',()=>{
      if(!confirm('Delete all logs for "'+name+'"?'))return;
      delete DATA[name];scheduleSave();renderHistory();buildProgSel();renderMuscleSets();toast('Deleted');
    });
    body.appendChild(db);el.appendChild(hdr);el.appendChild(body);w.appendChild(el);
  });
}

// ── SETS BY MUSCLE ───────────────────────────────────
function renderMuscleSets(){
  const wrap=document.getElementById('msets-wrap');if(!wrap)return;
  wrap.innerHTML='';

  const list=allMuscles();
  if(!list.length)return;

  const max=Math.max(1,...list.map(m=>MSETS[m.id]||0));

  const card=document.createElement('div');card.className='msets-card';
  const title=document.createElement('div');title.className='msets-title';title.textContent='Sets by Muscle';
  card.appendChild(title);
  card.appendChild(buildBodyMap(MSETS,max));

  list.forEach(m=>{
    const count=MSETS[m.id]||0;
    const pct=Math.round(count/max*100);
    const row=document.createElement('div');row.className='msets-row';

    const label=document.createElement('div');label.className='msets-label';label.textContent=m.label;

    const barbg=document.createElement('div');barbg.className='msets-barbg';
    const barfill=document.createElement('div');barfill.className='msets-barfill';barfill.style.width=pct+'%';
    barbg.appendChild(barfill);

    const minus=document.createElement('button');minus.className='msets-stepbtn';minus.textContent='−';
    minus.addEventListener('click',()=>{
      MSETS[m.id]=Math.max(0,(MSETS[m.id]||0)-1);
      scheduleSave();renderMuscleSets();
    });

    const countEl=document.createElement('div');countEl.className='msets-count';countEl.textContent=count+' set'+(count!==1?'s':'');

    const plus=document.createElement('button');plus.className='msets-stepbtn';plus.textContent='+';
    plus.addEventListener('click',()=>{
      MSETS[m.id]=(MSETS[m.id]||0)+1;
      scheduleSave();renderMuscleSets();
    });

    row.appendChild(label);row.appendChild(barbg);row.appendChild(minus);row.appendChild(countEl);row.appendChild(plus);
    card.appendChild(row);
  });

  wrap.appendChild(card);
}

// ── PROGRESS ─────────────────────────────────────────
// ── BODY MAP ─────────────────────────────────────────
const BM_COLORS=['#3a3a3a','#3f4d14','#6f8814','#a9c81e','#e8ff47'];
const BM_WORKOUT_COLORS=['#37373b','#286239','#2b8d43','#33b351','#3bd65e'];
// Anatomy outlines: MuscleMap by Melih Colpan (MIT License, (c) 2026 Melih Colpan).
// Male front viewBox starts at x=0, male back at x=718; both share y=95..1375.
// which of OUR muscle ids each outline drives (anything not listed is just body outline)
const BM_MAP={f:{chest:'chest',abs:'abs',obliques:'abs',biceps:'biceps',triceps:'triceps',quadriceps:'quads',adductors:'adductors',calves:'calves',tibialis:'calves',forearm:'forearms',trapezius:'traps'},
              b:{trapezius:'traps',upperBack:'lats',lowerBack:'lowerback',triceps:'triceps',forearm:'forearms',gluteal:'glutes',adductors:'adductors',hamstring:'hamstrings',calves:'calves'}};
let bmSerial=0; // every SVG needs its own gradient ids, including hidden Progress / History maps
function bmLevel(count,max){
  if(!Number.isFinite(count)||count<=0)return 0;
  const peak=Number.isFinite(max)&&max>0?max:count;
  return Math.max(1,Math.min(4,Math.ceil(count/peak*4)));
}
function buildBodyMap(counts,max,workout=false){
  const wrap=document.createElement('div');wrap.className='bodymap';
  try{
    const colors=workout?BM_WORKOUT_COLORS:BM_COLORS;
    const col=id=>colors[bmLevel(counts[id]||0,max)];
    const INERT=workout?colors[0]:'#2a2a2a', ST=workout?'#101012':'#141414', prefix='bm-'+(++bmSerial)+'-';
    let defs='', inert='', muscles='';
    ['f','b'].forEach(view=>{
      const map=BM_MAP[view];
      Object.keys(BM_DATA[view]).forEach(slug=>{
        BM_DATA[view][slug].forEach((d,i)=>{
          const attrs=' stroke="'+ST+'" stroke-width="2" stroke-linejoin="round"';
          if(slug==='deltoids'){
            // index 0 = left shoulder on screen, 1 = right; split outer half = side delt, inner half = front/rear delt
            const inner=col(view==='f'?'frontdelts':'reardelts'), outer=col('sidedelts');
            const a=i%2===0?outer:inner, b=i%2===0?inner:outer;
            const gid=prefix+view+i;
            defs+='<linearGradient id="'+gid+'" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="'+a+'"/><stop offset=".5" stop-color="'+a+'"/><stop offset=".5" stop-color="'+b+'"/><stop offset="1" stop-color="'+b+'"/></linearGradient>';
            muscles+='<path d="'+d+'" fill="url(#'+gid+')"'+attrs+'/>';
          } else if(map[slug]){
            muscles+='<path d="'+d+'" fill="'+col(map[slug])+'"'+attrs+'/>';
          } else {
            inert+='<path d="'+d+'" fill="'+INERT+'"'+attrs+'/>';
          }
        });
      });
    });
    const svg='<svg viewBox="0 95 1445 1280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Front and back muscle map"><defs>'+defs+'</defs>'+inert+muscles+'</svg>';
    let legend='<div class="bm-legend"><span>'+(workout?'No sets':'Less')+'</span>';
    colors.forEach(c=>{legend+='<span class="bm-sw" style="background:'+c+'"></span>';});
    legend+='<span>'+(workout?'More sets':'More')+'</span></div>';
    wrap.innerHTML='<div class="bm-views"><span>Front</span><span>Back</span></div>'+svg+legend;
  }catch(e){ console.error('buildBodyMap failed:',e); }
  return wrap;
}

// ── PER-WORKOUT MUSCLE MAP ────────────────────────────
// Name rules estimate involvement, not fatigue or recovery. Specific movements precede broad ones.
// Never infer every Push/Pull/Legs muscle from a split: unknown lifts are explicitly left unmapped.
const BM_EXERCISE_RULES=[
  [/\b(reverse pec deck|reverse fl(?:y|ies|yes)|rear delt(?:oid)?s?|face pulls?|band pull aparts?)\b/,['reardelts','traps']],
  [/\b(lateral raises?|side delt(?:oid)?s?)\b/,['sidedelts']],
  [/\bfront raises?\b/,['frontdelts']],
  [/\bupright rows?\b/,['sidedelts','traps']],
  [/\b(shoulder press(?:es)?|overhead press(?:es)?|military press(?:es)?|arnold press(?:es)?|ohp)\b/,['frontdelts','sidedelts','triceps']],
  [/\bshrugs?\b/,['traps']],
  [/\b(leg curls?|hamstring curls?|nordic curls?)\b/,['hamstrings']],
  [/\b(romanian deadlifts?|stiff leg(?:ged)? deadlifts?|rdls?|good mornings?)\b/,['hamstrings','glutes','lowerback']],
  [/\bdeadlifts?\b/,['glutes','hamstrings','lowerback']],
  [/\b(back extensions?|hyperextensions?)\b/,['lowerback','glutes','hamstrings']],
  [/\b(hip thrusts?|glute bridges?|glute kickbacks?|hip abductions?|abductors?)\b/,['glutes']],
  [/\b(adductors?|hip adductions?)\b/,['adductors']],
  [/\b(calf|calves|tibialis)\b/,['calves']],
  [/\b(squats?|leg press(?:es)?|lunges?|step ups?)\b/,['quads','glutes']],
  [/\bleg extensions?\b/,['quads']],
  [/\breverse curls?\b/,['forearms','biceps']],
  [/\b(wrist curls?|wrist extensions?|farmers? (?:s )?(?:carry|carries|walks?))\b/,['forearms']],
  [/\b(hammer curls?|zottman curls?)\b/,['biceps','forearms']],
  [/\b(triceps?|bench dips?|pushdowns?|push downs?|skull crushers?|kickbacks?)\b/,['triceps']],
  [/\b(straight arm pull ?downs?|pullovers?)\b/,['lats']],
  [/\b(pull ?ups?|chin ?ups?|(?:lat )?pull ?downs?)\b/,['lats','biceps']],
  [/\brows?\b/,['lats','reardelts','biceps']],
  [/\bcurls?\b/,['biceps']],
  [/\b(pec deck|pec fl(?:y|ies|yes)|chest fl(?:y|ies|yes)|cable fl(?:y|ies|yes)|dumbbell fl(?:y|ies|yes)|db fl(?:y|ies|yes))\b/,['chest']],
  [/\b(bench(?: press(?:es)?)?|chest press(?:es)?|incline bp|flat bp|decline bp|bp machine|push ?ups?|(?:incline|decline|flat)(?: db| bb| dumbbell| barbell)? press(?:es)?)\b/,['chest','frontdelts','triceps']],
  [/\bdips?\b/,['chest','triceps']],
  [/\b(abs|abdominals|crunch(?:es)?|sit ups?|planks?|leg raises?|knee raises?|wood ?chops?|russian twists?|ab (?:wheel|rollouts?)|dead bugs?)\b/,['abs']]
];
function getExMuscles(name){
  if(typeof name!=='string'||!name.trim())return [];
  const map=DATA&&isObj(DATA._exMuscles)?DATA._exMuscles:null;
  if(map&&Object.hasOwn(map,name)){
    const saved=normMuscleList(map[name]);
    if(saved.length)return saved;
  }
  return [];
}
function setExMuscles(name,muscles){
  if(typeof name!=='string'||!name.trim())return [];
  const clean=normMuscleList(muscles);
  if(!isObj(DATA._exMuscles))DATA._exMuscles={};
  if(clean.length)DATA._exMuscles[name]=clean;
  else delete DATA._exMuscles[name];
  if(clean.length&&Array.isArray(WORKOUTS)){
    WORKOUTS.forEach(w=>{
      (Array.isArray(w?.exercises)?w.exercises:[]).forEach(e=>{
        if(e&&e.name===name)e.muscles=[...clean];
      });
    });
  }
  return clean;
}
function inferWorkoutMuscles(name,cat){
  const saved=getExMuscles(name);
  if(saved.length)return [...saved];
  const normalized=bmName(name);
  const rule=BM_EXERCISE_RULES.find(([pattern])=>pattern.test(normalized));
  if(rule)return [...rule[1]];
  // A custom exercise can still be mapped when its category names a specific muscle.
  const category=bmName(catById(cat)?.label||cat);
  const muscle=MUSCLES.find(m=>bmName(m.id)===category||bmName(m.label)===category);
  const id=muscle?muscle.id:(Object.hasOwn(BM_CATEGORY_ALIASES,category)?BM_CATEGORY_ALIASES[category]:null);
  return id?[id]:[];
}
function workoutMusclesFor(ex){
  const saved=getExMuscles(ex?.name);
  if(saved.length)return [...saved];
  // New records keep a snapshot so renaming an exercise/category cannot change an old map.
  // Legacy records without that snapshot are estimated from their saved exercise names.
  if(Array.isArray(ex.muscles))return [...new Set(ex.muscles.filter(id=>MUSCLES.some(m=>m.id===id)))];
  return inferWorkoutMuscles(ex.name,ex.cat);
}
function workoutMuscleSets(workout){
  const counts={},unmapped=[];
  (Array.isArray(workout?.exercises)?workout.exercises:[]).forEach(ex=>{
    if(!ex||!Array.isArray(ex.sets))return;
    const n=ex.sets.filter(s=>{const v=normSet(s);return v&&v.weight>=0&&v.reps>0;}).length;
    if(!n)return; // planned / unlogged exercises never light up the map
    const ids=workoutMusclesFor(ex);
    if(!ids.length){unmapped.push(String(ex.name||'Unnamed exercise'));return;}
    ids.forEach(id=>{counts[id]=(counts[id]||0)+n;});
  });
  return {counts,unmapped:[...new Set(unmapped)]};
}
function buildWorkoutMuscleCard(workout){
  const {counts,unmapped}=workoutMuscleSets(workout);
  const trained=MUSCLES.filter(m=>counts[m.id]>0).sort((a,b)=>counts[b.id]-counts[a.id]);
  const max=Math.max(1,...Object.values(counts));
  const card=mk('section','wk-muscle-card');
  const head=mk('div','wk-muscle-head');
  head.append(mk('h2','wk-muscle-title','What you just trained'),mk('span','wk-muscle-total',plural(trained.length,'group')));
  const map=buildBodyMap(counts,max,true);
  const svg=map.querySelector('svg');
  if(svg)svg.setAttribute('aria-label','Front and back muscle map for this workout. '+(trained.length?trained.map(m=>m.label+': '+plural(counts[m.id],'set')).join(', '):'No mapped muscles.'));
  card.append(head,map);
  if(trained.length){
    const list=mk('ul','wk-muscle-list');
    trained.forEach(m=>{
      const item=mk('li','wk-muscle-item');
      const dot=mk('span','wk-muscle-dot');dot.style.background=BM_WORKOUT_COLORS[bmLevel(counts[m.id],max)];dot.setAttribute('aria-hidden','true');
      item.append(dot,mk('span',null,m.label),mk('b',null,plural(counts[m.id],'set')));
      list.appendChild(item);
    });
    card.appendChild(list);
  }
  card.appendChild(mk('p','wk-muscle-note',trained.length?'Brighter muscles = more sets this workout. Estimated from logged exercises; a compound set can count toward several muscles.':'No muscle matches yet. Your workout is saved; unrecognized exercises are not highlighted.'));
  if(unmapped.length)card.appendChild(mk('p','wk-muscle-note wk-muscle-unmapped','Not mapped: '+unmapped.join(', ')+'. Edit the exercise in Manage to select the muscles it hits.'));
  return card;
}

function buildProgSel(){
  const sel=document.getElementById('progex');if(!sel)return;
  const prev=sel.value;
  sel.innerHTML='<option value="">— Pick an exercise —</option>';
  Object.keys(DATA).filter(n=>!n.startsWith('_')&&sessionsFor(n).length).sort().forEach(n=>{
    const o=document.createElement('option');o.value=n;o.textContent=n;sel.appendChild(o);
  });
  if(prev)sel.value=prev;
}

function renderProgress(){
  const name=document.getElementById('progex').value;
  const ps=document.getElementById('pstats'),pc=document.getElementById('pchart'),pp=document.getElementById('psess');
  ps.innerHTML='';pc.innerHTML='';pp.innerHTML='';
  const pg=document.getElementById('pgoal');if(pg)pg.innerHTML='';
  const sessions=sessionsFor(name);
  if(!name||!sessions.length)return;
  const pr=getPR(sessions);
  const latest=bestSet(sessions[sessions.length-1]);
  const first=bestSet(sessions[0]);
  const latestKg=toKg(latest.weight,latest.unit), firstKg=toKg(first.weight,first.unit);
  const imp=(sessions.length>1&&firstKg>0)?((latestKg-firstKg)/firstKg*100).toFixed(1):null;
  renderGoal(name);
  const sbox=(lbl,val,unitTxt,valStyle)=>{const b=mk('div','sbox');b.appendChild(mk('div','slbl',lbl));const v=mk('div','sval',val);if(valStyle)v.style.cssText=valStyle;b.appendChild(v);b.appendChild(mk('div','sunit',unitTxt));return b;};
  const sgrid=mk('div','sgrid');
  sgrid.append(
    sbox('PR Weight',pr?pr.weight:'—',pr?pr.unit:''),
    sbox('Sessions',sessions.length,'logged'),
    sbox(imp!==null?(+imp>=0?'↑ Gained':'↓ Change'):'Progress',imp!==null?Math.abs(imp)+'%':'—','best set wt',
         'font-size:'+(imp!==null?'1.3rem':'1.5rem')+';color:'+(imp===null?'inherit':+imp>=0?'var(--ac)':'var(--rd)')));
  ps.appendChild(sgrid);
  if(sessions.length>=2){
    // chart every session in ONE unit (the unit of the most recent best set) so mixed kg/lb points are comparable
    const chartUnit=unitOf(latest.unit);
    const pts=sessions.map(s=>{const b=bestSet(s);return{date:s.date,w:Math.round(convertWeight(b.weight,b.unit,chartUnit)*100)/100};});
    const cbox=mk('div','cbox');cbox.appendChild(mk('div','ctitle','Best Set Weight Per Session ('+chartUnit+')'));
    const cwrapEl=mk('div');cwrapEl.id='cwrap';cwrapEl.style.cssText='position:relative;height:140px';cbox.appendChild(cwrapEl);pc.appendChild(cbox);
    drawChart(pts);
  }else pc.innerHTML='<div class="empty" style="padding:14px">Log 2+ sessions to see chart</div>';
  const sd=document.createElement('div');sd.className='cbox';
  const st=document.createElement('div');st.className='ctitle';st.textContent='All Sessions';sd.appendChild(st);
  sessions.slice().reverse().forEach(s=>{
    const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;padding:7px 0;border-bottom:1px solid var(--b1);gap:7px';
    const dt=document.createElement('span');dt.style.cssText='font-size:.6rem;color:var(--m2);flex-shrink:0;min-width:55px';dt.textContent=fmtDate(s.date);
    const catTag=document.createElement('span');catTag.style.cssText='font-size:.55rem;color:var(--m1);flex-shrink:0';catTag.textContent=catLabel(s.cat);
    const chips=document.createElement('div');chips.style.cssText='display:flex;gap:4px;flex-wrap:wrap;flex:1';
    s.sets.forEach(set=>{const chip=document.createElement('span');chip.className='chip';chip.textContent=set.weight+(set.unit||'kg')+'×'+set.reps;chips.appendChild(chip);});
    const db=document.createElement('button');db.style.cssText='background:none;border:none;color:var(--m1);font-size:.72rem;flex-shrink:0;padding:2px 5px';db.textContent='✕';
    db.addEventListener('click',()=>{
      DATA[name]=sessionsFor(name).filter(x=>!(x.date===s.date&&x.cat===s.cat&&(s.wid?x.wid===s.wid:!x.wid)));
      if(!DATA[name].length)delete DATA[name];
      scheduleSave();renderProgress();renderHistory();buildProgSel();renderMuscleSets();toast('Removed');
    });
    const isPR=pr&&s.date===pr.date&&(()=>{const b=bestSet(s);return compareWeights(b.weight,b.unit,pr.weight,pr.unit)===0;})();
    row.appendChild(dt);row.appendChild(catTag);row.appendChild(chips);
    if(isPR){const pb=document.createElement('span');pb.className='prbadge';pb.style.flexShrink='0';pb.textContent='PR';row.appendChild(pb);}
    row.appendChild(db);sd.appendChild(row);
  });
  pp.appendChild(sd);
}

function drawChart(pts){
  requestAnimationFrame(()=>{
    const wrap=document.getElementById('cwrap');if(!wrap)return;
    wrap.innerHTML='';
    const cv=document.createElement('canvas');wrap.appendChild(cv);
    const W=wrap.offsetWidth,H=140;
    cv.width=W*devicePixelRatio;cv.height=H*devicePixelRatio;
    cv.style.width=W+'px';cv.style.height=H+'px';
    const ctx=cv.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);
    const pad={t:10,r:14,b:26,l:40};
    const cw=W-pad.l-pad.r,ch=H-pad.t-pad.b;
    const vs=pts.map(p=>p.w);
    const mn=Math.min(...vs)*.95,mx=Math.max(...vs)*1.05;
    const px=i=>pad.l+i/(pts.length-1||1)*cw;
    const py=v=>pad.t+ch-((v-mn)/(mx-mn||1))*ch;
    ctx.strokeStyle='#1e1e1e';ctx.lineWidth=1;
    for(let i=0;i<4;i++){
      const y=pad.t+ch/3*i;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l+cw,y);ctx.stroke();
      ctx.fillStyle='#444';ctx.font='8px monospace';ctx.textAlign='right';
      ctx.fillText((mn+(mx-mn)*(1-i/3)).toFixed(1),pad.l-4,y+3);
    }
    const gr=ctx.createLinearGradient(0,pad.t,0,pad.t+ch);
    gr.addColorStop(0,'rgba(232,255,71,.15)');gr.addColorStop(1,'rgba(232,255,71,0)');
    ctx.beginPath();pts.forEach((p,i)=>i===0?ctx.moveTo(px(i),py(p.w)):ctx.lineTo(px(i),py(p.w)));
    ctx.lineTo(px(pts.length-1),pad.t+ch);ctx.lineTo(px(0),pad.t+ch);ctx.closePath();ctx.fillStyle=gr;ctx.fill();
    ctx.beginPath();ctx.strokeStyle='#e8ff47';ctx.lineWidth=2;ctx.lineJoin='round';
    pts.forEach((p,i)=>i===0?ctx.moveTo(px(i),py(p.w)):ctx.lineTo(px(i),py(p.w)));ctx.stroke();
    pts.forEach((p,i)=>{
      ctx.beginPath();ctx.arc(px(i),py(p.w),3.5,0,Math.PI*2);ctx.fillStyle='#e8ff47';ctx.fill();
      if(i===0||i===pts.length-1||pts.length<=5){ctx.fillStyle='#555';ctx.font='7px monospace';ctx.textAlign='center';ctx.fillText(p.date.slice(5),px(i),H-pad.b+11);}
    });
  });
}

// ── MANAGE ───────────────────────────────────────────
function moveEx(catId,idx,dir){
  const list=EX[catId];const ni=idx+dir;
  if(ni<0||ni>=list.length)return;
  [list[idx],list[ni]]=[list[ni],list[idx]];
  scheduleSave();renderManage();renderPicker();
}

let mOpen=null;
function renderManage(){
  renderSplits();
  const w=document.getElementById('mlist');w.innerHTML='';
  if(!mOpen)mOpen=new Set(CATS.length?[CATS[0].id]:[]);
  const q=(document.getElementById('msearch')?.value||'').trim().toLowerCase();
  const activeSp=SPLITS.find(x=>x.id===activeSplitId);
  const visible=activeSp?CATS.filter(c=>(activeSp.catIds||[]).includes(c.id)):CATS;
  if(!CATS.length){w.innerHTML='<div class="mempty">No categories yet — tap + New Category.</div>';return;}
  if(!visible.length){w.innerHTML='<div class="mempty">This split has no categories yet — tap Edit above to add some.</div>';return;}
  let shown=0;
  visible.forEach(cat=>{
    const all=EX[cat.id]||[];
    const list=q?all.filter(n=>n.toLowerCase().includes(q)):all;
    if(q&&!list.length)return;
    shown++;
    const open=q?true:mOpen.has(cat.id);
    const card=document.createElement('div');card.className='mcard'+(open?' open':'');

    const head=document.createElement('button');head.className='mchead';
    const strip=document.createElement('span');strip.className='mstrip';strip.style.background=cat.color;
    const nm=document.createElement('span');nm.className='mcname';nm.textContent=cat.label;nm.style.color=cat.color;
    const cnt=document.createElement('span');cnt.className='mccount';cnt.textContent=all.length+' exercise'+(all.length!==1?'s':'');
    const chev=document.createElement('span');chev.className='mchev';chev.textContent='▼';
    head.appendChild(strip);head.appendChild(nm);head.appendChild(cnt);head.appendChild(chev);
    head.addEventListener('click',()=>{
      if(q)return;
      if(mOpen.has(cat.id))mOpen.delete(cat.id);else mOpen.add(cat.id);
      card.classList.toggle('open',mOpen.has(cat.id));
    });
    card.appendChild(head);

    const body=document.createElement('div');body.className='mcbody';
    list.forEach(name=>{
      const r=document.createElement('button');r.className='mrow2';
      const n=document.createElement('span');n.className='nm';
      const nt=document.createElement('span');nt.className='nm-t';nt.textContent=name;
      const mIds=inferWorkoutMuscles(name,cat.id);
      const nmSub=document.createElement('span');
      nmSub.className='nm-m'+(mIds.length?'':' unmapped');
      nmSub.textContent=mIds.length
        ?mIds.map(id=>MUSCLES.find(m=>m.id===id)?.label||id).join(' · ')
        :'No muscles selected — tap to set';
      n.append(nt,nmSub);
      const pen=document.createElement('span');pen.className='pen';pen.textContent='✎';
      r.appendChild(n);r.appendChild(pen);
      r.addEventListener('click',()=>openEditExModal(name,cat.id));
      body.appendChild(r);
    });
    if(!list.length){const e=document.createElement('div');e.className='mempty';e.style.padding='14px 6px';e.textContent='No exercises yet';body.appendChild(e);}
    const foot=document.createElement('div');foot.className='maddrow';
    const ab=document.createElement('button');ab.className='maddbtn';ab.textContent='+ Add exercise';
    ab.addEventListener('click',()=>openAddExModal(cat.id));
    const dc=document.createElement('button');dc.className='mdelcat';dc.textContent='Delete category';
    dc.addEventListener('click',()=>{
      if(!confirm('Delete category "'+cat.label+'"?'))return;
      CATS=CATS.filter(c=>c.id!==cat.id);delete EX[cat.id];
      SPLITS.forEach(sp=>{sp.catIds=sp.catIds.filter(id=>id!==cat.id);});
      DAYS.forEach(dd=>{SCHEDULE[dd.k]=(SCHEDULE[dd.k]||[]).filter(x=>x!==CATREF+cat.id);});
      scheduleSave();renderManage();buildCatPills();renderPicker();toast('Category deleted');
    });
    foot.appendChild(ab);foot.appendChild(dc);body.appendChild(foot);
    card.appendChild(body);w.appendChild(card);
  });
  if(q&&!shown){w.innerHTML='';w.appendChild(mk('div','mempty','No exercises match "'+q+'"'));}
}

// ── SPLITS ───────────────────────────────────────────
let editSplitId=null;
let splitCats=new Set();

function renderSplits(){
  const w=document.getElementById('m-splits');if(!w)return;
  w.innerHTML='';
  const row=document.createElement('div');row.className='m-chips';
  const activate=(id,label)=>{
    activeSplitId=id;
    scheduleSave();renderManage();buildCatPills();renderPicker();
    toast(id?'"'+label+'" activated ✓':'Showing all categories');
  };
  const mk=(label,on,fn,extra)=>{
    const b=document.createElement('button');b.className='m-chip'+(on?' on':'')+(extra?' '+extra:'');
    b.textContent=label;b.addEventListener('click',fn);row.appendChild(b);
  };
  mk('All',!activeSplitId,()=>activate(null));
  SPLITS.forEach(sp=>mk(sp.label,sp.id===activeSplitId,()=>activate(sp.id===activeSplitId?null:sp.id,sp.label)));
  mk('+ Split',false,()=>openSplitModal(),'add');
  w.appendChild(row);
  const active=SPLITS.find(x=>x.id===activeSplitId);
  if(active){
    const info=document.createElement('div');info.className='m-splitinfo';
    const t=document.createElement('div');t.className='t';
    t.textContent=(active.catIds||[]).map(id=>{const c=CATS.find(x=>x.id===id);return c?c.label:null;}).filter(Boolean).join(' · ')||'No categories';
    const eb=document.createElement('button');eb.className='m-sbtn';eb.textContent='Edit';
    eb.addEventListener('click',()=>openSplitModal(active.id));
    const db=document.createElement('button');db.className='m-sbtn del';db.textContent='Delete';
    db.addEventListener('click',()=>{
      if(!confirm('Delete split "'+active.label+'"?'))return;
      SPLITS=SPLITS.filter(x=>x.id!==active.id);activeSplitId=null;
      scheduleSave();renderManage();buildCatPills();renderPicker();toast('Split deleted');
    });
    info.appendChild(t);info.appendChild(eb);info.appendChild(db);
    w.appendChild(info);
  } else if(!SPLITS.length){
    const hint=document.createElement('div');hint.className='mempty';hint.style.padding='4px 6px 12px';
    hint.textContent='Group categories into splits like "Upper Body" to filter your Log.';
    w.appendChild(hint);
  }
}

function openSplitModal(id){
  editSplitId=id||null;
  const existing=id?SPLITS.find(s=>s.id===id):null;
  document.getElementById('split-mtitle').textContent=existing?'Edit Split':'New Split';
  document.getElementById('split-name').value=existing?existing.label:'';
  splitCats=new Set(existing?existing.catIds:[]);
  renderSplitCatPills();
  document.getElementById('modal-split').classList.add('on');
  setTimeout(()=>document.getElementById('split-name').focus(),220);
}

function renderSplitCatPills(){
  const g=document.getElementById('split-catpills');g.innerHTML='';
  CATS.forEach(cat=>{
    const on=splitCats.has(cat.id);
    const b=document.createElement('button');b.className='catpill'+(on?' on':'');b.textContent=cat.label;
    if(on){b.style.background=cat.color;b.style.borderColor=cat.color;b.style.color='#000';}
    else{b.style.background='';b.style.borderColor='';}
    b.addEventListener('click',()=>{
      if(splitCats.has(cat.id))splitCats.delete(cat.id);else splitCats.add(cat.id);
      renderSplitCatPills();
    });
    g.appendChild(b);
  });
}

function saveSplit(){
  const label=document.getElementById('split-name').value.trim();
  if(!label){toast('Enter a name');return;}
  if(!splitCats.size){toast('Pick at least one category');return;}
  if(editSplitId){
    const s=SPLITS.find(x=>x.id===editSplitId);
    if(s){ s.label=label; s.catIds=[...splitCats]; }
  } else {
    SPLITS.push({id:'split_'+Date.now(),label,catIds:[...splitCats]});
  }
  scheduleSave();
  closeModal('split');
  renderManage();
  buildCatPills();renderPicker();
  toast('Split saved ✓');
}

// ── MODALS ───────────────────────────────────────────
let newCatSplits=new Set();
function renderNewCatSplitPills(){
  const lbl=document.getElementById('cat-splits-lbl'),g=document.getElementById('cat-splitpills');
  if(!lbl||!g)return;
  g.innerHTML='';
  const has=SPLITS.length>0;
  lbl.style.display=has?'block':'none';g.style.display=has?'flex':'none';
  SPLITS.forEach(sp=>{
    const on=newCatSplits.has(sp.id);
    const b=document.createElement('button');b.className='catpill'+(on?' on':'');b.textContent=sp.label;
    if(on){b.style.background='var(--ac)';b.style.borderColor='var(--ac)';b.style.color='#000';}
    b.addEventListener('click',()=>{
      if(newCatSplits.has(sp.id))newCatSplits.delete(sp.id);else newCatSplits.add(sp.id);
      renderNewCatSplitPills();
    });
    g.appendChild(b);
  });
}
function openModal(type){
  if(type==='newcat'){
    document.getElementById('cat-name').value='';
    document.getElementById('cat-color').value='#a78bfa';
    newCatSplits=new Set(activeSplitId?[activeSplitId]:[]);
    renderNewCatSplitPills();
    document.getElementById('modal-cat').classList.add('on');
    setTimeout(()=>document.getElementById('cat-name').focus(),220);
  }
}
function closeModal(type){ document.getElementById('modal-'+type).classList.remove('on'); }

function openAddExModal(catId){
  const cat=catById(catId)||CATS[0];
  if(!cat)return;
  document.getElementById('ex-mtitle').textContent='Add to '+cat.label;
  modalCats=new Set([cat.id]);
  modalMuscles=new Set(inferWorkoutMuscles('',cat.id));
  document.getElementById('ex-name').value='';
  renderExCatPills();
  renderExMusclePills();
  document.getElementById('modal-ex').classList.add('on');
  setTimeout(()=>document.getElementById('ex-name').focus(),220);
}

function renderExCatPills(){
  const g=document.getElementById('ex-catpills');g.innerHTML='';
  CATS.forEach(cat=>{
    const on=modalCats.has(cat.id);
    const b=document.createElement('button');b.className='catpill'+(on?' on':'');b.textContent=cat.label;
    if(on){b.style.background=cat.color;b.style.borderColor=cat.color;b.style.color='#000';}
    else{b.style.background='';b.style.borderColor='';}
    b.addEventListener('click',()=>{
      if(modalCats.has(cat.id))modalCats.delete(cat.id);else modalCats.add(cat.id);
      renderExCatPills();
    });
    g.appendChild(b);
  });
}

function renderExMusclePills(){
  const g=document.getElementById('ex-muscles');
  if(!g)return;
  g.innerHTML='';
  MUSCLES.forEach(m=>{
    const on=modalMuscles.has(m.id);
    const b=document.createElement('button');
    b.type='button';
    b.className='mchip'+(on?' on':'');
    b.textContent=m.label;
    b.setAttribute('aria-pressed',on?'true':'false');
    b.addEventListener('click',()=>{
      if(modalMuscles.has(m.id))modalMuscles.delete(m.id);
      else modalMuscles.add(m.id);
      renderExMusclePills();
    });
    g.appendChild(b);
  });
}

function saveEx(){
  const name=document.getElementById('ex-name').value.trim();
  if(!name){toast('Enter a name');return;}
  if(!modalCats.size){toast('Pick at least one category');return;}
  if(!modalMuscles.size){toast('Pick at least one muscle');return;}
  let added=0;
  modalCats.forEach(catId=>{
    if(!(EX[catId]||[]).includes(name)){if(!EX[catId])EX[catId]=[];EX[catId].push(name);added++;}
  });
  setExMuscles(name,[...modalMuscles]);
  if(!added){
    scheduleSave();closeModal('ex');renderManage();buildCatPills();renderPicker();toast('Muscles updated ✓');
    return;
  }
  scheduleSave();closeModal('ex');renderManage();buildCatPills();renderPicker();renderOnboarding();toast('Added ✓');
}

function saveCat(){
  const label=document.getElementById('cat-name').value.trim();
  if(!label){toast('Enter a name');return;}
  const color=document.getElementById('cat-color').value;
  const id='cat_'+Date.now();
  CATS.push({id,label,color});EX[id]=[];
  newCatSplits.forEach(sid=>{const sp=SPLITS.find(x=>x.id===sid);if(sp&&!sp.catIds.includes(id))sp.catIds.push(id);});
  if(mOpen)mOpen.add(id);
  scheduleSave();closeModal('cat');renderManage();buildCatPills();renderPicker();renderOnboarding();
  toast('"'+label+'" created ✓');
}

// ── STREAK ───────────────────────────────────────────
let restDays = 1;
let calYear, calMonth;

function initStreak(){
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  restDays = (typeof DATA._restDays === 'number') ? DATA._restDays : 1;
  document.getElementById('rest-val').textContent = restDays;
}

function changeRestDays(dir){
  restDays = Math.max(0, Math.min(7, restDays + dir));
  document.getElementById('rest-val').textContent = restDays;
  const profileRest=gid('profile-rest-days');if(profileRest)profileRest.textContent=restDays;
  DATA._restDays = restDays;
  scheduleSave();
  renderStreak();
}

// Get all unique workout dates sorted ascending
function getWorkoutDates(){
  const dates = new Set();
  Object.keys(DATA).forEach(name=>{
    if(name.startsWith('_')) return;
    sessionsFor(name).forEach(s=>{ if(s.date) dates.add(s.date); });
  });
  return [...dates].sort();
}

function calcStreak(){
  const dates = getWorkoutDates();
  if(!dates.length) return {current:0, best:0, total:dates.length};

  const today = localISO();
  const allowedGap = restDays + 1; // days between sessions allowed

  // Build streak groups
  let streaks = [];
  let cur = [dates[0]];
  for(let i=1;i<dates.length;i++){
    const prev = new Date(dates[i-1]);
    const curr = new Date(dates[i]);
    const diff = Math.round((curr-prev)/(1000*60*60*24));
    if(diff <= allowedGap){
      cur.push(dates[i]);
    } else {
      streaks.push(cur);
      cur = [dates[i]];
    }
  }
  streaks.push(cur);

  // Current streak: check if last workout is recent enough
  const lastGroup = streaks[streaks.length-1];
  const lastDate = new Date(lastGroup[lastGroup.length-1]);
  const todayDate = new Date(today);
  const daysSinceLast = Math.round((todayDate-lastDate)/(1000*60*60*24));
  const current = daysSinceLast <= allowedGap ? lastGroup.length : 0;

  // Best = highest of all groups including current live streak
  const best = Math.max(...streaks.map(s=>s.length), current);

  return {current, best, total: dates.length};
}

function renderStreak(){
  initStreak();
  const {current, best, total} = calcStreak();
  // use querySelectorAll to update ALL elements with these IDs (handles duplicates)
  document.querySelectorAll('#streak-current').forEach(el=>el.textContent=current);
  document.querySelectorAll('#streak-best').forEach(el=>el.textContent=best);
  document.querySelectorAll('#streak-total').forEach(el=>el.textContent=total);
  renderCal();
}

// Calendar
function calPrev(){ calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCal(); }
function calNext(){ calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCal(); }

function renderCal(){
  const today = localISO();
  const workoutDates = new Set(getWorkoutDates());
  const allowedGap = restDays + 1;

  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('cal-title').textContent = months[calMonth]+' '+calYear;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  // Day name headers
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=>{
    const el=document.createElement('div');
    el.className='cal-day-name';
    el.textContent=d;
    grid.appendChild(el);
  });

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();

  // Empty cells before first day
  for(let i=0;i<firstDay;i++){
    const el=document.createElement('div');
    el.className='cal-day empty';
    const inner=document.createElement('div');inner.className='cal-day-inner';
    el.appendChild(inner);grid.appendChild(el);
  }

  for(let d=1;d<=daysInMonth;d++){
    const dateStr = calYear+'-'+String(calMonth+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const el=document.createElement('div');
    el.className='cal-day';

    // inner div holds the visible content
    const inner=document.createElement('div');
    inner.className='cal-day-inner';
    inner.textContent=d;
    el.appendChild(inner);

    if(workoutDates.has(dateStr)){
      el.classList.add('worked');
    } else if(dateStr <= today){
      const dates=[...workoutDates].sort();
      let isRestOk=false;
      for(let i=0;i<dates.length-1;i++){
        const a=new Date(dates[i]), b=new Date(dates[i+1]);
        const cur=new Date(dateStr);
        const gapAB=Math.round((b-a)/(1000*60*60*24));
        if(cur>a && cur<b && gapAB<=allowedGap){ isRestOk=true; break; }
      }
      if(!isRestOk && dates.length){
        const last=new Date(dates[dates.length-1]);
        const cur=new Date(dateStr);
        const diff=Math.round((cur-last)/(1000*60*60*24));
        if(diff>0 && diff<=allowedGap) isRestOk=true;
      }
      if(isRestOk) el.classList.add('rest-ok');
    }

    if(dateStr===today) el.classList.add('today');
    grid.appendChild(el);
  }
}

// ── PROFILE ──────────────────────────────────────────
function profilePrefs(){return isObj(DATA._profilePrefs)?DATA._profilePrefs:{};}
function editProfilePrefs(){if(!isObj(DATA._profilePrefs))DATA._profilePrefs={};return DATA._profilePrefs;}
function applySavedProfilePrefs(){
  const prefs=isObj(DATA._profilePrefs)?DATA._profilePrefs:{};
  if(prefs.unit==='kg'||prefs.unit==='lb')unit=prefs.unit;
  if([60,90,120,180].includes(Number(prefs.restTimer)))timerTotal=Number(prefs.restTimer);
}
function updateProfileSettingsUI(){
  const prefs=profilePrefs();
  const unitChoice=unitOf(prefs.unit||unit||'kg');
  ['kg','lb'].forEach(u=>{const el=gid('profile-unit-'+u);if(el)el.classList.toggle('on',u===unitChoice);});
  const timer=Number(prefs.restTimer);
  const timerChoice=[60,90,120,180].includes(timer)?timer:90;
  const timerEl=gid('profile-timer-setting');if(timerEl)timerEl.value=String(timerChoice);
  const sound=gid('profile-timer-sound');if(sound)sound.checked=prefs.timerSound!==false;
  restDays=Number.isInteger(DATA._restDays)?DATA._restDays:1;
  const rest=gid('profile-rest-days');if(rest)rest.textContent=String(restDays);
  const summary=gid('profile-schedule-summary');
  if(summary){
    const labels=DAYS.filter(d=>(SCHEDULE[d.k]||[]).length).map(d=>d.s);
    summary.textContent=labels.length?'Training days · '+labels.join(' · '):'No training days scheduled';
  }
}
function setProfileUnit(u){
  u=unitOf(u);editProfilePrefs().unit=u;unit=u;
  setUnit(u);scheduleSave();updateProfileSettingsUI();
}
function setProfileTimer(value){
  const seconds=Number(value);if(![60,90,120,180].includes(seconds))return;
  editProfilePrefs().restTimer=seconds;timerTotal=seconds;
  document.querySelectorAll('.tpreset').forEach(b=>{const map={'1m':60,'90s':90,'2m':120,'3m':180};b.classList.toggle('on',map[b.textContent]===seconds);});
  if(!timerEndTime)updateTimerDisplay();
  scheduleSave();toast('Default rest timer updated');
}
function setProfilePref(key,value){
  if(key!=='timerSound')return;
  editProfilePrefs()[key]=!!value;scheduleSave();toast(value?'Timer sound enabled':'Timer sound muted');
}
function toggleProfileEdit(force){
  const panel=gid('profile-edit-panel'),input=gid('profile-name-input');if(!panel||!input)return;
  const open=typeof force==='boolean'?force:panel.hidden;
  panel.hidden=!open;
  if(open){input.value=currentUser?.displayName||'';setTimeout(()=>input.focus(),0);}
}
async function saveProfileName(){
  const name=String(gid('profile-name-input')?.value||'').trim();
  if(!name){toast('Enter a display name');return;}
  if(!currentUser||typeof currentUser.updateProfile!=='function'){toast('Profile editing is unavailable');return;}
  try{await currentUser.updateProfile({displayName:name});toggleProfileEdit(false);renderProfile();toast('Profile updated ✓');}
  catch(e){console.error('Profile update failed',e);toast('Could not update profile');}
}
async function profileResetPassword(){
  const email=currentUser&&currentUser.email;
  if(!email||!auth){toast('Password reset is unavailable for this account');return;}
  try{await auth.sendPasswordResetEmail(email);toast('Password reset email sent ✓');}
  catch(e){console.error('Password reset failed',e);toast(friendlyErr(e.code||'unknown'));}
}
function renderProfile(){
  if(!currentUser)return;
  const email=currentUser.email||'';
  const name=(currentUser.displayName||email||'').split('@')[0];
  const initials=name.slice(0,2).toUpperCase()||'?';
  document.querySelectorAll('#prof-avatar').forEach(el=>el.textContent=initials);
  const sidebarAvatar=gid('sidebar-avatar');if(sidebarAvatar)sidebarAvatar.textContent=initials;
  const sidebarName=gid('sidebar-name');if(sidebarName)sidebarName.textContent=name||'Your account';
  document.querySelectorAll('#prof-name').forEach(el=>el.textContent=name||'—');
  document.querySelectorAll('#prof-email').forEach(el=>el.textContent=email||'—');

  // stats
  const loggedNames=Object.keys(DATA).filter(n=>!n.startsWith('_')&&sessionsFor(n).length);
  const totalSessions=loggedNames.reduce((t,n)=>t+sessionsFor(n).length,0);
  document.getElementById('pstat-sessions').textContent=totalSessions;
  document.getElementById('pstat-exercises').textContent=loggedNames.length;

  // history nav button subtitle
  const histSub=document.getElementById('hist-btn-sub');
  if(histSub){
    const parts=[];
    if(WORKOUTS.length)parts.push(plural(WORKOUTS.length,'workout'));
    if(totalSessions)parts.push(plural(totalSessions,'session'));
    histSub.textContent=parts.length?parts.join(' · '):'No sessions yet';
  }

  // streak
  const {current,best}=calcStreak();
  document.getElementById('pstat-streak').textContent=current;
  document.getElementById('pstat-best').textContent=best;

  // theme toggle state
  // body stats
  renderBodyStats();

  // init export UI fresh each time
  expCats=new Set();
  initExport();
  setExpRange('all');
  setExpFormat('csv');
  updateProfileSettingsUI();
}

// ── DATA EXPORT ──────────────────────────────────────
let expRange='all', expFormat='csv';
let expCats=new Set();

function initExport(){
  // build category pills
  const wrap=document.getElementById('exp-cats');
  if(!wrap)return;
  wrap.innerHTML='';
  // start with all selected
  if(expCats.size===0) CATS.forEach(c=>expCats.add(c.id));
  CATS.forEach(cat=>{
    const b=document.createElement('button');
    b.className='exp-pill'+(expCats.has(cat.id)?' on':'');
    b.textContent=cat.label;
    if(expCats.has(cat.id)){b.style.background=cat.color;b.style.borderColor=cat.color;b.style.color='#000';}
    b.addEventListener('click',()=>{
      if(expCats.has(cat.id)) expCats.delete(cat.id);
      else expCats.add(cat.id);
      initExport();
    });
    wrap.appendChild(b);
  });
  // set default dates for custom range
  const today=localISO();
  const monthAgo=addDaysISO(-30);
  const fromEl=document.getElementById('exp-from');
  const toEl=document.getElementById('exp-to');
  if(fromEl&&!fromEl.value) fromEl.value=monthAgo;
  if(toEl&&!toEl.value) toEl.value=today;
}

function setExpRange(r){
  expRange=r;
  ['all','month','custom'].forEach(x=>{
    const el=document.getElementById('exp-'+x);
    if(el) el.classList.toggle('on',x===r);
  });
  const custom=document.getElementById('exp-custom-dates');
  if(custom) custom.style.display=r==='custom'?'block':'none';
}

function setExpFormat(f){
  expFormat=f;
  ['csv','json'].forEach(x=>{
    const el=document.getElementById('exp-'+x);
    if(el) el.classList.toggle('on',x===f);
  });
}

function getDateFilter(){
  const today=localISO();
  if(expRange==='all') return {from:'2000-01-01',to:today};
  if(expRange==='month'){
    const from=addDaysISO(-30);
    return {from,to:today};
  }
  // custom
  const from=document.getElementById('exp-from')?.value||'2000-01-01';
  const to=document.getElementById('exp-to')?.value||today;
  return {from,to};
}

function getExercisesForExport(){
  // get all exercise names belonging to selected categories
  const names=new Set();
  expCats.forEach(catId=>{
    (EX[catId]||[]).forEach(n=>names.add(n));
  });
  return [...names];
}

function doExport(){
  if(expCats.size===0){toast('Select at least one category');return;}
  const {from,to}=getDateFilter();
  const exercises=getExercisesForExport();
  if(!exercises.length){toast('No exercises in selected categories');return;}

  if(expFormat==='csv') doExportCSV(exercises,from,to);
  else doExportJSON(exercises,from,to);
}

function doExportCSV(exercises,from,to){
  const rows=[['Exercise','Category','Date','Set','Weight','Unit','Reps']];
  exercises.sort().forEach(name=>{
    sessionsFor(name)
      .filter(s=>s.date>=from&&s.date<=to)
      .forEach(session=>{
        session.sets.forEach((set,i)=>{
          rows.push([name,catLabel(session.cat),session.date,i+1,set.weight,set.unit||'kg',set.reps]);
        });
      });
  });
  if(rows.length===1){toast('No data in selected range');return;}
  const lines=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(','));
  const csv=lines.join('\n');
  downloadFile('LIFTS_'+from+'_'+to+'.csv',csv,'text/csv');
  toast('CSV exported ✓ ('+( rows.length-1)+' sets)');
}

function doExportJSON(exercises,from,to){
  const filtered={};
  exercises.sort().forEach(name=>{
    const sessions=sessionsFor(name).filter(s=>s.date>=from&&s.date<=to)
      .map(s=>({date:s.date,category:catLabel(s.cat),sets:s.sets}));
    if(sessions.length) filtered[name]=sessions;
  });
  if(!Object.keys(filtered).length){toast('No data in selected range');return;}
  const exportData={
    exportedAt:new Date().toISOString(),
    user:currentUser?.email||'',
    dateRange:{from,to},
    categories:[...expCats].map(id=>catLabel(id)),
    workouts:filtered
  };
  const json=JSON.stringify(exportData,null,2);
  downloadFile('LIFTS_'+from+'_'+to+'.json',json,'application/json');
  toast('JSON exported ✓');
}

function downloadFile(filename,content,type){
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}

// ── NAV ──────────────────────────────────────────────
function go(id){
  if(id==='workout'&&!ACTIVE_WORKOUT)id='start';
  if(id!=='log')wkReturn=false;
  const screenLabels={start:'OVERVIEW',plan:'PLANS & ROUTINES',workout:'WORKOUT',log:'LOG SET',history:'HISTORY',progress:'PROGRESS',streak:'STREAK CALENDAR',profile:'PROFILE & SETTINGS',manage:'EXERCISE LIBRARY'};
  const context=gid('app-context');if(context)context.textContent=screenLabels[id]||id.toUpperCase();
  document.querySelectorAll('[data-screen]').forEach(nav=>nav.classList.toggle('on',nav.dataset.screen===id||(id==='log'&&nav.dataset.screen==='start')));
  document.querySelectorAll('.scr').forEach(s=>s.classList.remove('on'));
  const tabId=(id==='log'||id==='workout'||id==='plan')?'start':id;
  document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('on',t.closest('.desk-nav')?t.dataset.tab===id:t.dataset.tab===tabId));
  document.getElementById('s-'+id).classList.add('on');
  window.scrollTo(0,0);
  if(id==='log'){
    const ld=document.getElementById('logdate'),t=localISO();
    if(!ACTIVE_WORKOUT&&ld&&logDateAuto&&ld.value===logDateAuto&&t!==logDateAuto){ld.value=t;logDateAuto=t;}
    buildCatPills();renderPicker();renderOnboarding();
  }
  if(id==='history')renderHistory();
  if(id==='progress'){buildProgSel();renderProgress();renderMuscleSets();}
  if(id==='streak')renderStreak();
  if(id==='manage')renderManage();
  if(id==='profile')renderProfile();
  if(id==='start')renderStart();
  if(id==='plan')renderPlan();
  if(id==='workout')renderWorkout();
  wkRenderBanner();
}


// ── REST TIMER ────────────────────────────────────────
let timerInterval=null, timerTotal=90, timerEndTime=null;
const CIRC=2*Math.PI*23;

// Beep sound using Web Audio API (works on iOS + Android)
function beep(){
  if(isObj(DATA._profilePrefs)&&DATA._profilePrefs.timerSound===false)return;
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const play=(freq,start,dur)=>{
      const o=ctx.createOscillator();
      const g=ctx.createGain();
      o.connect(g);g.connect(ctx.destination);
      o.frequency.value=freq;
      o.type='sine';
      g.gain.setValueAtTime(0.6,ctx.currentTime+start);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+start+dur);
      o.start(ctx.currentTime+start);
      o.stop(ctx.currentTime+start+dur+0.05);
    };
    play(880,0,0.15);
    play(880,0.2,0.15);
    play(1100,0.4,0.3);
    // also try vibrate on Android
    if(navigator.vibrate) navigator.vibrate([200,100,200,100,400]);
  }catch(e){}
}

function getTimerLeft(){
  if(!timerEndTime) return timerTotal;
  return Math.max(0, Math.round((timerEndTime - Date.now()) / 1000));
}

function startTimer(exName){
  timerEndTime = Date.now() + timerTotal * 1000;
  const exEl=document.getElementById('timer-ex');
  if(exEl) exEl.textContent=exName||'';
  updateTimerDisplay();
  document.getElementById('timer-bar').classList.add('show');
  clearInterval(timerInterval);
  timerInterval=setInterval(()=>{
    const left=getTimerLeft();
    updateTimerDisplay();
    if(left<=0){
      clearInterval(timerInterval);timerInterval=null;
      beep();
      setTimeout(stopTimer,3000);
    }
  },500); // tick every 500ms so resuming from background is accurate
}

function stopTimer(){
  clearInterval(timerInterval);timerInterval=null;timerEndTime=null;
  document.getElementById('timer-bar').classList.remove('show');
}

function setTimer(secs){
  timerTotal=secs;
  document.querySelectorAll('.tpreset').forEach(b=>{
    const map={'1m':60,'90s':90,'2m':120,'3m':180};
    b.classList.toggle('on',map[b.textContent]===secs);
  });
  updateTimerDisplay();
  if(timerInterval){
    clearInterval(timerInterval);
    startTimer(document.getElementById('timer-ex').textContent);
  }
}

function addTimerSeconds(s){
  if(timerEndTime) timerEndTime+=s*1000;
  else timerEndTime=Date.now()+s*1000;
  updateTimerDisplay();
}

function updateTimerDisplay(){
  const left=timerEndTime?getTimerLeft():timerTotal;
  const m=Math.floor(left/60), s=left%60;
  const numEl=document.getElementById('timer-num');
  if(numEl){
    numEl.textContent=m>0?m+':'+String(s).padStart(2,'0'):String(left);
    numEl.style.color=left<=10?'var(--rd)':'var(--ac)';
  }
  const ring=document.getElementById('timer-ring');
  if(ring){
    const progress=timerEndTime?left/timerTotal:1;
    ring.style.strokeDashoffset=CIRC*(1-Math.max(0,Math.min(1,progress)));
    ring.style.stroke=left<=10?'var(--rd)':'var(--ac)';
  }
}

// Resume timer correctly when user comes back to the page
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden && timerEndTime){
    const left=getTimerLeft();
    if(left<=0){
      clearInterval(timerInterval);timerInterval=null;
      beep();
      setTimeout(stopTimer,3000);
    } else {
      updateTimerDisplay();
    }
  }
});


// ── WARM-UP CALCULATOR ────────────────────────────────
function roundTo2_5(w){ return Math.round(w/2.5)*2.5; }

function calcWarmup(){
  // Get working weight from first set input
  const firstW = sets[0]?.w;
  if(!firstW || parseFloat(firstW)<=0) return null;
  const working = parseFloat(firstW);
  const u = sets[0]?.u || unit;
  const percents = [
    {pct:50, reps:5},
    {pct:75, reps:3},
    {pct:90, reps:1},
  ];
  return {
    warmups: percents.map(p=>({
      weight: roundTo2_5(working * p.pct/100),
      reps: p.reps,
      pct: p.pct,
      unit: u
    })),
    working, unit: u
  };
}

function toggleWarmup(){
  const panel = document.getElementById('warmup-panel');
  const btn = document.getElementById('warmup-toggle-btn');
  if(!panel) return;
  const isOpen = panel.classList.contains('show');
  if(isOpen){
    panel.classList.remove('show');
    if(btn) btn.textContent='🏋️ Show Warm-up Sets';
    return;
  }
  // calculate
  const result = calcWarmup();
  if(!result){
    toast('Enter a weight in Set 1 first');
    return;
  }
  // build table
  const tbody = document.getElementById('warmup-tbody');
  tbody.innerHTML='';
  const wuTd=(t,cls,strong)=>{const c=document.createElement('td');if(cls)c.className=cls;if(strong){const st=document.createElement('strong');st.textContent=t;c.appendChild(st);}else c.textContent=t;return c;};
  result.warmups.forEach((s,i)=>{
    const tr=document.createElement('tr');
    tr.append(wuTd(i+1),wuTd(s.weight+' '+s.unit,null,true),wuTd(s.reps+' reps'),wuTd(s.pct+'%','warmup-pct'));
    tbody.appendChild(tr);
  });
  // working set row
  const trW=document.createElement('tr');
  trW.className='working';
  trW.append(wuTd('➡️'),wuTd(result.working+' '+result.unit,null,true),wuTd('Your target'),wuTd('100%','warmup-pct'));
  tbody.appendChild(trW);

  panel.classList.add('show');
  if(btn) btn.textContent='Hide Warm-up Sets';
}

// hide warmup panel when exercise changes
function hideWarmup(){
  const panel=document.getElementById('warmup-panel');
  const btn=document.getElementById('warmup-toggle-btn');
  if(panel) panel.classList.remove('show');
  if(btn) btn.textContent='🏋️ Show Warm-up Sets';
}


// ── GOALS ─────────────────────────────────────────────
// Goals stored in DATA._goals = { exerciseName: {weight, reps, unit} }
let goalUnit = 'kg';
let goalBase = null; // {w,u,shown}: exact base behind the number shown in the goal weight field
let goalExName = '';

function getGoal(name){ return (DATA._goals||{})[name]||null; }

function renderGoal(name){
  const pg = document.getElementById('pgoal');
  if(!pg) return;
  const goal = getGoal(name);
  const pr = getPR(sessionsFor(name));

  pg.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'goal-box';

  const hdr = document.createElement('div');
  hdr.className = 'goal-header';
  const title = document.createElement('div');
  title.className = 'goal-title';
  title.textContent = 'Goal';
  const editBtn = document.createElement('button');
  editBtn.className = 'goal-edit-btn';
  editBtn.textContent = goal ? 'Edit' : '+ Set Goal';
  editBtn.addEventListener('click', ()=>openGoalModal(name));
  hdr.appendChild(title);
  hdr.appendChild(editBtn);
  box.appendChild(hdr);

  if(!goal){
    const empty = document.createElement('div');
    empty.className = 'goal-empty';
    empty.textContent = 'No goal set — tap Set Goal to add one';
    box.appendChild(empty);
  } else {
    // Target line
    const target = document.createElement('div');
    target.className = 'goal-target';
    target.appendChild(document.createTextNode('Target: '));
    target.appendChild(mk('span',null,goal.weight+' '+goal.unit));
    target.appendChild(document.createTextNode(' × '));
    target.appendChild(mk('span',null,goal.reps+' reps'));
    box.appendChild(target);

    // Progress bar based on weight
    // compare in kg so a 30 kg goal vs a 70 lb PR (and vice-versa) is correct
    const goalKg = toKg(goal.weight, goal.unit);
    const currentKg = pr ? toKg(pr.weight, pr.unit) : 0;
    const done = goalKg > 0 && currentKg >= goalKg - WEIGHT_EPS_KG;
    const pct = done ? 100 : (goalKg > 0 ? Math.min(99, Math.round((currentKg / goalKg) * 100)) : 0);

    const barWrap = document.createElement('div');
    barWrap.className = 'goal-bar-wrap';
    const gTrack=mk('div','goal-bar-track');const gFill=mk('div','goal-bar-fill'+(done?' done':''));gFill.style.width=pct+'%';gTrack.appendChild(gFill);
    const gPct=mk('div','goal-pct');gPct.append(mk('span',null,'Current: '+(pr?pr.weight+' '+pr.unit:'—')),mk('span',null,pct+'%'));
    barWrap.append(gTrack,gPct);
    box.appendChild(barWrap);

    if(done){
      const ach = document.createElement('div');
      ach.className = 'goal-achieved';
      ach.textContent = '🏆 Goal achieved!';
      box.appendChild(ach);
    }
  }

  pg.appendChild(box);
}

function openGoalModal(name){
  goalExName = name;
  const goal = getGoal(name);
  document.getElementById('goal-modal-ex').textContent = name;
  const gwEl = document.getElementById('goal-weight');
  gwEl.value = goal ? goal.weight : '';
  goalBase = goal ? {w:Number(goal.weight), u:unitOf(goal.unit), shown:gwEl.value} : null;
  gwEl.oninput = ()=>{ const n=parseFloat(gwEl.value); goalBase = isFinite(n) ? {w:n, u:goalUnit, shown:gwEl.value} : null; };
  document.getElementById('goal-reps').value = goal ? goal.reps : '';
  goalUnit = goal ? goal.unit : unit;
  setGoalUnit(goalUnit);
  document.getElementById('goal-delete-btn').style.display = goal ? 'inline-flex' : 'none';
  document.getElementById('modal-goal').classList.add('on');
  setTimeout(()=>document.getElementById('goal-weight').focus(), 220);
}

function setGoalUnit(u){
  u = unitOf(u);
  const gwEl = document.getElementById('goal-weight');
  if(goalBase && gwEl.value === goalBase.shown){ // field still shows its base value → same weight in the new unit
    gwEl.value = (goalBase.u === u) ? String(goalBase.w) : fmtW(convertWeight(goalBase.w, goalBase.u, u));
    goalBase.shown = gwEl.value;
  }
  goalUnit = u;
  document.getElementById('goal-ukg').classList.toggle('on', u==='kg');
  document.getElementById('goal-ulb').classList.toggle('on', u==='lb');
}

function saveGoal(){
  const w = parseFloat(document.getElementById('goal-weight').value);
  const r = parseInt(document.getElementById('goal-reps').value);
  if(!w || w<=0){toast('Enter a target weight');return;}
  if(!r || r<=0){toast('Enter target reps');return;}
  if(!DATA._goals) DATA._goals = {};
  DATA._goals[goalExName] = {weight:w, reps:r, unit:goalUnit, celebrated:false};
  scheduleSave();
  closeModal('goal');
  renderGoal(goalExName);
  toast('Goal saved ✓');
}

function deleteGoal(){
  if(!confirm('Remove goal for "'+goalExName+'"?')) return;
  if(DATA._goals) delete DATA._goals[goalExName];
  scheduleSave();
  closeModal('goal');
  renderGoal(goalExName);
  toast('Goal removed');
}


// ── BODY STATS ────────────────────────────────────────
// DATA._bodyWeight = [{date, value, unit}]
// DATA._bodyFat    = [{date, value}]
// DATA._weightGoal = {value, unit}

let bodyStatType = 'weight'; // 'weight' or 'bf'
let bodyUnit = 'kg';

let wlValue=70, wlShowAll=false;
const KG_LB=2.20462;
const conv=(v,from,to)=>convertWeight(v,from,to); // delegates to the central kg/lb converter (exact 0.45359237 factor)
function fmtDay(d){
  const x=new Date(d+'T00:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][x.getDay()]+' '+x.getDate()+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][x.getMonth()];
}
function openBodyModal(type,showAll){
  const logs=(DATA._bodyWeight||[]);
  const latest=logs.slice(-1)[0];
  const goal=DATA._weightGoal;
  bodyUnit=latest?(latest.unit||'kg'):(goal?goal.unit:'kg');
  wlValue=latest?latest.value:(bodyUnit==='kg'?70:154);
  wlShowAll=!!showAll;
  document.getElementById('wl-date').textContent='Today, '+fmtDay(localISO());
  setBodyUnit(bodyUnit,true);
  wlRenderRecent();
  document.getElementById('modal-body').classList.add('on');
}
let wlBase=null, wlInternal=false; // wlBase: exact value (and unit) the picker was last set to by the user / opened with
function wlSet(v,fromSlider){
  if(isNaN(v))return;
  const lo=bodyUnit==='kg'?20:44, hi=bodyUnit==='kg'?300:660;
  wlValue=Math.round(Math.max(lo,Math.min(hi,v))*10)/10;
  document.getElementById('wl-num').textContent=wlValue.toFixed(1);
  if(!fromSlider)document.getElementById('wl-range').value=wlValue;
  if(!wlInternal)wlBase={v:wlValue,u:bodyUnit};
}
function wlStep(d){ wlSet(wlValue+d); }
function wlRenderRecent(){
  const wrap=document.getElementById('wl-recent');if(!wrap)return;
  wrap.innerHTML='';
  const logs=(DATA._bodyWeight||[]).slice().sort((a,b)=>b.date.localeCompare(a.date));
  const list=wlShowAll?logs:logs.slice(0,3);
  if(!logs.length){wrap.innerHTML='<div class="wc-empty">No weigh-ins yet</div>';}
  list.forEach(e=>{
    const row=document.createElement('div');row.className='wl-row';
    const d=document.createElement('span');d.className='d';d.textContent=fmtDay(e.date);
    const v=document.createElement('span');v.className='v';v.textContent=e.value+' '+(e.unit||'kg');
    const x=document.createElement('button');x.className='x';x.textContent='✕';
    x.addEventListener('click',()=>{
      DATA._bodyWeight=(DATA._bodyWeight||[]).filter(z=>z.date!==e.date);
      scheduleSave();renderBodyStats();wlRenderRecent();toast('Removed');
    });
    row.appendChild(d);row.appendChild(v);row.appendChild(x);wrap.appendChild(row);
  });
  const btn=document.getElementById('wl-allbtn');
  if(btn){btn.style.display=logs.length>3?'block':'none';btn.textContent=wlShowAll?'Show recent ‹':'All weigh-ins ›';}
}
function wlToggleAll(){ wlShowAll=!wlShowAll; wlRenderRecent(); }

function setBodyUnit(u,initial){
  const prev=bodyUnit;
  bodyUnit=u;
  const kg=document.getElementById('body-ukg'),lb=document.getElementById('body-ulb');
  if(kg)kg.classList.toggle('on',u==='kg');
  if(lb)lb.classList.toggle('on',u==='lb');
  const rng=document.getElementById('wl-range');
  if(rng){rng.min=u==='kg'?30:66;rng.max=u==='kg'?200:440;}
  const unitEl=document.getElementById('wl-unit');if(unitEl)unitEl.textContent=u;
  if(initial||!wlBase)wlBase={v:wlValue,u:u};
  else if(prev!==u)wlValue=(wlBase.u===u)?wlBase.v:Math.round(conv(wlBase.v,wlBase.u,u)*10)/10; // convert from the base, never from the rounded display
  wlInternal=true;wlSet(wlValue);wlInternal=false;
}

// ── WEIGHT GOAL (ruler picker) ─────────────────────────
let wgMin=0, wgStep=0.5, wgTickW=8, wgUnit='kg', wgLastIdx=null, wgCurrentWeight=0;

function openWeightGoalModal(){
  const logs=DATA._bodyWeight||[];
  const latest=logs.slice(-1)[0];
  if(!latest){ toast('Log your current weight first'); openBodyModal('weight'); return; }

  wgCurrentWeight=latest.value;
  wgUnit=latest.unit||'kg';
  wgStep=wgUnit==='kg'?0.5:1;
  wgMin=Math.max(0,wgCurrentWeight-40);
  const max=wgCurrentWeight+40;

  document.getElementById('wg-unit').textContent=wgUnit;
  document.getElementById('wg-current').textContent=wgCurrentWeight+' '+wgUnit;

  // default target date: 12 weeks out, or keep existing goal's date if one exists
  const existing=DATA._weightGoal;
  const defaultDate=addDaysISO(84);
  document.getElementById('wg-date').value=(existing&&existing.targetDate)?existing.targetDate:defaultDate;

  const track=document.getElementById('wg-track');
  track.innerHTML='';
  wgLastIdx=null;
  const count=Math.round((max-wgMin)/wgStep);
  for(let i=0;i<=count;i++){
    const val=wgMin+i*wgStep;
    const isMajor=wgUnit==='kg'?(val%5===0):(val%10===0);
    const isMid=wgUnit==='kg'?(val%1===0):(val%5===0);
    const t=document.createElement('div');
    t.className='tick '+(isMajor?'major':isMid?'mid':'minor');
    const bar=document.createElement('div');bar.className='bar';
    t.appendChild(bar);
    track.appendChild(t);
  }

  document.getElementById('modal-weightgoal').classList.add('on');

  requestAnimationFrame(()=>{
    const pad=track.parentElement.offsetWidth/2 - wgTickW/2;
    track.style.paddingLeft=pad+'px';
    track.style.paddingRight=pad+'px';
    const startVal=existing?convertWeight(existing.value,existing.unit,wgUnit):wgCurrentWeight;
    const startIdx=Math.max(0,Math.min(count,Math.round((startVal-wgMin)/wgStep)));
    track.scrollLeft=startIdx*wgTickW;
    wgUpdate(wgMin+startIdx*wgStep,startIdx);
  });
}

function wgUpdate(weight,idx){
  const wgBig=document.getElementById('wg-bignum');wgBig.textContent=weight.toFixed(wgUnit==='kg'?1:0);
  const wgU=document.createElement('span');wgU.id='wg-unit';wgU.textContent=wgUnit;wgBig.appendChild(wgU);

  // haptic feedback on real devices that support it (Android Chrome — iOS Safari
  // has no Vibration API at all, so this silently does nothing there); the
  // visual tick "pulse" below is what actually gives feedback on iPhone
  if(idx!==wgLastIdx){
    wgLastIdx=idx;
    try{ if(navigator.vibrate) navigator.vibrate(8); }catch(e){}
    document.querySelectorAll('#wg-track .tick.pulse').forEach(t=>t.classList.remove('pulse'));
    const activeTick=document.querySelectorAll('#wg-track .tick')[idx];
    if(activeTick) activeTick.classList.add('pulse');
  }

  wgRecalc(weight);
}

function wgRecalc(weightOverride){
  const weight=typeof weightOverride==='number'?weightOverride:parseFloat(document.getElementById('wg-bignum').textContent);
  const dateVal=document.getElementById('wg-date').value;
  if(!dateVal)return;
  const days=Math.max(1,Math.round((new Date(dateVal)-new Date(localISO()))/86400000));
  const diff=weight-wgCurrentWeight;
  const weeks=days/7;
  const pace=diff/weeks;
  const absPace=Math.abs(pace);

  document.getElementById('wg-days').textContent=days+' days';
  document.getElementById('wg-pace').textContent=(pace>=0?'+':'')+pace.toFixed(2)+' '+wgUnit+'/week';

  const card=document.getElementById('wg-warncard');
  const icon=document.getElementById('wg-warnicon');
  const title=document.getElementById('wg-warntitle');
  const sub=document.getElementById('wg-warnsub');
  const safeLimit=wgUnit==='kg'?1:2.2, midLimit=wgUnit==='kg'?0.5:1.1;

  if(absPace<=midLimit){
    card.className='warncard ok';icon.textContent='✓';title.textContent='Healthy Pace';
    sub.textContent='This is a sustainable rate of change for your target date.';
  } else if(absPace<=safeLimit){
    card.className='warncard mid';icon.textContent='⚡';title.textContent='Ambitious Pace';
    sub.textContent='Doable, but will take consistent effort to hit on time.';
  } else {
    card.className='warncard hard';icon.textContent='⚠';
    title.textContent='Aggressive Pace '+(pace>=0?'+':'')+pace.toFixed(1)+' '+wgUnit+'/week';
    sub.textContent='Faster than the typical safe range ('+midLimit+'\u2013'+safeLimit+' '+wgUnit+'/week). Consider a later target date.';
  }
}

function saveWeightGoal(){
  const weight=parseFloat(document.getElementById('wg-bignum').textContent);
  const dateVal=document.getElementById('wg-date').value;
  if(!weight||!dateVal){ toast('Pick a weight and date'); return; }
  DATA._weightGoal={value:weight,unit:wgUnit,targetDate:dateVal,setDate:localISO()};
  scheduleSave();
  closeModal('weightgoal');
  renderBodyStats();
  toast('Goal set ✓');
}

function saveBodyStat(){
  const val=wlValue;
  if(!val||val<=0){toast('Enter a weight');return;}
  const today=localISO();
  if(!DATA._bodyWeight)DATA._bodyWeight=[];
  const idx=DATA._bodyWeight.findIndex(e=>e.date===today);
  const entry={date:today,value:val,unit:bodyUnit};
  if(idx>=0)DATA._bodyWeight[idx]=entry; else DATA._bodyWeight.push(entry);
  DATA._bodyWeight.sort((a,b)=>a.date.localeCompare(b.date));
  scheduleSave();
  closeModal('body');
  renderBodyStats();
  toast('Saved ✓');
}

// ── CELEBRATION (reusable — used for exercise goals) ───
function showCelebration(title,sub){
  const stage=document.createElement('div');
  stage.className='celeb-stage';
  const ccard=mk('div','celeb-card');
  ccard.append(mk('div','celeb-burst','🎉'),mk('div','celeb-title',title),mk('div','celeb-sub',sub));
  stage.appendChild(ccard);
  document.body.appendChild(stage);

  const colors=['#e8ff47','#ff9d3d','#ff4444','#4dd8ff','#c04dff'];
  for(let i=0;i<26;i++){
    const c=document.createElement('div');
    c.className='celeb-confetti';
    c.style.left=Math.random()*100+'%';
    c.style.background=colors[i%colors.length];
    c.style.animationDelay=(Math.random()*0.4)+'s';
    c.style.animationDuration=(1.8+Math.random()*1)+'s';
    stage.appendChild(c);
  }

  stage.addEventListener('click',()=>stage.remove());
  setTimeout(()=>{ if(stage.parentNode) stage.remove(); },3200);
}

// Checks whether any logged set for this exercise now meets or beats its
// saved goal (weight AND reps together) — celebrates once per goal.
function checkExerciseGoalCelebration(name){
  const goal=getGoal(name);
  if(!goal||goal.celebrated)return;
  const sessions=sessionsFor(name);
  const hit=sessions.some(s=>(s.sets||[]).some(set=>compareWeights(set.weight,set.unit,goal.weight,goal.unit)>=0&&set.reps>=goal.reps));
  if(!hit)return;

  goal.celebrated=true;
  scheduleSave();
  showCelebration('GOAL REACHED!', name+' — '+goal.weight+(goal.unit||'kg')+'×'+goal.reps);
}

function weightChartSVG(logs,goal,unit){
  const W=340,H=160,pl=34,pr=12,pt=10,pb=24;
  const pts=logs.map(l=>({date:l.date,v:Math.round(conv(l.value,l.unit||'kg',unit)*10)/10}));
  const gv=goal?Math.round(conv(goal.value,goal.unit||'kg',unit)*10)/10:null;
  const vals=pts.map(p=>p.v);if(gv!==null)vals.push(gv);
  let mn=Math.min(...vals),mx=Math.max(...vals);
  if(mx-mn<1){mn-=.5;mx+=.5;}
  const raw=(mx-mn)/3;
  const step=[0.5,1,2,5,10,20,50].find(x=>x>=raw)||50;
  const lo=Math.floor(mn/step)*step, hi=Math.ceil(mx/step)*step;
  const t0=new Date(pts[0].date).getTime(), t1=new Date(pts[pts.length-1].date).getTime();
  const span=t1-t0;
  const X=d=>span>0?pl+((new Date(d).getTime()-t0)/span)*(W-pl-pr):(pl+(W-pl-pr)/2);
  const Y=v=>pt+(hi-v)/(hi-lo)*(H-pt-pb);
  const fmt=v=>Number.isInteger(v)?String(v):v.toFixed(1);
  let g='';
  for(let v=lo;v<=hi+1e-9;v+=step){
    g+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+Y(v)+'" y2="'+Y(v)+'" stroke="#2a2a2a" stroke-width="1" stroke-dasharray="3 3"/>'
      +'<text class="wc-ax" x="'+(pl-6)+'" y="'+(Y(v)+3)+'" text-anchor="end">'+fmt(v)+'</text>';
  }
  const mons=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let labeled=0;
  if(span>0){
    const start=parseLocalDate(pts[0].date);
    let c=new Date(start.getFullYear(),start.getMonth()+1,1);
    while(localISO(c)<=pts[pts.length-1].date){
      const x=X(localISO(c));
      g+='<text class="wc-ax" x="'+x+'" y="'+(H-6)+'" text-anchor="middle">'+mons[c.getMonth()]+'</text>';
      labeled++;
      c=new Date(c.getFullYear(),c.getMonth()+1,1);
    }
  }
  if(!labeled){
    const lm=parseLocalDate(pts[pts.length-1].date);
    g+='<text class="wc-ax" x="'+X(pts[pts.length-1].date)+'" y="'+(H-6)+'" text-anchor="middle">'+mons[lm.getMonth()]+'</text>';
  }
  let goalSvg='';
  if(gv!==null){
    goalSvg+='<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+Y(gv)+'" y2="'+Y(gv)+'" stroke="#ff9d3d" stroke-width="1.5" stroke-dasharray="6 4"/>'
      +'<text class="wc-ax" style="fill:#ff9d3d" x="'+(W-pr-2)+'" y="'+(Y(gv)-4)+'" text-anchor="end">'+fmt(gv)+'</text>';
  }
  const line=pts.map((p,i)=>(i?'L':'M')+X(p.date).toFixed(1)+' '+Y(p.v).toFixed(1)).join(' ');
  const last=pts[pts.length-1];
  const area=pts.length>1?line+' L'+X(last.date).toFixed(1)+' '+(H-pb)+' L'+X(pts[0].date).toFixed(1)+' '+(H-pb)+' Z':'';
  return '<svg class="wc-chart" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg">'
    +'<defs><linearGradient id="wcgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8ff47" stop-opacity=".28"/><stop offset="1" stop-color="#e8ff47" stop-opacity="0"/></linearGradient></defs>'
    +g
    +(area?'<path d="'+area+'" fill="url(#wcgrad)"/>':'')
    +(pts.length>1?'<path d="'+line+'" fill="none" stroke="#e8ff47" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>':'')
    +goalSvg
    +'<circle cx="'+X(last.date)+'" cy="'+Y(last.v)+'" r="4.5" fill="#e8ff47"/>'
    +'</svg>';
}

function renderBodyStats(){
  const card=document.getElementById('wcard');if(!card)return;
  const logs=(DATA._bodyWeight||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const goal=DATA._weightGoal;
  const top=goalTxt=>{
    const t=mk('div','wc-top');t.appendChild(mk('span','wc-title','Body weight'));
    if(goalTxt!==null)t.appendChild(mk('span','wc-goal','◎ '+goalTxt));
    const b=mk('button','wc-log','+ Log');b.addEventListener('click',()=>openBodyModal('weight'));t.appendChild(b);return t;
  };
  card.innerHTML='';
  if(!logs.length){
    card.appendChild(top(goal?goal.value:null));
    card.appendChild(mk('div','wc-empty','No weigh-ins yet — tap + Log to add your first one.'));
    return;
  }
  const latest=logs[logs.length-1];
  const unit=latest.unit||'kg';
  const prev=logs.length>1?logs[logs.length-2]:null;
  const gv=goal?Math.round(conv(goal.value,goal.unit||'kg',unit)*10)/10:null;
  card.appendChild(top(gv!==null?gv:null));
  let deltaEl=null;
  if(prev){
    const d=Math.round((latest.value-conv(prev.value,prev.unit||'kg',unit))*10)/10;
    if(d!==0){
      const away=gv!==null?(Math.abs(latest.value-gv)>Math.abs(latest.value-d-gv)):false;
      const clr=gv===null?'var(--m2)':(away?'var(--rd)':'var(--ac)');
      deltaEl=mk('span','wc-delta',(d>0?'↑':'↓')+' '+Math.abs(d));deltaEl.style.color=clr;
    }
  }
  const main=mk('div','wc-main');
  main.append(mk('span','wc-val',latest.value),mk('span','wc-unit',unit));
  if(deltaEl)main.appendChild(deltaEl);
  main.appendChild(mk('span','wc-date',fmtDay(latest.date)));
  card.appendChild(main);
  if(gv!==null){
    const diff=Math.round((latest.value-gv)*10)/10;
    const txt=diff>0?Math.abs(diff)+' '+unit+' to lose':diff<0?Math.abs(diff)+' '+unit+' to gain':'goal reached 🎉';
    card.appendChild(mk('div','wc-goalline','◎ Goal '+gv+' '+unit+' · '+txt));
  }
  appendTrustedSvg(card,weightChartSVG(logs,goal,unit));
  const allBtn=mk('button','wc-all','All weigh-ins ›');allBtn.addEventListener('click',()=>openBodyModal('weight',true));card.appendChild(allBtn);
}


// ── EDIT EXERCISE ─────────────────────────────────────
let editExOrigName = '';
let editExCats = new Set();
let editExMuscles = new Set();

let editExFromCat=null;
function openEditExModal(name, fromCatId){
  editExOrigName = name;
  editExFromCat = fromCatId||null;
  editExCats = new Set();
  CATS.forEach(cat=>{
    if((EX[cat.id]||[]).includes(name)) editExCats.add(cat.id);
  });
  editExMuscles = new Set(inferWorkoutMuscles(name, fromCatId));
  document.getElementById('editex-name').value = name;
  const fc=document.getElementById('editex-fromcat');
  if(fc)fc.textContent=catLabel(fromCatId)||'this category';
  renderEditExCatPills();
  renderEditExMusclePills();
  document.getElementById('modal-editex').classList.add('on');
}
function moveInEdit(dir){
  const list=EX[editExFromCat]||[];
  const idx=list.indexOf(editExOrigName);
  if(idx<0)return;
  if(idx+dir<0||idx+dir>=list.length){toast(dir<0?'Already first':'Already last');return;}
  moveEx(editExFromCat,idx,dir);
  toast(dir<0?'Moved up':'Moved down');
}
function deleteFromEdit(){
  const cat=catById(editExFromCat);
  if(!cat)return;
  if(!confirm('Remove "'+editExOrigName+'" from '+cat.label+'?'))return;
  EX[cat.id]=(EX[cat.id]||[]).filter(n=>n!==editExOrigName);
  scheduleSave();closeModal('editex');renderManage();renderPicker();toast('Removed');
}

// Prompts for a new custom muscle name, adds it to CUSTOM_MUSCLES if new, returns its id (or null if cancelled)
function promptNewMuscle(){
  const label=prompt('New muscle name (e.g. Forearms)');
  if(!label||!label.trim())return null;
  const trimmed=label.trim();
  const id='custom_'+trimmed.toLowerCase().replace(/[^a-z0-9]+/g,'_');
  const exists=allMuscles().find(m=>m.id===id);
  if(!exists){
    CUSTOM_MUSCLES.push({id,label:trimmed});
    if(!MSETS[id])MSETS[id]=0;
    scheduleSave();
  }
  return id;
}

function renderEditExCatPills(){
  const g = document.getElementById('editex-catpills');
  g.innerHTML = '';
  CATS.forEach(cat=>{
    const on = editExCats.has(cat.id);
    const b = document.createElement('button');
    b.className = 'catpill'+(on?' on':'');
    b.textContent = cat.label;
    if(on){ b.style.background=cat.color; b.style.borderColor=cat.color; b.style.color='#000'; }
    else { b.style.background=''; b.style.borderColor=''; }
    b.addEventListener('click',()=>{
      if(editExCats.has(cat.id)) editExCats.delete(cat.id);
      else editExCats.add(cat.id);
      renderEditExCatPills();
    });
    g.appendChild(b);
  });
}

function renderEditExMusclePills(){
  const g = document.getElementById('editex-muscles');
  if(!g)return;
  g.innerHTML = '';
  MUSCLES.forEach(m=>{
    const on = editExMuscles.has(m.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mchip'+(on?' on':'');
    b.textContent = m.label;
    b.setAttribute('aria-pressed',on?'true':'false');
    b.addEventListener('click',()=>{
      if(editExMuscles.has(m.id)) editExMuscles.delete(m.id);
      else editExMuscles.add(m.id);
      renderEditExMusclePills();
    });
    g.appendChild(b);
  });
}

function saveEditEx(){
  const newName = document.getElementById('editex-name').value.trim();
  if(!newName){ toast('Enter a name'); return; }
  if(!editExCats.size){ toast('Pick at least one category'); return; }
  if(!editExMuscles.size){ toast('Pick at least one muscle'); return; }

  const oldName = editExOrigName;
  const renamed = newName !== oldName;

  // Check new name doesn't conflict (unless it's same name)
  if(renamed){
    const allEx = [...new Set(CATS.flatMap(c=>EX[c.id]||[]))];
    if(allEx.includes(newName)){
      toast('"'+newName+'" already exists');
      return;
    }
  }

  // Update EX in place so the exercise keeps its position in each category
  CATS.forEach(cat=>{
    const list=EX[cat.id]||[];
    const idx=list.indexOf(oldName);
    if(editExCats.has(cat.id)){
      if(idx>=0)list[idx]=newName; else list.push(newName);
    } else if(idx>=0){
      list.splice(idx,1);
    }
    EX[cat.id]=list;
  });

  // Rename workout DATA if name changed
  if(renamed && DATA[oldName]){
    DATA[newName] = DATA[oldName];
    delete DATA[oldName];
  }

  // Rename goals if name changed
  if(renamed && DATA._goals && DATA._goals[oldName]){
    DATA._goals[newName] = DATA._goals[oldName];
    delete DATA._goals[oldName];
  }

  // Rename exercise muscles if name changed
  if(renamed && DATA._exMuscles && DATA._exMuscles[oldName]){
    DATA._exMuscles[newName] = DATA._exMuscles[oldName];
    delete DATA._exMuscles[oldName];
  }

  if(renamed)p1OnExerciseRenamed(oldName,newName);
  setExMuscles(newName,[...editExMuscles]);
  scheduleSave();
  closeModal('editex');
  renderManage();
  renderPicker();
  toast(renamed ? 'Renamed to "'+newName+'" ✓' : 'Exercise updated ✓');
}

// Attached once (the track element persists across modal opens — only its
// tick children get rebuilt each time), so this never stacks duplicate listeners.
(function(){
  const wgTrackEl=document.getElementById('wg-track');
  if(!wgTrackEl)return;
  let wgDebounce;
  wgTrackEl.addEventListener('scroll',()=>{
    clearTimeout(wgDebounce);
    wgDebounce=setTimeout(()=>{
      const idx=Math.round(wgTrackEl.scrollLeft/wgTickW);
      const weight=wgMin+idx*wgStep;
      wgUpdate(weight,idx);
    },50);
  });
})();

// ══════════════════════════════════════════════════════
// PHASE 1 — ROUTINES · WEEKLY SCHEDULE · ACTIVE WORKOUT
// ══════════════════════════════════════════════════════
const gid=id=>document.getElementById(id);
function mk(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
const pad2=n=>String(n).padStart(2,'0');
const localISO=d=>{d=d||new Date();return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());};
// ── Dates ─────────────────────────────────────────────
// A calendar date ('YYYY-MM-DD') means the user's LOCAL day and is always produced by localISO(); never by toISOString()
// (that is the UTC day, which differs from the local day for part of every day). Real moments (startedAt, finishedAt,
// savedAt, exportedAt) stay millisecond timestamps. Stored date strings keep their existing format.
const addDaysISO=(n,base)=>{const b=base||new Date();return localISO(new Date(b.getFullYear(),b.getMonth(),b.getDate()+n,12));}; // calendar-day maths (DST-safe)
const parseLocalDate=s=>{const[y,m,d]=String(s).split('-').map(Number);return new Date(y,(m||1)-1,d||1);};                          // local midnight of a stored date
const newId=p=>p+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const plural=(n,w)=>n+' '+w+(n===1?'':'s');
const routineById=id=>ROUTINES.find(r=>r.id===id);
// A schedule entry is either a routine id or 'cat:<categoryId>'. Categories are resolved LIVE from CATS/EX,
// so a category scheduled on a day always reflects its current exercises. Missing/deleted → null (ignored).
const CATREF='cat:';
function resolveSched(ref){
  if(typeof ref!=='string')return null;
  if(ref.startsWith(CATREF)){
    const c=catById(ref.slice(CATREF.length));if(!c)return null;
    return {ref,kind:'category',id:null,name:c.label,color:c.color,exercises:(EX[c.id]||[]).map(n=>({name:n,cat:c.id}))};
  }
  const r=routineById(ref);
  return r?{ref,kind:'routine',id:r.id,name:r.name,color:null,exercises:r.exercises}:null;
}
const rtExCat=e=>catById(e.cat)?e.cat:primCat(e.name);
const todayDay=()=>DAYS[new Date().getDay()];
function normSchedule(raw){
  const s=emptySchedule();
  if(raw&&typeof raw==='object')DAYS.forEach(d=>{if(Array.isArray(raw[d.k]))s[d.k]=raw[d.k].filter(x=>typeof x==='string');});
  return s;
}
function fmtClock(ms){const t=Math.max(0,Math.floor(ms/1000));return pad2(Math.floor(t/3600))+':'+pad2(Math.floor(t%3600/60))+':'+pad2(t%60);}
function fmtDur(sec){sec=Math.max(0,Math.round(sec));const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60);if(h>0)return h+'h '+pad2(m)+'m';if(m>0)return m+'m';return sec+'s';}
const clockTime=ms=>new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});

// ── user switching / reset ───────────────────────────
function p1Reset(){ROUTINES=[];SCHEDULE=emptySchedule();WORKOUTS=[];ACTIVE_WORKOUT=null;AW_UPDATED=0;}
// Wipes ALL in-memory per-user state + pending timers so nothing from user A can reach user B.
function p1SwitchUser(){
  const sv=SV;
  // unsaved changes of the account being left are kept in its local snapshot (never wiped, never sent to another account)
  if(sv&&dataLoadedUid===sv.uid&&sv.saved<sv.rev){const ts=svStamp(sv);snapWrite(sv.uid,buildPayload(ts),ts);}
  if(sv){clearTimeout(sv.timer);sv.timer=null;clearTimeout(sv.retry);sv.retry=null;}
  SV=null;loadSeq++;
  dataLoadedUid=null;wkStopTicker();wkReturn=false;
  CATS=[];EX={};DATA={};MSETS={};CUSTOM_MUSCLES=[];HIDDEN_MUSCLES=new Set();SPLITS=[];activeSplitId=null;UNPLACED={};EXTRA={};REPAIR={dropped:0,unplaced:0};NORM_UID=null;
  p1Reset();
  selEx=null;selCatCtx=null;sets=[];logLast=null;selDay='all';mOpen=null;wkLastRecord=null;histOpenId=null;expCats=new Set();
  modalCats=new Set();modalMuscles=new Set();editExCats=new Set();editExMuscles=new Set();
  try{stopTimer();}catch(e){}
  unit='kg';timerTotal=90;
  ['st-body','pl-week','pl-routines','wk-list','hlist','pstats','pchart','psess','pgoal','msets-wrap','ws-bodymap','ws-prlist','mlist','m-splits','picker','slist','catpills','onboard-wrap','wcard','exp-cats','cal-grid','dp-list','rt-exlist','xp-list','wl-recent','ex-muscles','editex-muscles'].forEach(id=>{const e=gid(id);if(e)e.innerHTML='';});
  const pe=gid('progex');if(pe)pe.innerHTML='<option value="">— Pick an exercise —</option>';
  ['exsearch','hsearch','msearch','xp-search'].forEach(id=>{const e=gid(id);if(e)e.value='';});
  [['prof-name','—'],['prof-email','—'],['prof-avatar','?'],['sidebar-name','Your account'],['sidebar-avatar','?']].forEach(([id,t])=>{const e=gid(id);if(e)e.textContent=t;});
  const lw=gid('logwrap');if(lw)lw.style.display='none';
  const se=gid('exsearch');if(se)se.style.display='block';
  const cp=gid('catpills');if(cp)cp.style.display='flex';
  const b=gid('wk-banner');if(b)b.classList.remove('show');
  const s=gid('wk-summary');if(s)s.classList.remove('on');
  document.querySelectorAll('.moverlay.on').forEach(m=>m.classList.remove('on'));
}

// ── local backups (survive refresh + temporary Firebase failure) ──
const awKey=uid=>'lifts_aw_'+uid, pwKey=uid=>'lifts_pw_'+uid;
function pendingRead(uid){try{const a=JSON.parse(localStorage.getItem(pwKey(uid))||'[]');return Array.isArray(a)?a:[];}catch(e){return [];}}
function pendingWrite(uid,arr){try{if(arr.length)localStorage.setItem(pwKey(uid),JSON.stringify(arr));else localStorage.removeItem(pwKey(uid));}catch(e){}}
function pendingAdd(uid,rec){const a=pendingRead(uid).filter(x=>x.id!==rec.id);a.push(rec);pendingWrite(uid,a);}
function pendingPrune(uid,savedIds){pendingWrite(uid,pendingRead(uid).filter(x=>!savedIds.has(x.id)));}

// Make sure per-exercise history (DATA) contains the sets of a workout. Never overwrites other sessions.
// With a workout id, the workout's own entry is created/kept in sync; without one, the legacy
// one-entry-per-exercise/date/category rule applies (used by older callers and quick logs).
function ensureSessions(date,exs,wid){
  let added=false;
  if(!isoOf(date))return false;   // never create a session without a real calendar date
  (exs||[]).forEach(ex=>{
    if(!ex||!ex.name||!Array.isArray(ex.sets)||!ex.sets.length)return;
    const cat=ex.cat||primCat(ex.name);
    const arr=sessionsFor(ex.name);
    DATA[ex.name]=arr;
    const sets=ex.sets.map(s=>({weight:s.weight,reps:s.reps,unit:unitOf(s.unit)}));
    const i=wid?arr.findIndex(e=>e.wid===wid&&e.cat===cat):arr.findIndex(e=>e.date===date&&e.cat===cat);
    if(i<0){
      const rec={date,cat,sets};
      if(wid)rec.wid=wid;
      arr.push(rec);
      arr.sort((a,b)=>a.date.localeCompare(b.date));
      added=true;
    }else if(wid&&JSON.stringify(arr[i].sets)!==JSON.stringify(sets)){
      arr[i]={...arr[i],date,cat,sets}; // this workout is the source of truth for its own entry
      added=true;
    }
  });
  return added;
}

// ── load from Firestore doc ──────────────────────────
function p1LoadFrom(d,uid){
  ROUTINES=normRoutines(d.routines);     // idempotent: already-validated lists pass through unchanged
  SCHEDULE=normSchedule(d.schedule);
  WORKOUTS=normWorkouts(d.workouts);
  wkResolveRestore(uid,d);
  p1MergePending(uid);
}
function wkResolveRestore(uid,d){
  const fsAw=(d&&d.activeWorkout&&typeof d.activeWorkout==='object')?JSON.parse(JSON.stringify(d.activeWorkout)):null;
  const fsT=Number(d&&d.awUpdatedAt)||(fsAw&&Number(fsAw.updatedAt))||0;
  let loc=null;try{loc=JSON.parse(localStorage.getItem(awKey(uid))||'null');}catch(e){}
  const locT=(loc&&Number(loc.updatedAt))||0;
  let aw,t;
  if(loc&&locT>fsT){aw=loc.aw||null;t=locT;} else {aw=fsAw;t=fsT;}
  const valid=aw&&isFinite(Number(aw.startedAt))&&Array.isArray(aw.exercises);
  if(!valid){ACTIVE_WORKOUT=null;AW_UPDATED=t;return;}
  aw.startedAt=Number(aw.startedAt);
  aw.date=isoOf(aw.date)||localISO(new Date(aw.startedAt));
  aw.routineName=(typeof aw.routineName==='string'&&aw.routineName)?aw.routineName:'Workout';
  aw.exercises=aw.exercises.filter(e=>e&&typeof e.name==='string').map(e=>({...e,cat:(typeof e.cat==='string'&&e.cat)?e.cat:primCat(e.name)}));
  {const lg={};   // logged sets: keep every readable entry/set, drop the rest
   if(isObj(aw.logged))Object.keys(aw.logged).forEach(k=>{
     const e=aw.logged[k];if(!isObj(e))return;
     const {sets}=normSets(e.sets);if(!sets.length)return;
     lg[k]={...e,cat:(typeof e.cat==='string'&&e.cat)?e.cat:primCat(wkKeyName(k)),sets};
   });
   aw.logged=lg;
   if(isObj(aw.base)){const b={};Object.keys(aw.base).forEach(k=>{if(Array.isArray(aw.base[k]))b[k]=normSets(aw.base[k]).sets;});aw.base=b;}else delete aw.base;}
  ACTIVE_WORKOUT=aw;AW_UPDATED=t;
  // if Firebase had failed earlier, re-apply sets logged in this workout to the exercise history
  const exs=Object.keys(aw.logged).map(k=>({name:wkKeyName(k),cat:aw.logged[k].cat,sets:aw.logged[k].sets}));
  if(ensureSessions(aw.date,exs,aw.id))scheduleSave();
  if(loc&&locT>fsT)scheduleSave(); // local copy was newer than cloud — push it up
}
// A workout finished while Firebase was failing is kept in localStorage until a save succeeds.
function p1MergePending(uid){
  const pend=pendingRead(uid);if(!pend.length)return;
  const have=new Set(WORKOUTS.map(w=>w.id));
  const keep=[];let changed=false;
  pend.forEach(w=>{
    const n=(w&&typeof w==='object')?normWorkout(w):null;
    const id=n?textOf(w.id):'';
    if(!n||!id){ if(w&&typeof w==='object')keep.push(w); return; }   // unreadable record: never merged, never deleted
    if(have.has(id))return;        // already present (cloud copy, or an earlier entry of this queue) → duplicate, drop
    have.add(id);                  // accepted: later duplicates are rejected immediately
    const rec={...n,id};
    WORKOUTS.push(rec);ensureSessions(rec.date,rec.exercises,rec.id);changed=true;
    keep.push(rec);                // stays queued until a cloud save is confirmed (pendingPrune)
  });
  pendingWrite(uid,keep);
  if(changed)scheduleSave();
}
function p1Boot(){
  if(ACTIVE_WORKOUT){gid('logdate').value=ACTIVE_WORKOUT.date;wkStartTicker();}else wkStopTicker();
  wkRenderBanner();renderStart();renderPlan();
}
function p1Refresh(){const cur=document.querySelector('.scr.on');if(cur&&cur.id==='s-start')renderStart();wkTick();}

// ── active workout persistence ───────────────────────
function wkPersist(){
  if(!currentUser)return;
  AW_UPDATED=Date.now();
  if(ACTIVE_WORKOUT)ACTIVE_WORKOUT.updatedAt=AW_UPDATED;
  try{localStorage.setItem(awKey(currentUser.uid),JSON.stringify({aw:ACTIVE_WORKOUT,updatedAt:AW_UPDATED}));}catch(e){}
  scheduleSave();
}

// ── timer: ALWAYS derived from timestamps; setInterval only repaints ──
let wkTimer=null;
const wkElapsedMs=()=>ACTIVE_WORKOUT?Math.max(0,Date.now()-ACTIVE_WORKOUT.startedAt):0;
function wkTick(){
  if(!ACTIVE_WORKOUT)return;
  const t=fmtClock(wkElapsedMs());
  document.querySelectorAll('.wk-clock').forEach(e=>{if(e.textContent!==t)e.textContent=t;});
}
function wkStartTicker(){clearInterval(wkTimer);wkTimer=null;if(!ACTIVE_WORKOUT)return;wkTick();wkTimer=setInterval(wkTick,1000);}
function wkStopTicker(){clearInterval(wkTimer);wkTimer=null;}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){flushSave().catch(()=>{});}   // push any pending save before the tab is suspended
  else p1Refresh();                                   // resync clock + day rollover when coming back
});
window.addEventListener('pageshow',p1Refresh);
window.addEventListener('focus',p1Refresh);
window.addEventListener('pagehide',()=>{flushSave().catch(()=>{});});

function wkRenderBanner(){
  const b=gid('wk-banner');if(!b)return;
  const cur=document.querySelector('.scr.on');
  const onWk=cur&&cur.id==='s-workout';
  if(ACTIVE_WORKOUT&&!onWk){b.classList.add('show');gid('wk-bn').textContent=ACTIVE_WORKOUT.routineName;wkTick();}
  else b.classList.remove('show');
}
// An active workout logs each exercise under its name (a.logged[name]). When the SAME exercise name is logged under a second
// category in the same workout, that log is kept under name+SEP+category instead of overwriting the first one.
const wkSep='\u0001';
const wkKeyName=k=>String(k).split(wkSep)[0];
function wkLogFor(a,name,cat){   // the logged entry that belongs to this (exercise, category)
  const pl=a.logged[name];
  if(pl&&pl.cat===cat)return pl;
  const c=a.logged[name+wkSep+cat];if(c)return c;
  if(pl&&!a.exercises.some(e=>e.name===name&&e.cat===pl.cat))return pl;  // older workouts: the plain-name log belongs to the entry no other entry claims
  return null;
}
const wkSetCount=a=>Object.keys(a.logged||{}).reduce((n,k)=>n+(((a.logged[k]||{}).sets)||[]).length,0);
const wkExCount=a=>Object.keys(a.logged||{}).filter(k=>(((a.logged[k]||{}).sets)||[]).length).length;

// ── START tab ────────────────────────────────────────
const DUMBBELL='<svg viewBox="0 0 24 24"><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/></svg>';
function renderStart(){
  const body=gid('st-body');if(!body)return;
  body.innerHTML='';
  const now=new Date(),day=todayDay();
  gid('st-sub').textContent=day.l+' · '+fmtDate(localISO(now));
  if(ACTIVE_WORKOUT){
    const a=ACTIVE_WORKOUT,card=mk('div','st-card active');
    card.append(mk('div','st-lbl','Workout in progress'),mk('div','st-name',a.routineName),mk('div','st-clock wk-clock',fmtClock(wkElapsedMs())),
      mk('div','st-meta',plural(a.exercises.length,'exercise')+' · '+plural(wkSetCount(a),'set')+' logged'));
    const b=mk('button','btn bacc st-big','Continue Workout');b.onclick=()=>go('workout');
    card.appendChild(b);body.appendChild(card);
    stPlanBtn(body);
    return;
  }
  const todays=(SCHEDULE[day.k]||[]).map(resolveSched).filter(Boolean);
  const todayRefs=new Set(todays.map(r=>r.ref));
  // Rest day → friendly subtitle (no big card); scheduled day → big "Today's Workout" card(s) as before
  if(!todays.length)gid('st-sub').textContent=day.l+" — rest day, but no one's stopping you";
  todays.forEach((r,i)=>{
    const card=mk('div','st-card');
    card.appendChild(mk('div','st-lbl',i===0?(todays.length>1?"Today's Workout · "+todays.length+' routines':"Today's Workout"):'Also today'));
    card.appendChild(mk('div','st-name',r.name));
    card.appendChild(mk('div','st-meta',plural(r.exercises.length,'exercise')));
    if(r.exercises.length)card.appendChild(mk('div','st-prev',r.exercises.map(e=>e.name).join(' · ')));
    const b=mk('button','btn bacc st-big','Start Workout');b.onclick=()=>wkStart(r.ref);
    card.appendChild(b);body.appendChild(card);
  });
  // Any other routine can be started today (e.g. Pull on a Push day) — it is simply what you chose to do
  const others=ROUTINES.filter(r=>!todayRefs.has(r.id));
  if(others.length){
    body.appendChild(mk('div','m-slabel','Other routines'));
    others.forEach(r=>{
      const row=mk('div','pl-rcard');
      const ico=mk('div','pl-ico');ico.innerHTML=DUMBBELL;
      const info=mk('div','pl-rtinfo');info.append(mk('div','pl-rtname',r.name),mk('div','pl-rtsub',plural(r.exercises.length,'exercise')));
      const go2=mk('button','st-pill','Start');go2.onclick=()=>wkStart(r.id);
      row.append(ico,info,go2);body.appendChild(row);
    });
  } else if(!ROUTINES.length){
    body.appendChild(mk('div','st-hint','Build your week with the Plan button below — create routines and assign them to days.'));
  }
  // only the ACTIVE split's categories are offered here (no active split → all categories, same as the Log filter)
  const activeSp=SPLITS.find(x=>x.id===activeSplitId);
  const otherCats=CATS.filter(c=>(!activeSp||(activeSp.catIds||[]).includes(c.id))&&!todayRefs.has(CATREF+c.id)&&(EX[c.id]||[]).length);
  if(otherCats.length){
    body.appendChild(mk('div','m-slabel',activeSp?'Categories · '+activeSp.label:'Categories'));
    otherCats.forEach(c=>{
      const row=mk('div','pl-rcard');
      const ico=mk('div','pl-ico');ico.innerHTML=DUMBBELL;ico.style.background=c.color;
      const info=mk('div','pl-rtinfo');info.append(mk('div','pl-rtname',c.label),mk('div','pl-rtsub',plural((EX[c.id]||[]).length,'exercise')+' · Category'));
      const go2=mk('button','st-pill','Start');go2.onclick=()=>wkStart(CATREF+c.id);
      row.append(ico,info,go2);body.appendChild(row);
    });
  }
  const fr=mk('button','st-free','');fr.innerHTML='<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>Freestyle workout (pick as you go)';
  fr.onclick=()=>wkStart(null);body.appendChild(fr);
  const q=mk('button','btn bgh st-sec','Quick log (no workout)');q.onclick=()=>go('log');body.appendChild(q);
  stPlanBtn(body);
}
function stPlanBtn(body){
  const p=mk('button','btn bgh st-sec','Plan');p.onclick=()=>go('plan');body.appendChild(p);
}

// ── PLAN tab: week schedule + routines ───────────────
function renderPlan(){
  const wk=gid('pl-week'),rl=gid('pl-routines');if(!wk||!rl)return;
  wk.innerHTML='';rl.innerHTML='';
  const today=todayDay().k;
  DAYS.forEach(d=>{
    const rts=(SCHEDULE[d.k]||[]).map(resolveSched).filter(Boolean);
    const card=mk('div','pl-day'+(d.k===today?' today':''));
    const head=mk('div','pl-dhead');
    head.appendChild(mk('span','pl-dname',d.l));
    if(d.k===today)head.appendChild(mk('span','pl-today','TODAY'));
    head.appendChild(mk('span','pl-sp'));
    const nR=rts.filter(x=>x.kind==='routine').length,nC=rts.length-nR,parts=[];
    if(nR)parts.push(plural(nR,'routine'));
    if(nC)parts.push(nC===1?'1 category':nC+' categories');
    head.appendChild(rts.length?mk('span','pl-dcount',parts.join(' · ')):mk('span','pl-rest','Rest'));
    const add=mk('button','pl-add','+');add.title='Add routine';add.onclick=()=>dpOpen(d.k,'add');
    head.appendChild(add);card.appendChild(head);
    rts.forEach(r=>{
      const row=mk('div','pl-rt');
      const ico=mk('div','pl-ico');ico.innerHTML=DUMBBELL;
      if(r.kind==='category')ico.style.background=r.color;
      const info=mk('div','pl-rtinfo');info.append(mk('div','pl-rtname',r.name),mk('div','pl-rtsub',plural(r.exercises.length,'exercise')+(r.kind==='category'?' · Category':'')));
      if(r.kind==='routine')info.onclick=()=>rtOpen(r.id);
      const sw=mk('button','pl-ib','⇄');sw.title='Change';sw.onclick=()=>dpOpen(d.k,'swap',r.ref);
      const x=mk('button','pl-ib x','✕');x.title='Remove from day';x.onclick=()=>planRemove(d.k,r.ref);
      row.append(ico,info,sw,x);card.appendChild(row);
    });
    wk.appendChild(card);
  });
  if(!ROUTINES.length){rl.appendChild(mk('div','empty','No routines yet — create one, then assign it to days.'));return;}
  ROUTINES.forEach(r=>{
    const days=DAYS.filter(d=>(SCHEDULE[d.k]||[]).includes(r.id)).map(d=>d.s).join(' · ');
    const row=mk('div','pl-rcard');
    const ico=mk('div','pl-ico');ico.innerHTML=DUMBBELL;
    const info=mk('div','pl-rtinfo');info.append(mk('div','pl-rtname',r.name),mk('div','pl-rtsub',plural(r.exercises.length,'exercise')+' · '+(days||'not scheduled')));
    const ed=mk('button','pl-ib','✎');ed.title='Edit';ed.onclick=()=>rtOpen(r.id);
    const du=mk('button','pl-ib','⧉');du.title='Duplicate';du.onclick=()=>rtDuplicate(r.id);
    row.append(ico,info,ed,du);rl.appendChild(row);
  });
}
function planRemove(dayKey,id){
  SCHEDULE[dayKey]=(SCHEDULE[dayKey]||[]).filter(x=>x!==id);
  scheduleSave();renderPlan();renderStart();toast('Removed from '+DAYS.find(d=>d.k===dayKey).l);
}

// day → pick routine (add / swap)
let dp={day:null,mode:'add',replaceId:null};
function dpOpen(day,mode,replaceId){
  dp={day,mode,replaceId:replaceId||null};
  const label=DAYS.find(d=>d.k===day).l;
  gid('dp-title').textContent=(mode==='swap'?'Change · ':'Add to ')+label;
  renderDp();gid('modal-daypick').classList.add('on');
}
function renderDp(){
  const w=gid('dp-list');w.innerHTML='';
  const onDay=SCHEDULE[dp.day]||[];
  const addRow=(ref,name,sub,color)=>{
    const cur=dp.mode==='swap'&&ref===dp.replaceId;
    const has=onDay.includes(ref)&&!cur;
    const b=mk('button','dp-item'+(has?' has':''));
    const nm=mk('div');
    if(color){const dt=mk('span','dot');dt.style.background=color;dt.style.marginRight='8px';nm.append(dt,document.createTextNode(name));}else nm.textContent=name;
    const left=mk('div');left.append(nm,mk('div','dp-sub',sub));
    b.append(left,mk('span','xp-st',has?'On this day':(cur?'Current':'')));
    if(!has)b.onclick=()=>dpPick(ref);
    w.appendChild(b);
  };
  if(ROUTINES.length){
    w.appendChild(mk('div','m-slabel','Routines'));
    ROUTINES.forEach(r=>addRow(r.id,r.name,plural(r.exercises.length,'exercise')));
  }
  if(CATS.length){
    const l=mk('div','m-slabel','Categories');l.style.marginTop='12px';w.appendChild(l);
    CATS.forEach(c=>addRow(CATREF+c.id,c.label,plural((EX[c.id]||[]).length,'exercise')+' · all of this category',c.color));
  }
  const nb=mk('button','addbtn','+ New routine');nb.style.marginTop='10px';
  nb.onclick=()=>{closeModal('daypick');rtOpen(null,dp.day);};
  w.appendChild(nb);
}
function dpPick(id){
  const arr=SCHEDULE[dp.day]=SCHEDULE[dp.day]||[];
  if(dp.mode==='swap'){const i=arr.indexOf(dp.replaceId);if(i>=0)arr[i]=id;else arr.push(id);}
  else if(!arr.includes(id))arr.push(id);
  SCHEDULE[dp.day]=arr.filter((x,i)=>arr.indexOf(x)===i);
  scheduleSave();closeModal('daypick');renderPlan();renderStart();toast('Schedule updated ✓');
}

// ── routine editor ───────────────────────────────────
let rt=null;
function rtOpen(id,preDay){
  const r=id?routineById(id):null;
  rt={id:r?r.id:null,name:r?r.name:'',exercises:r?r.exercises.map(e=>({name:e.name,cat:rtExCat(e)})):[],days:new Set()};
  DAYS.forEach(d=>{if(r&&(SCHEDULE[d.k]||[]).includes(r.id))rt.days.add(d.k);});
  if(!r&&preDay)rt.days.add(preDay);
  gid('rt-mtitle').textContent=r?'Edit Routine':'New Routine';
  gid('rt-name').value=rt.name;
  gid('rt-extra').style.display=r?'flex':'none';
  renderRtEx();renderRtDays();
  gid('modal-routine').classList.add('on');
  if(!r)setTimeout(()=>gid('rt-name').focus(),220);
}
function renderRtEx(){
  const w=gid('rt-exlist');w.innerHTML='';
  if(!rt.exercises.length){w.appendChild(mk('div','rt-empty','No exercises yet'));return;}
  rt.exercises.forEach((e,i)=>{
    const row=mk('div','rt-ex');
    const ud=mk('div','mupdown');
    const up=mk('button','mud','▲');up.disabled=i===0;up.onclick=()=>rtMove(i,-1);
    const dn=mk('button','mud','▼');dn.disabled=i===rt.exercises.length-1;dn.onclick=()=>rtMove(i,1);
    ud.append(up,dn);
    const dot=mk('span','dot');dot.style.background=catColor(rtExCat(e));
    const x=mk('button','mdel','✕');x.onclick=()=>{rt.exercises.splice(i,1);renderRtEx();};
    row.append(ud,dot,mk('span','rt-exname',e.name),x);w.appendChild(row);
  });
}
function rtMove(i,dir){
  const j=i+dir;if(j<0||j>=rt.exercises.length)return;
  [rt.exercises[i],rt.exercises[j]]=[rt.exercises[j],rt.exercises[i]];renderRtEx();
}
function renderRtDays(){
  const w=gid('rt-days');w.innerHTML='';
  DAYS.forEach(d=>{
    const b=mk('button','rt-day'+(rt.days.has(d.k)?' on':''),d.s.slice(0,3));
    b.onclick=()=>{if(rt.days.has(d.k))rt.days.delete(d.k);else rt.days.add(d.k);renderRtDays();};
    w.appendChild(b);
  });
}
function rtAddEx(){xpOpen('routine');}
function rtSave(){
  const name=gid('rt-name').value.trim();
  if(!name){toast('Enter a name');return;}
  let r=rt.id?routineById(rt.id):null;
  if(!r){r={id:newId('rt'),name,exercises:[]};ROUTINES.push(r);}
  r.name=name;
  r.exercises=rt.exercises.map(e=>({name:e.name,cat:e.cat}));
  DAYS.forEach(d=>{
    const arr=SCHEDULE[d.k]=SCHEDULE[d.k]||[];
    const has=arr.includes(r.id),want=rt.days.has(d.k);
    if(want&&!has)arr.push(r.id);
    if(!want&&has)SCHEDULE[d.k]=arr.filter(x=>x!==r.id);
  });
  scheduleSave();closeModal('routine');renderPlan();renderStart();toast('Routine saved ✓');
}
function rtDuplicate(id){
  const src=routineById(id||(rt&&rt.id));if(!src)return;
  ROUTINES.push({id:newId('rt'),name:src.name+' (copy)',exercises:src.exercises.map(e=>({name:e.name,cat:e.cat}))});
  scheduleSave();closeModal('routine');renderPlan();toast('Duplicated ✓');
}
function rtDelete(){
  const r=rt&&rt.id?routineById(rt.id):null;if(!r)return;
  if(!confirm('Delete routine "'+r.name+'"? It will also be removed from your schedule. Past workouts are kept.'))return;
  ROUTINES=ROUTINES.filter(x=>x.id!==r.id);
  DAYS.forEach(d=>{SCHEDULE[d.k]=(SCHEDULE[d.k]||[]).filter(x=>x!==r.id);});
  scheduleSave();closeModal('routine');renderPlan();renderStart();toast('Routine deleted');
}

// ── exercise picker (references the existing library; never edits it) ──
let xp={mode:'routine'};
function xpOpen(mode){xp.mode=mode;gid('xp-search').value='';renderXp();gid('modal-expick').classList.add('on');}
function xpHas(name){
  if(xp.mode==='routine')return !!rt&&rt.exercises.some(e=>e.name===name);
  return !!ACTIVE_WORKOUT&&ACTIVE_WORKOUT.exercises.some(e=>e.name===name);
}
function renderXp(){
  const w=gid('xp-list');w.innerHTML='';
  const q=gid('xp-search').value.trim().toLowerCase();
  let any=false;
  CATS.forEach(cat=>{
    const names=(EX[cat.id]||[]).filter(n=>!q||n.toLowerCase().includes(q));
    if(!names.length)return;any=true;
    const lab=mk('div','xp-cat',cat.label);lab.style.color=cat.color;w.appendChild(lab);
    names.forEach(n=>{
      const has=xpHas(n);
      const b=mk('button','xp-item'+(has?' has':''));
      b.append(mk('span',null,n),mk('span','xp-st',has?'✓ Added':'+'));
      if(!has)b.onclick=()=>xpAdd(n,cat.id);
      w.appendChild(b);
    });
  });
  if(!any)w.appendChild(mk('div','rt-empty',CATS.length?'No exercises found':'Add exercises in Manage first'));
}
function xpAdd(name,cat){
  if(xpHas(name))return;
  if(xp.mode==='routine'){rt.exercises.push({name,cat});renderRtEx();}
  else if(ACTIVE_WORKOUT){ACTIVE_WORKOUT.exercises.push({name,cat});wkPersist();renderWorkout();}
  renderXp();
}

// ── START / ACTIVE WORKOUT ───────────────────────────
function wkStart(routineId){
  if(ACTIVE_WORKOUT){toast('A workout is already in progress');go('workout');return;}
  if(!currentUser||dataLoadedUid!==currentUser.uid){toast('Still loading your data — try again in a moment');return;}
  const r=routineId?resolveSched(routineId):null;
  const now=Date.now();
  ACTIVE_WORKOUT={
    id:newId('w'),routineId:r?r.id:null,routineName:r?r.name:'Workout',
    startedAt:now,date:localISO(new Date(now)),
    exercises:r?r.exercises.map(e=>({name:e.name,cat:rtExCat(e)})):[],
    prBefore:Object.fromEntries((r?r.exercises:[]).map(e=>[e.name,getPR(sessionsFor(e.name))])),
    logged:{},updatedAt:now
  };
  gid('logdate').value=ACTIVE_WORKOUT.date;
  wkPersist();wkStartTicker();go('workout');
}
function renderWorkout(){
  const a=ACTIVE_WORKOUT;if(!a)return;
  gid('wk-title').textContent=a.routineName;
  gid('wk-sub').textContent=plural(a.exercises.length,'exercise')+' · '+plural(wkSetCount(a),'set');
  wkTick();
  const list=gid('wk-list');list.innerHTML='';
  if(!a.exercises.length)list.appendChild(mk('div','empty','No exercises yet — tap "+ Add Exercise".'));
  a.exercises.forEach(ex=>{
    const cat=catById(ex.cat)?ex.cat:primCat(ex.name);
    const lg=wkLogFor(a,ex.name,ex.cat),sets=(lg&&lg.sets)||[];
    const card=mk('div','wk-ex');
    const head=mk('div','wk-exhead');
    const dot=mk('span','dot');dot.style.background=catColor(cat);
    const exPR=getPR(sessionsFor(ex.name));
    const prTxt=exPR?mk('span','wk-expr','PR '+exPR.weight+unitOf(exPR.unit)+'×'+exPR.reps):null;
    head.append(dot,mk('span','wk-exname',ex.name+(a.exercises.filter(e=>e.name===ex.name).length>1?' · '+catLabel(ex.cat):'')));
    if(prTxt)head.appendChild(prTxt);
    head.appendChild(mk('span','wk-excount',sets.length?plural(sets.length,'set'):'not started'));
    head.onclick=()=>wkOpenEx(ex.name,cat,false);
    if(!sets.length){
      const x=mk('button','pl-ib x','✕');x.title='Remove from workout';
      x.onclick=e=>{e.stopPropagation();wkRemoveEx(ex.name,ex.cat);};head.appendChild(x);
    }
    card.appendChild(head);
    sets.forEach((s,i)=>{
      const row=mk('div','wk-set');
      row.append(mk('span','wk-setn',String(i+1)),mk('span',null,s.weight+' '+(s.unit||'kg')+' × '+s.reps));
      card.appendChild(row);
    });
    const add=mk('button','wk-addset','+ Add Set');add.onclick=()=>wkOpenEx(ex.name,cat,true);
    card.appendChild(add);list.appendChild(card);
  });
}
// Reuses the EXISTING log form (selectEx → saveLog). saveLog/cancelLog bring the user back here via wkReturn.
function wkOpenEx(name,cat,addOne){
  const a=ACTIVE_WORKOUT;if(!a)return;
  go('log');wkReturn=true;
  selectEx(name,cat);
  const own=wkLogFor(a,name,cat);
  const ownSets=(own&&Array.isArray(own.sets))?own.sets:[];
  if(ownSets.length){
    // Show only what was actually logged in THIS workout.
    logLast=null;
    sets=ownSets.map(rowFromSet);
    setUnit(unitOf(ownSets[0].unit)); // re-renders the rows
    if(addOne)addSet();
    return;
  }
  // Fresh exercise in this workout: never copy the previous session's sets into the form.
  // Its rows are mirrored as empty inputs whose placeholders show last time's numbers.
  const prev=sessionsFor(name).filter(s=>s.wid!==a.id).slice(-1)[0]||null;
  logLast=prev?{date:prev.date,sets:prev.sets.map(s=>({weight:s.weight,reps:s.reps,unit:unitOf(s.unit)}))}:null;
  const u=prev&&prev.sets[0]?unitOf(prev.sets[0].unit):unit;
  sets=(prev?prev.sets:[null]).map(s=>s?{w:'',r:'',u,lw:s.weight,lr:s.reps,lu:unitOf(s.unit)}:{w:'',r:'',u});
  setUnit(u);
  if(addOne)addSet();
}
function wkRemoveEx(name,cat){
  const a=ACTIVE_WORKOUT;if(!a)return;
  const lg=cat===undefined?a.logged[name]:wkLogFor(a,name,cat);
  if(lg&&lg.sets&&lg.sets.length)return;
  a.exercises=a.exercises.filter(e=>!(e.name===name&&(cat===undefined||e.cat===cat)));
  if(cat===undefined)delete a.logged[name];
  wkPersist();renderWorkout();
}
function wkAddExercise(){if(!ACTIVE_WORKOUT)return;xpOpen('workout');}
// called from saveLog(): remember what was logged inside the active workout
function wkRecordLogged(name,cat,entry){
  const a=ACTIVE_WORKOUT;if(!a||entry.date!==a.date)return;
  const pl=a.logged[name];
  const key=(!pl||pl.cat===cat)?name:name+wkSep+cat;
  if(!a.exercises.some(e=>e.name===name&&e.cat===cat)){
    const unstarted=key===name?a.exercises.find(e=>e.name===name&&!wkLogFor(a,name,e.cat)):null;
    if(unstarted)unstarted.cat=cat;else a.exercises.push({name,cat});
  }
  a.logged[key]={cat,sets:entry.sets.map(s=>({weight:s.weight,reps:s.reps,unit:unitOf(s.unit)}))};
  wkPersist();
}

// PR baselines travel with the active workout (including local/cloud restore).
// Without a baseline in an older resumed workout, omit PR claims rather than guessing from its own saved sets.
function wkCapturePRBaseline(a,name){
  if(!isObj(a.prBefore))a.prBefore={};
  if(Object.hasOwn(a.prBefore,name))return;
  if(Object.keys(a.logged||{}).some(k=>wkKeyName(k)===name&&a.logged[k]?.sets?.length))return;
  Object.defineProperty(a.prBefore,name,{value:getPR(sessionsFor(name)),enumerable:true,writable:true,configurable:true});
}
function workoutNewPRs(exercises,before){
  if(!isObj(before))return [];
  const grouped=new Map();
  (Array.isArray(exercises)?exercises:[]).forEach(ex=>{
    if(!ex||typeof ex.name!=='string')return;
    const sets=normSets(ex.sets).sets.filter(s=>s.weight>=0&&s.reps>0);
    grouped.set(ex.name,(grouped.get(ex.name)||[]).concat(sets));
  });
  const prs=[];
  grouped.forEach((sets,name)=>{
    if(!sets.length||!Object.hasOwn(before,name))return;
    const raw=before[name],previous=normSet(raw);
    if(raw!==null&&(!previous||previous.weight<0||previous.reps<=0))return;
    const best=getPR([{sets}]);
    if(!previous||compareSets(best,previous)>0)prs.push({name,weight:best.weight,reps:best.reps,unit:unitOf(best.unit)});
  });
  return prs;
}
const WK_PR_TROPHY='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8v5a4 4 0 0 1-8 0V3ZM8 5H4v2a4 4 0 0 0 4 4M16 5h4v2a4 4 0 0 1-4 4M12 12v5M9 17h6l1 4H8l1-4Z"/></svg>';
function renderWorkoutGoalProgress(record){
  const section=gid('ws-goal-progress');
  section.replaceChildren();
  const newPRNames=new Set((Array.isArray(record.prs)?record.prs:[]).map(pr=>pr.name));
  (Array.isArray(record.exercises)?record.exercises:[]).forEach(ex=>{
    if(!newPRNames.has(ex.name))return;
    const goal=getGoal(ex.name);
    if(!goal)return;
    const goalKg=toKg(goal.weight,goal.unit||'kg');
    const bestKg=Math.max(0,...(ex.sets||[]).map(s=>toKg(s.weight,s.unit||'kg')));
    const pct=goalKg>0?Math.min(100,Math.round(bestKg/goalKg*100)):0;
    const row=mk('div','wk-goal-row');
    const heading=mk('div','wk-goal-row-head');
    heading.append(mk('span','wk-goal-exercise',ex.name),mk('span','wk-goal-percent',pct+'%'));
    const track=mk('div','wk-goal-track');
    const fill=mk('div','wk-goal-fill'+(pct>=100?' done':''));
    fill.style.width=pct+'%';track.appendChild(fill);
    row.append(heading,track,mk('div','wk-goal-detail',fmtW(bestKg?convertWeight(bestKg,'kg',goal.unit||'kg'):0)+' / '+goal.weight+' '+(goal.unit||'kg')));
    section.appendChild(row);
  });
  if(section.childElementCount){
    section.prepend(mk('h2','wk-goal-title','Weight goal progress'));
  }
}
function renderWorkoutPRs(record){
  const list=gid('ws-prlist');list.replaceChildren();
  const prs=Array.isArray(record.prs)?record.prs:[];
  gid('ws-prs').textContent=prs.length;
  prs.forEach(pr=>{
    const row=mk('li');
    const icon=mk('span','wk-pr-icon');icon.innerHTML=WK_PR_TROPHY;icon.setAttribute('aria-hidden','true');
    row.append(icon,mk('span','wk-pr-label','New PR:'),mk('span',null,pr.name));
    row.title=pr.weight+' '+unitOf(pr.unit)+' × '+pr.reps;
    list.appendChild(row);
  });
}

// ── finish ───────────────────────────────────────────
function wkAskFinish(){
  const a=ACTIVE_WORKOUT;if(!a)return;
  const n=wkSetCount(a);
  if(!n){
    gid('fin-title').textContent='No sets logged';
    gid('fin-text').textContent='There is nothing to save yet. Discard this workout?';
    gid('fin-cancel').textContent='Keep going';gid('fin-ok').textContent='Discard';
  } else {
    gid('fin-title').textContent='Finish workout?';
    gid('fin-text').textContent='Your workout will be saved to History. '+fmtDur(wkElapsedMs()/1000)+' · '+plural(wkExCount(a),'exercise')+' · '+plural(n,'set')+'.';
    gid('fin-cancel').textContent='Cancel';gid('fin-ok').textContent='Finish';
  }
  gid('modal-finish').classList.add('on');
}
function wkConfirmFinish(){closeModal('finish');wkFinish();}
let wkLastRecord=null;
function wkFinish(){
  const a=ACTIVE_WORKOUT;if(!a||!currentUser)return; // also makes a double-tap harmless
  const uid=currentUser.uid,finishedAt=Date.now();
  const exercises=[];
  a.exercises.forEach(ex=>{
    const lg=wkLogFor(a,ex.name,ex.cat);
    if(lg&&lg.sets&&lg.sets.length)exercises.push({name:ex.name,cat:lg.cat||ex.cat,muscles:inferWorkoutMuscles(ex.name,lg.cat||ex.cat),sets:lg.sets.map(s=>({weight:s.weight,reps:s.reps,unit:unitOf(s.unit)}))});
  });
  let rec=null;
  if(exercises.length){
    rec={id:a.id,routineId:a.routineId||null,name:a.routineName,date:a.date,startedAt:a.startedAt,finishedAt,
         durationSec:Math.max(0,Math.round((finishedAt-a.startedAt)/1000)),exercises,prs:workoutNewPRs(exercises,a.prBefore)};
    ensureSessions(rec.date,rec.exercises,rec.id);   // history/PRs/streak read DATA — make sure every set is there
    if(!WORKOUTS.some(w=>w.id===rec.id))WORKOUTS.push(rec);
    pendingAdd(uid,rec);                       // local safety copy until the cloud save succeeds
  }
  ACTIVE_WORKOUT=null;AW_UPDATED=Date.now();
  try{localStorage.setItem(awKey(uid),JSON.stringify({aw:null,updatedAt:AW_UPDATED}));}catch(e){}
  wkStopTicker();wkReturn=false;
  scheduleSave();
  flushSave().then(ok=>{if(!ok&&currentUser&&currentUser.uid===uid)toast('Saved on this device — cloud sync pending');});
  wkRenderBanner();
  if(rec){
    wkLastRecord=rec;
    gid('ws-name').textContent=rec.name;
    gid('ws-dur').textContent=rec.durationSec<3600?Math.floor(rec.durationSec/60)+' min':fmtDur(rec.durationSec);
    gid('ws-ex').textContent=rec.exercises.length;
    gid('ws-sets').textContent=plural(rec.exercises.reduce((n,e)=>n+e.sets.length,0),'set');
    renderWorkoutPRs(rec);
    renderWorkoutGoalProgress(rec);
    gid('ws-bodymap').replaceChildren(buildWorkoutMuscleCard(rec));
    const summary=gid('wk-summary');
    summary.scrollTop=0;
    summary.classList.add('on');
    summary.focus({preventScroll:true});
    buildProgSel();renderMuscleSets();
  } else {toast('Workout discarded');go('start');}
}
function wkSummaryDone(){
  gid('wk-summary').classList.remove('on');go('start');
  document.querySelector('[data-tab="start"]')?.focus({preventScroll:true});
}
function wkSummaryKeydown(e){
  if(e.key==='Escape'){e.preventDefault();wkSummaryDone();return;}
  if(e.key!=='Tab')return;
  const summary=gid('wk-summary'),buttons=summary.querySelectorAll('button');
  const first=buttons[0],last=buttons[buttons.length-1];
  if(e.shiftKey&&(document.activeElement===first||document.activeElement===summary)){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
}
function wkSummaryView(){
  gid('wk-summary').classList.remove('on');
  histOpenId=wkLastRecord?wkLastRecord.id:null;
  go('history');
  const history=gid('s-history');history.tabIndex=-1;history.focus({preventScroll:true});
}

// ── HISTORY: completed workouts (legacy per-exercise history is rendered by renderHistory as before) ──
let histOpenId=null;
function renderWorkoutHistory(w,q){
  let list=WORKOUTS.slice().sort((a,b)=>(b.finishedAt||0)-(a.finishedAt||0)||String(b.date).localeCompare(String(a.date)));
  if(q)list=list.filter(x=>String(x.name||'').toLowerCase().includes(q)||(x.exercises||[]).some(e=>e&&String(e.name).toLowerCase().includes(q)));
  if(!list.length)return 0;
  w.appendChild(mk('div','m-slabel','Workouts'));
  list.forEach(x=>{
    const exs=x.exercises||[],nSets=exs.reduce((n,e)=>n+((e.sets||[]).length),0);
    const hasDur=typeof x.durationSec==='number'&&isFinite(x.durationSec);  // legacy/old records: no duration → just omit
    const el=mk('div','hent'+(histOpenId===x.id?' op':''));el.id='hw-'+x.id;
    const hdr=mk('div','hhdr');
    const dot=mk('span','dot');dot.style.background='var(--ac)';
    const col=mk('div');col.style.cssText='flex:1;min-width:0';
    col.append(mk('div','hname',x.name||'Workout'),
      mk('div','hmeta',fmtDate(x.date)+(hasDur?' · '+fmtDur(x.durationSec):'')+' · '+plural(exs.length,'exercise')+' · '+plural(nSets,'set')));
    hdr.append(dot,col,mk('span','hchev','▼'));
    const body=mk('div','hbody');
    // Build the large anatomy SVG only when a workout is opened, not for every history row.
    let muscleCard=null;
    const showMuscles=()=>{if(!muscleCard){muscleCard=buildWorkoutMuscleCard(x);body.prepend(muscleCard);}};
    hdr.onclick=()=>{el.classList.toggle('op');if(el.classList.contains('op'))showMuscles();};
    if(el.classList.contains('op'))showMuscles();
    if(hasDur||x.startedAt){
      const d=mk('div','hw-dur');
      d.appendChild(mk('span',null,x.startedAt&&x.finishedAt?clockTime(x.startedAt)+' – '+clockTime(x.finishedAt):fmtDate(x.date)));
      if(hasDur){const b=mk('b',null,fmtDur(x.durationSec));const s=mk('span',null,'Duration ');s.appendChild(b);d.appendChild(s);}
      body.appendChild(d);
    }
    exs.forEach(e=>{
      const blk=mk('div','sblk');
      const sd=mk('div','sdate',e.name);const cl=mk('span',null,' · '+catLabel(e.cat));cl.style.cssText='color:var(--m1);font-size:.55rem';sd.appendChild(cl);
      const chips=mk('div','schips');
      (e.sets||[]).forEach(s=>chips.appendChild(mk('span','chip',s.weight+(s.unit||'kg')+' × '+s.reps)));
      blk.append(sd,chips);body.appendChild(blk);
    });
    const del=mk('button','btn brd','Delete workout record');del.style.cssText='font-size:.55rem;padding:6px 11px;margin-top:6px';
    del.onclick=()=>{
      if(!confirm('Delete this workout record? The sets stay in each exercise\'s history.'))return;
      WORKOUTS=WORKOUTS.filter(v=>v.id!==x.id);
      if(currentUser)pendingWrite(currentUser.uid,pendingRead(currentUser.uid).filter(q=>!q||q.id!==x.id)); // don't let the local backup resurrect it
      scheduleSave();renderHistory();toast('Deleted');
    };
    body.appendChild(del);el.append(hdr,body);w.appendChild(el);
  });
  if(histOpenId){const id=histOpenId;histOpenId=null;setTimeout(()=>{const t=gid('hw-'+id);if(t)t.scrollIntoView({block:'center'});},50);}
  return list.length;
}

// exercise renamed in Manage → keep routines / active workout / workout records pointing at it
function p1OnExerciseRenamed(o,n){
  ROUTINES.forEach(r=>r.exercises.forEach(e=>{if(e.name===o)e.name=n;}));
  WORKOUTS.forEach(w=>w.exercises.forEach(e=>{if(e.name===o)e.name=n;}));
  const a=ACTIVE_WORKOUT;
  if(a){
    a.exercises.forEach(e=>{if(e.name===o)e.name=n;});
    [a.logged,a.base,a.prBefore].forEach(m=>{if(!m)return;Object.keys(m).forEach(k=>{if(wkKeyName(k)===o){const nk=n+k.slice(o.length);m[nk]=m[k];delete m[k];}});});
    wkPersist();
  }
}


// ── Expose public API for inline handlers & tests ──
function _expose(){
  const g = window;
  g.auth = auth;
  g.db = db;
  g.firebase = firebase;
  g.BM_DATA = BM_DATA;
  try{ g.BM_CATEGORY_ALIASES = BM_CATEGORY_ALIASES; }catch(e){}
  try{ g.BM_COLORS = BM_COLORS; }catch(e){}
  try{ g.BM_EXERCISE_RULES = BM_EXERCISE_RULES; }catch(e){}
  try{ g.BM_MAP = BM_MAP; }catch(e){}
  try{ g.BM_WORKOUT_COLORS = BM_WORKOUT_COLORS; }catch(e){}
  try{ g.CATREF = CATREF; }catch(e){}
  try{ g.CATS = CATS; }catch(e){}
  try{ g.CIRC = CIRC; }catch(e){}
  try{ g.CUSTOM_MUSCLES = CUSTOM_MUSCLES; }catch(e){}
  try{ g.DAYS = DAYS; }catch(e){}
  try{ g.DC = DC; }catch(e){}
  try{ g.DE = DE; }catch(e){}
  try{ g.DUMBBELL = DUMBBELL; }catch(e){}
  try{ g.HIDDEN_MUSCLES = HIDDEN_MUSCLES; }catch(e){}
  try{ g.KG_LB = KG_LB; }catch(e){}
  try{ g.KG_PER_LB = KG_PER_LB; }catch(e){}
  try{ g.KNOWN_FIELDS = KNOWN_FIELDS; }catch(e){}
  try{ g.MSETS = MSETS; }catch(e){}
  try{ g.MUSCLES = MUSCLES; }catch(e){}
  try{ g.ROUTINES = ROUTINES; }catch(e){}
  try{ g.SAVE_TIMEOUT_MS = SAVE_TIMEOUT_MS; }catch(e){}
  try{ g.SEED = SEED; }catch(e){}
  try{ g.SPLITS = SPLITS; }catch(e){}
  try{ g.SV = SV; }catch(e){}
  try{ g.SVG_OK_ATTR = SVG_OK_ATTR; }catch(e){}
  try{ g.SVG_OK_EL = SVG_OK_EL; }catch(e){}
  try{ g.UNPLACED = UNPLACED; }catch(e){}
  try{ g.WEIGHT_EPS_KG = WEIGHT_EPS_KG; }catch(e){}
  try{ g.WK_PR_TROPHY = WK_PR_TROPHY; }catch(e){}
  try{ g.addDaysISO = addDaysISO; }catch(e){}
  try{ g.addSet = addSet; }catch(e){}
  try{ g.addTimerSeconds = addTimerSeconds; }catch(e){}
  try{ g.allMuscles = allMuscles; }catch(e){}
  try{ g.allNames = allNames; }catch(e){}
  try{ g.appendTrustedSvg = appendTrustedSvg; }catch(e){}
  try{ g.applyDoc = applyDoc; }catch(e){}
  try{ g.authMode = authMode; }catch(e){}
  try{ g.awKey = awKey; }catch(e){}
  try{ g.beep = beep; }catch(e){}
  try{ g.bestSet = bestSet; }catch(e){}
  try{ g.bmLevel = bmLevel; }catch(e){}
  try{ g.bmName = bmName; }catch(e){}
  try{ g.bmSerial = bmSerial; }catch(e){}
  try{ g.bodyStatType = bodyStatType; }catch(e){}
  try{ g.bodyUnit = bodyUnit; }catch(e){}
  try{ g.bootApp = bootApp; }catch(e){}
  try{ g.buildBodyMap = buildBodyMap; }catch(e){}
  try{ g.buildCatPills = buildCatPills; }catch(e){}
  try{ g.buildPayload = buildPayload; }catch(e){}
  try{ g.buildProgSel = buildProgSel; }catch(e){}
  try{ g.buildWorkoutMuscleCard = buildWorkoutMuscleCard; }catch(e){}
  try{ g.calNext = calNext; }catch(e){}
  try{ g.calPrev = calPrev; }catch(e){}
  try{ g.calcStreak = calcStreak; }catch(e){}
  try{ g.calcWarmup = calcWarmup; }catch(e){}
  try{ g.cancelLog = cancelLog; }catch(e){}
  try{ g.catById = catById; }catch(e){}
  try{ g.catColor = catColor; }catch(e){}
  try{ g.catLabel = catLabel; }catch(e){}
  try{ g.changeRestDays = changeRestDays; }catch(e){}
  try{ g.setProfileUnit = setProfileUnit; }catch(e){}
  try{ g.setProfileTimer = setProfileTimer; }catch(e){}
  try{ g.setProfilePref = setProfilePref; }catch(e){}
  try{ g.toggleProfileEdit = toggleProfileEdit; }catch(e){}
  try{ g.saveProfileName = saveProfileName; }catch(e){}
  try{ g.profileResetPassword = profileResetPassword; }catch(e){}
  try{ g.checkExerciseGoalCelebration = checkExerciseGoalCelebration; }catch(e){}
  try{ g.clockTime = clockTime; }catch(e){}
  try{ g.closeModal = closeModal; }catch(e){}
  try{ g.compareSets = compareSets; }catch(e){}
  try{ g.compareWeights = compareWeights; }catch(e){}
  try{ g.conv = conv; }catch(e){}
  try{ g.convertWeight = convertWeight; }catch(e){}
  try{ g.currentUser = currentUser; }catch(e){}
  try{ g.dataLoadedUid = dataLoadedUid; }catch(e){}
  try{ g.deleteFromEdit = deleteFromEdit; }catch(e){}
  try{ g.deleteGoal = deleteGoal; }catch(e){}
  try{ g.deriveCats = deriveCats; }catch(e){}
  try{ g.doExport = doExport; }catch(e){}
  try{ g.doExportCSV = doExportCSV; }catch(e){}
  try{ g.doExportJSON = doExportJSON; }catch(e){}
  try{ g.downloadFile = downloadFile; }catch(e){}
  try{ g.dp = dp; }catch(e){}
  try{ g.dpOpen = dpOpen; }catch(e){}
  try{ g.dpPick = dpPick; }catch(e){}
  try{ g.drain = drain; }catch(e){}
  try{ g.drawChart = drawChart; }catch(e){}
  try{ g.editExCats = editExCats; }catch(e){}
  try{ g.editExFromCat = editExFromCat; }catch(e){}
  try{ g.editExMuscles = editExMuscles; }catch(e){}
  try{ g.editExOrigName = editExOrigName; }catch(e){}
  try{ g.editSplitId = editSplitId; }catch(e){}
  try{ g.emptySchedule = emptySchedule; }catch(e){}
  try{ g.ensureSessions = ensureSessions; }catch(e){}
  try{ g.expCats = expCats; }catch(e){}
  try{ g.expRange = expRange; }catch(e){}
  try{ g.flushSave = flushSave; }catch(e){}
  try{ g.fmtClock = fmtClock; }catch(e){}
  try{ g.fmtDate = fmtDate; }catch(e){}
  try{ g.fmtDay = fmtDay; }catch(e){}
  try{ g.fmtDur = fmtDur; }catch(e){}
  try{ g.fmtW = fmtW; }catch(e){}
  try{ g.friendlyErr = friendlyErr; }catch(e){}
  try{ g.fromKg = fromKg; }catch(e){}
  try{ g.gatherNames = gatherNames; }catch(e){}
  try{ g.getDateFilter = getDateFilter; }catch(e){}
  try{ g.getExMuscles = getExMuscles; }catch(e){}
  try{ g.getExercisesForExport = getExercisesForExport; }catch(e){}
  try{ g.getGoal = getGoal; }catch(e){}
  try{ g.getPR = getPR; }catch(e){}
  try{ g.getTimerLeft = getTimerLeft; }catch(e){}
  try{ g.getWorkoutDates = getWorkoutDates; }catch(e){}
  try{ g.gid = gid; }catch(e){}
  try{ g.go = go; }catch(e){}
  try{ g.goalBase = goalBase; }catch(e){}
  try{ g.goalExName = goalExName; }catch(e){}
  try{ g.goalUnit = goalUnit; }catch(e){}
  try{ g.hashId = hashId; }catch(e){}
  try{ g.hideWarmup = hideWarmup; }catch(e){}
  try{ g.histOpenId = histOpenId; }catch(e){}
  try{ g.inferWorkoutMuscles = inferWorkoutMuscles; }catch(e){}
  try{ g.initExport = initExport; }catch(e){}
  try{ g.initStreak = initStreak; }catch(e){}
  try{ g.isObj = isObj; }catch(e){}
  try{ g.isoOf = isoOf; }catch(e){}
  try{ g.localISO = localISO; }catch(e){}
  try{ g.logDateAuto = logDateAuto; }catch(e){}
  try{ g.mOpen = mOpen; }catch(e){}
  try{ g.migrateDataShape = migrateDataShape; }catch(e){}
  try{ g.mk = mk; }catch(e){}
  try{ g.modalCats = modalCats; }catch(e){}
  try{ g.modalMuscles = modalMuscles; }catch(e){}
  try{ g.moveEx = moveEx; }catch(e){}
  try{ g.moveInEdit = moveInEdit; }catch(e){}
  try{ g.newCatSplits = newCatSplits; }catch(e){}
  try{ g.newId = newId; }catch(e){}
  try{ g.newSV = newSV; }catch(e){}
  try{ g.normCats = normCats; }catch(e){}
  try{ g.normCustomMuscles = normCustomMuscles; }catch(e){}
  try{ g.normEx = normEx; }catch(e){}
  try{ g.normMsets = normMsets; }catch(e){}
  try{ g.normMuscleId = normMuscleId; }catch(e){}
  try{ g.normMuscleList = normMuscleList; }catch(e){}
  try{ g.normRoutines = normRoutines; }catch(e){}
  try{ g.normSchedule = normSchedule; }catch(e){}
  try{ g.normSession = normSession; }catch(e){}
  try{ g.normSet = normSet; }catch(e){}
  try{ g.normSets = normSets; }catch(e){}
  try{ g.normSplits = normSplits; }catch(e){}
  try{ g.normWorkout = normWorkout; }catch(e){}
  try{ g.normWorkouts = normWorkouts; }catch(e){}
  try{ g.numOf = numOf; }catch(e){}
  try{ g.openAddExModal = openAddExModal; }catch(e){}
  try{ g.openBodyModal = openBodyModal; }catch(e){}
  try{ g.openEditExModal = openEditExModal; }catch(e){}
  try{ g.openGoalModal = openGoalModal; }catch(e){}
  try{ g.openModal = openModal; }catch(e){}
  try{ g.openSplitModal = openSplitModal; }catch(e){}
  try{ g.openWeightGoalModal = openWeightGoalModal; }catch(e){}
  try{ g.p1Boot = p1Boot; }catch(e){}
  try{ g.p1LoadFrom = p1LoadFrom; }catch(e){}
  try{ g.p1MergePending = p1MergePending; }catch(e){}
  try{ g.p1OnExerciseRenamed = p1OnExerciseRenamed; }catch(e){}
  try{ g.p1Refresh = p1Refresh; }catch(e){}
  try{ g.p1Reset = p1Reset; }catch(e){}
  try{ g.p1SwitchUser = p1SwitchUser; }catch(e){}
  try{ g.pad2 = pad2; }catch(e){}
  try{ g.parseLocalDate = parseLocalDate; }catch(e){}
  try{ g.pendingAdd = pendingAdd; }catch(e){}
  try{ g.pendingPrune = pendingPrune; }catch(e){}
  try{ g.pendingRead = pendingRead; }catch(e){}
  try{ g.pendingWrite = pendingWrite; }catch(e){}
  try{ g.placeNames = placeNames; }catch(e){}
  try{ g.planRemove = planRemove; }catch(e){}
  try{ g.plural = plural; }catch(e){}
  try{ g.primCat = primCat; }catch(e){}
  try{ g.promptNewMuscle = promptNewMuscle; }catch(e){}
  try{ g.quarantine = quarantine; }catch(e){}
  try{ g.quarantineSnapshot = quarantineSnapshot; }catch(e){}
  try{ g.rebuildEx = rebuildEx; }catch(e){}
  try{ g.renderBodyStats = renderBodyStats; }catch(e){}
  try{ g.renderCal = renderCal; }catch(e){}
  try{ g.renderDp = renderDp; }catch(e){}
  try{ g.renderEditExCatPills = renderEditExCatPills; }catch(e){}
  try{ g.renderEditExMusclePills = renderEditExMusclePills; }catch(e){}
  try{ g.renderExCatPills = renderExCatPills; }catch(e){}
  try{ g.renderExMusclePills = renderExMusclePills; }catch(e){}
  try{ g.renderGoal = renderGoal; }catch(e){}
  try{ g.renderHistory = renderHistory; }catch(e){}
  try{ g.renderManage = renderManage; }catch(e){}
  try{ g.renderMuscleSets = renderMuscleSets; }catch(e){}
  try{ g.renderNewCatSplitPills = renderNewCatSplitPills; }catch(e){}
  try{ g.renderOnboarding = renderOnboarding; }catch(e){}
  try{ g.renderPicker = renderPicker; }catch(e){}
  try{ g.renderPlan = renderPlan; }catch(e){}
  try{ g.renderProfile = renderProfile; }catch(e){}
  try{ g.renderProgress = renderProgress; }catch(e){}
  try{ g.renderRtDays = renderRtDays; }catch(e){}
  try{ g.renderRtEx = renderRtEx; }catch(e){}
  try{ g.renderSets = renderSets; }catch(e){}
  try{ g.renderSplitCatPills = renderSplitCatPills; }catch(e){}
  try{ g.renderSplits = renderSplits; }catch(e){}
  try{ g.renderStart = renderStart; }catch(e){}
  try{ g.renderStreak = renderStreak; }catch(e){}
  try{ g.renderWorkout = renderWorkout; }catch(e){}
  try{ g.renderWorkoutHistory = renderWorkoutHistory; }catch(e){}
  try{ g.renderWorkoutPRs = renderWorkoutPRs; }catch(e){}
  try{ g.renderXp = renderXp; }catch(e){}
  try{ g.resolveSched = resolveSched; }catch(e){}
  try{ g.restDays = restDays; }catch(e){}
  try{ g.roundTo2_5 = roundTo2_5; }catch(e){}
  try{ g.routineById = routineById; }catch(e){}
  try{ g.rowFromSet = rowFromSet; }catch(e){}
  try{ g.rt = rt; }catch(e){}
  try{ g.rtAddEx = rtAddEx; }catch(e){}
  try{ g.rtDelete = rtDelete; }catch(e){}
  try{ g.rtDuplicate = rtDuplicate; }catch(e){}
  try{ g.rtExCat = rtExCat; }catch(e){}
  try{ g.rtMove = rtMove; }catch(e){}
  try{ g.rtOpen = rtOpen; }catch(e){}
  try{ g.rtSave = rtSave; }catch(e){}
  try{ g.safeColor = safeColor; }catch(e){}
  try{ g.sanitizeData = sanitizeData; }catch(e){}
  try{ g.saveBodyStat = saveBodyStat; }catch(e){}
  try{ g.saveCat = saveCat; }catch(e){}
  try{ g.saveEditEx = saveEditEx; }catch(e){}
  try{ g.saveEx = saveEx; }catch(e){}
  try{ g.saveGoal = saveGoal; }catch(e){}
  try{ g.saveLog = saveLog; }catch(e){}
  try{ g.saveSplit = saveSplit; }catch(e){}
  try{ g.saveWeightGoal = saveWeightGoal; }catch(e){}
  try{ g.scheduleSave = scheduleSave; }catch(e){}
  try{ g.selDay = selDay; }catch(e){}
  try{ g.selectEx = selectEx; }catch(e){}
  try{ g.sessionsFor = sessionsFor; }catch(e){}
  try{ g.setBodyUnit = setBodyUnit; }catch(e){}
  try{ g.setExMuscles = setExMuscles; }catch(e){}
  try{ g.setExpFormat = setExpFormat; }catch(e){}
  try{ g.setExpRange = setExpRange; }catch(e){}
  try{ g.setGoalUnit = setGoalUnit; }catch(e){}
  try{ g.setTimer = setTimer; }catch(e){}
  try{ g.setUnit = setUnit; }catch(e){}
  try{ g.showCelebration = showCelebration; }catch(e){}
  try{ g.showSync = showSync; }catch(e){}
  try{ g.snapClearIf = snapClearIf; }catch(e){}
  try{ g.snapKey = snapKey; }catch(e){}
  try{ g.snapPick = snapPick; }catch(e){}
  try{ g.snapRead = snapRead; }catch(e){}
  try{ g.snapWrite = snapWrite; }catch(e){}
  try{ g.snapshotShapeOk = snapshotShapeOk; }catch(e){}
  try{ g.splitCats = splitCats; }catch(e){}
  try{ g.stPlanBtn = stPlanBtn; }catch(e){}
  try{ g.startTimer = startTimer; }catch(e){}
  try{ g.stopTimer = stopTimer; }catch(e){}
  try{ g.strList = strList; }catch(e){}
  try{ g.svFailed = svFailed; }catch(e){}
  try{ g.svLive = svLive; }catch(e){}
  try{ g.svStamp = svStamp; }catch(e){}
  try{ g.switchTab = switchTab; }catch(e){}
  try{ g.textOf = textOf; }catch(e){}
  try{ g.timerInterval = timerInterval; }catch(e){}
  try{ g.toKg = toKg; }catch(e){}
  try{ g.toast = toast; }catch(e){}
  try{ g.toastTimer = toastTimer; }catch(e){}
  try{ g.todayDay = todayDay; }catch(e){}
  try{ g.togglePass = togglePass; }catch(e){}
  try{ g.toggleWarmup = toggleWarmup; }catch(e){}
  try{ g.unitOf = unitOf; }catch(e){}
  try{ g.updateTimerDisplay = updateTimerDisplay; }catch(e){}
  try{ g.userRef = userRef; }catch(e){}
  try{ g.weightChartSVG = weightChartSVG; }catch(e){}
  try{ g.wgMin = wgMin; }catch(e){}
  try{ g.wgRecalc = wgRecalc; }catch(e){}
  try{ g.wgUpdate = wgUpdate; }catch(e){}
  try{ g.withTimeout = withTimeout; }catch(e){}
  try{ g.wkAddExercise = wkAddExercise; }catch(e){}
  try{ g.wkAskFinish = wkAskFinish; }catch(e){}
  try{ g.wkCapturePRBaseline = wkCapturePRBaseline; }catch(e){}
  try{ g.wkConfirmFinish = wkConfirmFinish; }catch(e){}
  try{ g.wkElapsedMs = wkElapsedMs; }catch(e){}
  try{ g.wkExCount = wkExCount; }catch(e){}
  try{ g.wkFinish = wkFinish; }catch(e){}
  try{ g.wkKeyName = wkKeyName; }catch(e){}
  try{ g.wkLastRecord = wkLastRecord; }catch(e){}
  try{ g.wkLogFor = wkLogFor; }catch(e){}
  try{ g.wkOpenEx = wkOpenEx; }catch(e){}
  try{ g.wkPersist = wkPersist; }catch(e){}
  try{ g.wkRecordLogged = wkRecordLogged; }catch(e){}
  try{ g.wkRemoveEx = wkRemoveEx; }catch(e){}
  try{ g.wkRenderBanner = wkRenderBanner; }catch(e){}
  try{ g.wkResolveRestore = wkResolveRestore; }catch(e){}
  try{ g.wkReturn = wkReturn; }catch(e){}
  try{ g.wkSep = wkSep; }catch(e){}
  try{ g.wkSetCount = wkSetCount; }catch(e){}
  try{ g.wkStart = wkStart; }catch(e){}
  try{ g.wkStartTicker = wkStartTicker; }catch(e){}
  try{ g.wkStopTicker = wkStopTicker; }catch(e){}
  try{ g.wkSummaryDone = wkSummaryDone; }catch(e){}
  try{ g.wkSummaryKeydown = wkSummaryKeydown; }catch(e){}
  try{ g.wkSummaryView = wkSummaryView; }catch(e){}
  try{ g.wkTick = wkTick; }catch(e){}
  try{ g.wkTimer = wkTimer; }catch(e){}
  try{ g.wlBase = wlBase; }catch(e){}
  try{ g.wlRenderRecent = wlRenderRecent; }catch(e){}
  try{ g.wlSet = wlSet; }catch(e){}
  try{ g.wlStep = wlStep; }catch(e){}
  try{ g.wlToggleAll = wlToggleAll; }catch(e){}
  try{ g.wlValue = wlValue; }catch(e){}
  try{ g.workoutMuscleSets = workoutMuscleSets; }catch(e){}
  try{ g.workoutMusclesFor = workoutMusclesFor; }catch(e){}
  try{ g.workoutNewPRs = workoutNewPRs; }catch(e){}
  try{ g.xp = xp; }catch(e){}
  try{ g.xpAdd = xpAdd; }catch(e){}
  try{ g.xpHas = xpHas; }catch(e){}
  try{ g.xpOpen = xpOpen; }catch(e){}
}
_expose();
// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootApp);
} else {
  bootApp();
}
