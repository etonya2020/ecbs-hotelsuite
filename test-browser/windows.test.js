// Real-browser test of the multiple-windows feature against the live server edition.
// Needs Google Chrome / Chromium and puppeteer-core:  CHROME=/path/to/chrome PUPPETEER=/path/to/puppeteer-core node test-browser/windows.test.js
const puppeteer=require(process.env.PUPPETEER||'puppeteer-core');
const {spawn}=require('child_process'),fs=require('fs');
const PORT=4977,BASE='http://127.0.0.1:'+PORT,sleep=ms=>new Promise(r=>setTimeout(r,ms));let fails=0;const ok=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c||x===undefined?'':'  -> '+JSON.stringify(x)));if(!c)fails++};
(async()=>{
 fs.rmSync(require('os').tmpdir()+'/ecbs-win-test',{recursive:true,force:true});fs.mkdirSync(''+require('os').tmpdir()+'/ecbs-win-test');
 const srv=spawn(process.execPath,['src/server.js'],{cwd:require('path').join(__dirname,'..'),env:{...process.env,DATABASE_URL:'sqlite:'+require('os').tmpdir()+'/ecbs-win-test/e.db',COOKIE_SECURE:'false',PORT:String(PORT),HOST:'127.0.0.1',SCRYPT_N:'1024',ADMIN_PASSWORD:'Adm1n!Start-2026',DATA_KEY:'k',BILLING_TIMER:'off',LOGIN_RATE_MAX:'1000',TZ:'UTC'},stdio:'ignore'});
 try{
 for(let i=0;i<50;i++){try{if((await fetch(BASE+'/healthz')).ok)break}catch(e){}await sleep(100)}
 let r=await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'Adm1n!Start-2026'})});const cookie=r.headers.get('set-cookie').split(';')[0],csrf=(await r.json()).csrf;
 await fetch(BASE+'/api/change-password',{method:'POST',headers:{'Content-Type':'application/json',cookie,'X-CSRF-Token':csrf},body:JSON.stringify({old:'Adm1n!Start-2026',new:'Better#Pass-9981'})});
 const api=async(m,u,b)=>{let x=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',cookie,'X-CSRF-Token':csrf},body:b?JSON.stringify(b):undefined});return x.json()};
 const b=await puppeteer.launch({executablePath:process.env.CHROME,args:['--no-sandbox','--disable-gpu'],headless:true});
 const p=await b.newPage();const errs=[],reqs=[];p.on('pageerror',e=>errs.push(e.message.slice(0,160)));p.on('console',m=>{if(m.type()=='error'&&!/ERR_NAME_NOT_RESOLVED|ERR_INTERNET|ERR_CONNECTION/.test(m.text()))errs.push('console: '+m.text().slice(0,200))});p.on('request',q=>{if(q.url().includes('/api/'))reqs.push(q.method()+' '+q.url().replace(BASE,''))});
 await p.setViewport({width:1360,height:860});await p.setCookie({name:'ecbs_sid',value:decodeURIComponent(cookie.split('=')[1]),url:BASE});
 const resp=await p.goto(BASE+'/');ok('the page is served with its security policy',/frame-ancestors 'none'/.test(resp.headers()['content-security-policy']||''));
 await sleep(6500);
 ok('signed in through the real start-up (server data loaded, dashboard shown)',await p.evaluate(()=>SRV.on&&SRV.me&&SRV.me.name=='admin'&&document.getElementById('lg').className!='show'&&cur=='dash'),await p.evaluate(()=>[SRV.on,cur,document.getElementById('lg').className]));
 const base=reqs.filter(x=>/\/api\/(state|me)/.test(x)).length;const kids=()=>p.frames().filter(f=>f!==p.mainFrame()),wins=()=>p.evaluate(()=>WINS.length);
 await p.evaluate(()=>{let m=[...document.querySelectorAll('.mi')].find(m=>m.firstChild.textContent.trim()=='Expenses & Accounts');[...m.querySelectorAll('.dd a')].find(a=>a.textContent.trim()=='Expenses (Simple)').click()});await sleep(2000);
 await p.evaluate(()=>document.querySelector('.ti[data-v="pos"]').click());await sleep(1800);
 await p.evaluate(()=>openScreen('purchases'));await sleep(1800);
 ok('three windows open on the server edition',(await wins())==3&&kids().length==3);
 ok('child windows did NOT reload the data from the server (one shared copy and one sync engine)',reqs.filter(x=>/\/api\/(state|me)/.test(x)).length==base,reqs.filter(x=>/\/api\/(state|me)/.test(x)));
 const views=await Promise.all(kids().map(f=>f.evaluate(()=>WIN.view))),F=v=>kids()[views.indexOf(v)],FV=async v=>{for(const f of kids()){try{if(await f.evaluate(()=>WIN.view)==v)return f}catch(e){}}};
 ok('windows share the signed-in session, data and sync engine',await F('pos').evaluate(()=>D===parent.ECBS.D()&&SRV===parent.ECBS.SRV()&&SRV.on&&USR.name===parent.ECBS.USR().name));
 // save in one window -> synced to the database through the parent
 const v1=await F('expsimple').evaluate(()=>expPost({acct:'5150',amt:2320,vat:320,m:'Cash',bank:'Main Cash',date:today(),desc:'Fuel – server window test'}).rec.vno);
 const v2=await F('purchases').evaluate(()=>nextNo('EXP'));const v3=await F('pos').evaluate(()=>nextNo('EXP'));
 ok('document numbers from two windows never repeat (server sequence)',new Set([v1,v2,v3]).size==3&&[v1,v2,v3].every(x=>/^EXP-\d{5}$/.test(x)),[v1,v2,v3]);
 await sleep(1800);const st=await api('GET','/api/state');
 ok('expense saved in a window reached the database',(st.collections.expenses?.records||[]).some(x=>x.data.vno==v1&&x.data.desc.includes('server window test')));
 ok('sync engine is idle again (nothing pending)',await p.evaluate(()=>!SRV.dirty&&!SRV.busy));
 // change made by another computer arrives and the background list window shows it
 await p.evaluate(()=>openScreen('viewexp'));await sleep(1800);
 await api('POST','/api/sync',{ops:[{c:'expenses',id:'zz1',ver:null,data:{id:'zz1',_id:'zz1',vno:'EXP-REMOTE',date:new Date().toISOString().slice(0,10),entered:new Date().toISOString().slice(0,10),acct:'5120',desc:'Entered on another computer',amt:100,vat:0,m:'Cash',bank:'Main Cash',by:'other',posted:true}}]});
 await p.evaluate(()=>srvPull());await sleep(1800);
 ok('a change made on another computer shows in an open list window',await (await FV('viewexp')).evaluate(()=>document.querySelector('#wk').innerText.includes('EXP-REMOTE')));
 // several windows saving at once
 const outs=await Promise.all(kids().map(f=>f.evaluate(()=>{let o=[];for(let i=0;i<3;i++)o.push(nextNo('JNL'));D.budgets.push({id:'w'+WIN.id+Math.random(),year:2026,month:0,acct:'5150',amt:1,dept:''});save();return o})));
 await sleep(2200);const all=outs.flat();ok('numbers drawn by four windows at once are all different',new Set(all).size==all.length,all);
 const st2=await api('GET','/api/state');ok('records saved from four windows at once all reached the database',(st2.collections.budgets?.records||[]).length==kids().length);
 ok('window controls work in the server edition too',await p.evaluate(()=>{winCmd('w_tile');winCmd('w_min');let m=WINS.every(w=>w.min);winCmd('w_cascade');return m}));
 await p.evaluate(()=>winCmd('w_closeall'));ok('close all',(await wins())==0);
 ok('no script or security-policy errors',errs.length==0,errs);
 await b.close();
 }finally{srv.kill()}
 console.log(fails?'\n'+fails+' FAILED':'\nALL SERVER WINDOW TESTS PASSED');process.exit(fails?1:0);
})().catch(e=>{console.log('TEST ERROR',e.message);process.exit(2)});
