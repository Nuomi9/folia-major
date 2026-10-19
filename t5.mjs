import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10099/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,200));};
// 用左上角返回按钮关掉 Lattice
console.log('back btn:', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(n=>/返回上一页/.test(n.getAttribute('aria-label')||'')); if(!b) return 'none'; b.click(); return 'clicked';})()`));
await new Promise(r=>setTimeout(r,3000));
console.log('still lattice:', await ev(`document.querySelectorAll('.lattice-poster').length`));
console.log('bravais seam now:', await ev(`!!document.querySelector('[data-bravais-home-seam]')`));
console.log('body:', (await ev(`document.body.innerText`)).slice(0,140).replace(/\n+/g,' | '));
ws.close();
