(() => {
  const now=new Date();let year=now.getFullYear(),month=now.getMonth(),restDays=2;
  const $=id=>document.getElementById(id), iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const workoutDates=new Set();for(let ago=0;ago<24;ago+=2){const d=new Date(now);d.setDate(now.getDate()-ago);workoutDates.add(iso(d));}
  const safeDates=new Set();for(let ago=1;ago<24;ago+=2){const d=new Date(now);d.setDate(now.getDate()-ago);safeDates.add(iso(d));}
  function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),1900)}
  function render(){
    $('monthTitle').textContent=new Date(year,month,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});
    const grid=$('calendar');grid.replaceChildren();['SUN','MON','TUE','WED','THU','FRI','SAT'].forEach(x=>{const el=document.createElement('div');el.className='day-name';el.textContent=x;grid.append(el)});
    const first=new Date(year,month,1).getDay(),days=new Date(year,month+1,0).getDate();
    for(let x=0;x<first;x++){const el=document.createElement('div');el.className='day empty';grid.append(el)}
    for(let n=1;n<=days;n++){const date=new Date(year,month,n),el=document.createElement('div'),key=iso(date);el.className='day';el.textContent=n;if(workoutDates.has(key))el.classList.add('workout');else if(safeDates.has(key))el.classList.add('safe-rest');if(key===iso(now))el.classList.add('today');if(date>now)el.classList.add('future');grid.append(el)}
  }
  function update(){ $('restValue').textContent=restDays;document.querySelector('.rest-foot').textContent=`${restDays} streak-safe rest day${restDays===1?'':'s'} allowed between sessions. This sample setting is not saved.`;document.querySelector('.safe-days').innerHTML=`<span>✓</span> ${restDays?`Up to ${restDays} rest days stay within your allowance.`:'No rest days are allowed in this sample setting.'}`; }
  $('prev').addEventListener('click',()=>{month--;if(month<0){month=11;year--}render()});$('next').addEventListener('click',()=>{month++;if(month>11){month=0;year++}render()});
  $('minus').addEventListener('click',()=>{if(restDays>0){restDays--;update()}else toast('Zero rest days is the sample minimum.')});$('plus').addEventListener('click',()=>{if(restDays<7){restDays++;update()}else toast('Seven rest days is the sample maximum.')});
  $('startButton').addEventListener('click',()=>toast('Sample preview only — workouts are not started or saved.'));$('planButton').addEventListener('click',()=>toast('Sample preview only — your plan is not connected.'));
  document.querySelectorAll('[data-demo]').forEach(button=>button.addEventListener('click',()=>toast(`${button.dataset.demo} is not connected in this sample preview.`)));
  const dateLabel=now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase();document.querySelector('.welcome').innerHTML=`${dateLabel} <i>·</i> SAMPLE MEMBER`;
  render();update();
})();
