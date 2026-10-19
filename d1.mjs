import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10022/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,180));};
console.log('cards:', await ev(`document.querySelectorAll('[data-bravais-action="toggle-hidden"]').length`));
// inspect the DOM around one playlist tile: what kind label does it show
console.log('kind labels:', await ev(`JSON.stringify([...new Set([...document.querySelectorAll('[class*=kind],[data-bravais-kind]')].map(n=>n.textContent.trim()).filter(Boolean))].slice(0,12))`));
console.log('body:', (await ev(`document.body.innerText`)).slice(0,200).replace(/\n+/g,' | '));
ws.close();
