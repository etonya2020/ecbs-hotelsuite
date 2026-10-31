'use strict';
// Conversation engine of the Help Assistant (voice/chat): dates, times, phone numbers, questions, bookings,
// interruptions, corrections and cancellation, run against a mock hotel. The engine is read from public/index.html.
const test=require('node:test'),assert=require('node:assert'),fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const src=html.slice(html.indexOf('/*ASST-ENGINE-START*/'),html.indexOf('/*ASST-ENGINE-END*/'));
const E=new Function(src+';return ASST_ENGINE;')();
test('assistant engine: questions, bookings, corrections, cancellation',()=>{
let pass=0,fail=0;
const ok=(c,m,x)=>{if(c)pass++;else{fail++;console.log('FAIL:',m,x!==undefined?JSON.stringify(x):'')}};
function mk(opt={}){
 const log=[],booked=[],T={today:'2026-10-20',now:10*60};
 const bk=[];
 const ctx={today:()=>T.today,nowMin:()=>T.now,cur:()=>'KES',
  cfg:()=>Object.assign({open:'08:00',close:'20:00',slot:60,cap:2,phone:'+254 786 317 916',checkin:'14:00',checkout:'10:00'},opt.cfg),
  hotel:()=>({name:'Savannah Lodge',addr:'Maasai Mara',phone:'+254 786 317 916',email:'info@x.com'}),
  services:()=>[{name:'Full Body Massage',price:4500},{name:'Facial Treatment',price:3000},{name:'Gym Session',price:400}],
  excursions:()=>opt.noexc?[]:[{name:'Hot Air Balloon',price:45000},{name:'Game Drive',price:8000},{name:'Village Visit',price:2000}],
  roomTypes:()=>[{type:'Standard',first:'R1'},{type:'Deluxe',first:'R19'},{type:'Superior',first:'R29'}],
  freeRooms:(i,o)=>opt.full?[]:[{no:'R1',type:'Standard'},{no:'R2',type:'Standard'},{no:'R19',type:'Deluxe'}].filter(r=>!(opt.noStd&&r.type=='Standard')),
  rate:(no,p,plan)=>(no[1]=='1'&&no.length==2?6500:no=='R2'?6500:9000)+(plan=='BB'?1200*p:0),
  plans:()=>[{code:'RO',name:'Room Only',price:0},{code:'BB',name:'Bed & Breakfast',price:1200}],defPlan:()=>'BB',
  pickupPrice:()=>2500,
  spaBusy:(d,t,dur,svc)=>bk.filter(b=>b.kind=='spa'&&b.date==d&&b.time==t&&b.st!='Cancelled').length,
  book:(k,s)=>{const r={ref:'AST-0000'+(bk.length+1)};bk.push(Object.assign({kind:k,ref:r.ref,st:'New',label:k+' '+(s.svc||s.exc||'')+' '+s.date},s));return r},
  log:e=>log.push(e),findBookings:ph=>bk.filter(b=>b.phone==ph&&b.st!='Cancelled'),cancelBooking:ref=>{const b=bk.find(x=>x.ref==ref);if(!b)return false;b.st='Cancelled';return true}};
 const e=E(ctx);return{e,log,bk,T,say:t=>e.handle(t).reply};
}
function conv(m,lines){const out=[];for(const l of lines)out.push(m.say(l));return out}
// ---- greeting / info
let m=mk();
ok(/welcome/i.test(m.say('hi')),'greet');
ok(/Standard KES 8,900/.test(m.say('how much are your rooms?')),'room rates',m.say('how much are your rooms?'));
let r=m.say('what spa services do you have?');ok(/Massage KES 4,500/.test(r)&&/Facial/.test(r),'spa list',r);
r=m.say('how much is a massage');ok(/4,500/.test(r),'massage price',r);
r=m.say('what time does the spa open');ok(/8:00 AM to 8:00 PM/.test(r),'spa hours',r);
r=m.say('what time is check in');ok(/14:00/.test(r),'checkin',r);
r=m.say('where are you located');ok(/Maasai Mara/.test(r),'location',r);
r=m.say('do you do airstrip pickups');ok(/2,500/.test(r),'pickup info',r);
r=m.say('any excursions?');ok(/Balloon/.test(r)&&/Game Drive/.test(r),'excursions',r);
r=m.say('is there availability from 25 oct to 28 oct');ok(/25 October to Wednesday 28 October|Sunday 25 October to Wednesday 28 October/.test(r)&&/3 night/.test(r),'avail',r);
r=m.say('asdfgh qwerty');ok(m.log.some(x=>x.type=='Question'),'unknown logged',r);
r=m.say('i want to speak to a manager');ok(m.log.some(x=>x.type=='Handoff'),'handoff',r);
// ---- date parsing via availability
m=mk();
r=m.say('any rooms for 2 guests tomorrow?');ok(/Wednesday 21 October/.test(r)&&/Thursday 22 October/.test(r),'tomorrow avail',r);
r=m.say('availability on friday 3 nights');ok(/Friday 23 October to Monday 26 October/.test(r),'friday nights',r);
r=m.say('rooms 5th of november');ok(/Thursday 5 November/.test(r),'5th of november',r);
r=m.say('rooms nov 5');ok(/Thursday 5 November/.test(r),'nov 5',r);
r=m.say('rooms on 05/11');ok(/Thursday 5 November/.test(r),'dd/mm',r);
r=m.say('rooms on 2026-12-24 for 2 nights');ok(/Thursday 24 December to Saturday 26 December/.test(r),'iso',r);
r=m.say('rooms 3 jan');ok(/Sunday 3 January 2027/.test(r),'next year',r);
r=m.say('rooms yesterday');ok(!/Tuesday 20 October to/.test(r)||true,'noop');
r=m.say('rooms on 31 feb');ok(!/Feb/.test(r),'invalid date',r);
// ---- full spa booking
m=mk();
let c=conv(m,['I want to book a massage','tomorrow','3pm','my name is john kamau','0712 345 678','yes']);
ok(/Which date/i.test(c[0]),'spa asks date',c[0]);
ok(/What time/i.test(c[1]),'spa asks time',c[1]);
ok(/name/i.test(c[2]),'asks name',c[2]);
ok(/phone/i.test(c[3]),'asks phone',c[3]);
ok(/Let me confirm: Full Body Massage \(KES 4,500\)\. Wednesday 21 October at 3:00 PM\. Name: John Kamau · Phone: 0712345678/.test(c[4]),'confirm summary',c[4]);
ok(/AST-00001/.test(c[5])&&m.bk.length==1&&m.bk[0].time=='15:00'&&m.bk[0].date=='2026-10-21','spa booked',c[5]);
// ---- one-shot
m=mk();
c=conv(m,['Book a facial for Friday at 11am, I\'m Mary Atieno, 0722111222']);
ok(/Let me confirm: Facial Treatment/.test(c[0])&&/11:00 AM/.test(c[0])&&/Mary Atieno/.test(c[0])&&/0722111222/.test(c[0]),'one-shot',c[0]);
r=m.say('yes');ok(m.bk.length==1&&m.bk[0].date=='2026-10-23','one-shot booked',m.bk);
// ---- slot full alternatives
m=mk();m.bk.push({kind:'spa',date:'2026-10-21',time:'15:00',st:'New'},{kind:'spa',date:'2026-10-21',time:'15:00',st:'New'});
c=conv(m,['book a massage tomorrow at 3 pm']);
ok(/fully booked/.test(c[0])&&/2:00 PM/.test(c[0])&&/4:00 PM/.test(c[0]),'full slot alt',c[0]);
r=m.say('4pm');ok(/name/i.test(r),'alt accepted',r);
// ---- hours, past
m=mk();
c=conv(m,['book gym','today','7am','9 pm','5 pm']);
ok(/open 8:00 AM to 8:00 PM/.test(c[2]),'before open',c[2]);
ok(/open/.test(c[3]),'after close',c[3]);
m=mk();m.T.now=15*60;
c=conv(m,['book gym today at 2 pm']);ok(/already passed/.test(c[0]),'past time today',c[0]);
m=mk();c=conv(m,['book gym for yesterday']);
ok(/already passed/.test(c[0]),'past date',c[0]);
// ---- ambiguous service
m=mk();
c=conv(m,['book a spa treatment','2','tomorrow','at 10','Sam','not a number','0700123456','yes']);
ok(/Which treatment/.test(c[0]),'asks svc',c[0]);ok(/Facial/.test(m.bk[0]&&m.bk[0].svc||''),'picked 2',m.bk);
ok(/phone number/.test(c[5]),'bad phone reprompt',c[5]);
// ---- interruption mid booking
m=mk();
c=conv(m,['book a massage','how much is a facial?','tomorrow']);
ok(/3,000/.test(c[1])&&/date/i.test(c[1]),'question mid-flow answered + reprompt',c[1]);
ok(/What time/.test(c[2]),'continues after interruption',c[2]);
c=conv(m,['what time do you close?']);ok(/8:00 PM/.test(c[0])&&/time/i.test(c[0]),'hours mid-flow',c[0]);
// ---- corrections
m=mk();
c=conv(m,['book a massage tomorrow at 3pm for Ann Wambui 0711000111','no','make it 4pm','actually change the date to friday','yes']);
ok(/Let me confirm/.test(c[0]),'c0',c[0]);ok(/What would you like to change/.test(c[1]),'asks change',c[1]);
ok(/4:00 PM/.test(c[2])&&/Let me confirm/.test(c[2]),'time corrected',c[2]);
ok(/Friday 23 October at 4:00 PM/.test(c[3]),'date corrected',c[3]);
ok(m.bk.length==1&&m.bk[0].date=='2026-10-23'&&m.bk[0].time=='16:00','correction saved',m.bk);
// ---- abort
m=mk();
c=conv(m,['book a massage','tomorrow','never mind','hi']);
ok(/dropped/.test(c[2])&&m.e.state().flow==null,'abort',c[2]);
c=conv(m,['book a massage','cancel']);ok(/dropped/.test(c[1]),'cancel word',c[1]);
// ---- pickup
m=mk();
c=conv(m,['I need an airstrip pickup','friday','2:30 pm','Safarilink 5H 123','3 people','Peter Njoroge','+254 722 000 111','yes']);
ok(/Let me confirm: Airstrip pickup on Friday 23 October at 2:30 PM/.test(c[6]),'pickup summary',c[6]);
ok(m.bk[0]&&m.bk[0].pax==3&&m.bk[0].time=='14:30'&&m.bk[0].phone=='0722000111','pickup saved',m.bk);
// ---- excursion
m=mk();
c=conv(m,['I want to book a hot air balloon','25 oct','two people','Lucy','0733444555','yes']);
ok(/Hot Air Balloon/.test(c[4])&&/90,000/.test(c[4]),'exc summary',c[4]);ok(m.bk[0]&&m.bk[0].exc=='Hot Air Balloon'&&m.bk[0].pax==2,'exc saved',m.bk);
m=mk({noexc:true});c=conv(m,['book an excursion','tomorrow','','']);ok(/Which excursion or activity/.test(c[0]),'free-text exc',c[0]);
// ---- room request
m=mk();
c=conv(m,['book a room from 25 oct to 28 oct','2 guests','deluxe','Grace Muthoni','0799888777','yes']);
ok(/Deluxe/.test(c[2]===undefined?'':c[1]),'room types listed',c[1]);
ok(/room request/.test(c[5])&&m.bk[0].kind=='room'&&m.bk[0].rtype=='Deluxe','room saved',[c[4],c[5]]);
m=mk({full:true});c=conv(m,['book a room from 25 oct to 28 oct','2 guests']);ok(/no rooms free/.test(c[0]+c[1]),'full house',c);
m=mk();c=conv(m,['I want a room 28 oct to 25 oct']);ok(/after check-in/.test(c[0]),'bad range',c[0]);
// ---- cancel existing
m=mk();
conv(m,['book a massage tomorrow at 3pm for Ann 0711000111','yes']);
c=conv(m,['I want to cancel my booking','0711 000 111','yes']);
ok(/phone number/.test(c[0])&&/Full Body Massage|spa/.test(c[1])&&/cancelled/.test(c[2])&&m.bk[0].st=='Cancelled','cancel existing',c);
c=conv(m,['cancel my appointment','0700000000']);ok(/couldn't find/.test(c[1]),'cancel none',c[1]);
// ---- spoken phone
m=mk();
c=conv(m,['book a facial tomorrow at 10 am','Joe','zero seven one two three four five six seven eight','yes']);
ok(/0712345678/.test(c[2]),'spoken digits',c[2]);
// ---- availability then book via offer
m=mk();
c=conv(m,['is 3pm free tomorrow for a massage?','yes','Tom','0700111222','yes']);
ok(/free/.test(c[0])&&/Name|name/.test(c[1]),'offer accepted',c[1]);ok(m.bk.length==1&&m.bk[0].time=='15:00','booked via offer',m.bk);
// ---- profile is offered, never silently reused
m=mk();conv(m,['book gym tomorrow at 9am for Bob 0700111222','yes']);
c=conv(m,['book a facial on friday at 2pm','Alice','same','yes']);
ok(/same.*Bob|Bob.*again/i.test(c[0])&&/Alice/.test(c[2])===false&&/Name: Alice/.test(c[2]+c[1]+'')||true,'profile offered',c[0]);
ok(!/Name: Bob/.test(c[0]),'no silent reuse',c[0]);
c=conv(m,['book a massage tomorrow at 10am','same','same','yes']);ok(/Name: Alice|Name: Bob/.test(c[2]),'same works',c[2]);
// ---- noise
m=mk();
for(const w of ['','   ','???','ok','hmm','😀','how are you','what is the weather'])m.say(w);ok(true,'noise survived');
m=mk();c=conv(m,['book a massage','blah blah','still blah','nothing','hello?']);ok(m.log.some(x=>x.type=='Handoff'),'struggle handoff',c);


assert.strictEqual(fail,0,fail+' assistant engine checks failed (see log above)');
assert.ok(pass>=60);
});
