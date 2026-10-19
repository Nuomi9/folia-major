import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10022/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,200));};
const st=async()=>JSON.parse(await ev(`(async()=>JSON.stringify(await window.electron.getBilibiliApiStatus()))()`));
for(let i=0;i<40;i++){const s=await st(); if(!s.cooling){console.log('ready after',i*8,'s');break;} if(i===0)console.log('cooling',s.remainingMs); await new Promise(r=>setTimeout(r,8000));}
console.log('ids raw:', await ev(`window.electron.bilibiliRequest('fav_resource_ids',{mediaId:'3950615899'}).then(v=>'ok '+JSON.stringify(v).slice(0,120)).catch(e=>'ERR:'+(e&&e.message))`));
console.log('ids raw 2:', await ev(`window.electron.bilibiliRequest('fav_resource_ids',{mediaId:'4094092499'}).then(v=>'ok len='+(Array.isArray(v)?v.length:'?')).catch(e=>'ERR:'+(e&&e.message))`));
ws.close();
