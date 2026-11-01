(() => {
  const workouts = new Set(['2026-10-1','2026-10-3','2026-10-5','2026-10-7','2026-10-9','2026-10-11','2026-10-13','2026-10-15','2026-10-17','2026-10-19','2026-10-20','2026-10-22','2026-10-24','2026-10-26']);
  const safeRest = new Set(['2026-10-2','2026-10-4','2026-10-6','2026-10-8','2026-10-10','2026-10-12','2026-10-14','2026-10-16','2026-10-18','2026-10-21','2026-10-23','2026-10-25']);
  let year = 2026, month = 9, restDays = 2;
  const $ = id => document.getElementById(id);
  const toast = message => { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),1800); };
  function render(){
    $('monthTitle').textContent=new Date(year,month,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});
    const grid=$('calendar'); grid.replaceChildren();
    ['SUN','MON','TUE','WED','THU','FRI','SAT'].forEach(day=>{const el=document.createElement('div');el.className='day-name';el.textContent=day;grid.append(el)});
    const first=new Date(year,month,1).getDay(), count=new Date(year,month+1,0).getDate();
    for(let i=0;i<first;i++){const el=document.createElement('div');el.className='cal-day empty';grid.append(el)}
    for(let d=1;d<=count;d++){
      const el=document.createElement('div'), key=`${year}-${month+1}-${d}`;
      el.className='cal-day';el.textContent=d;
      if(workouts.has(key))el.classList.add('worked'); else if(safeRest.has(key))el.classList.add('rest'); else if(new Date(year,month,d)>new Date(2026,9,26))el.classList.add('future');
      if(year===2026&&month===9&&d===26)el.classList.add('today');
      grid.append(el);
    }
  }
  function updateRest(){ $('restValue').textContent=restDays; $('restSummary').innerHTML=`${restDays} <small>days</small>`; $('restValue').parentElement.nextElementSibling.querySelector('span:last-child').textContent=`With ${restDays} rest ${restDays===1?'day':'days'}, a new session every ${restDays+1} days keeps your current run alive.`; }
  $('prev').addEventListener('click',()=>{month--;if(month<0){month=11;year--}render()});
  $('next').addEventListener('click',()=>{month++;if(month>11){month=0;year++}render()});
  $('minus').addEventListener('click',()=>{if(restDays>0){restDays--;updateRest()}else toast('Zero rest days is already the minimum.')});
  $('plus').addEventListener('click',()=>{if(restDays<7){restDays++;updateRest()}else toast('Seven rest days is the sample maximum.')});
  $('todayBtn').addEventListener('click',()=>{year=2026;month=9;render();document.querySelector('.calendar-card').scrollIntoView({behavior:'smooth',block:'center'});toast('Showing sample date: October 26, 2026')});
  document.querySelectorAll('.nav-item:not(.active),.mobile-nav button:not(.active),#menu,.gear').forEach(el=>el.addEventListener('click',()=>toast('Streak preview only — navigation is not connected.')));
  const heatmap=$('heatmap');
  for(let day=0;day<84;day++){
    const cell=document.createElement('span');cell.className='heat-cell';
    const activity=(day*17+day*day*3+11)%13;
    if(activity===1||activity===7)cell.classList.add('l1');else if(activity===3||activity===9||activity===11)cell.classList.add('l2');else if(activity===5)cell.classList.add('l3');else if(activity===0||activity===8)cell.classList.add('l4');
    cell.title=cell.classList.contains('l0')?'No workout (sample)':'Sample activity';heatmap.append(cell);
  }
  render();updateRest();
})();
