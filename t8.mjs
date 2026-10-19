import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10099/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? 'EXC';};
// 打开右下角墙面工具
console.log('open tools:', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||'')==='Lattice 工具'); if(!b) return 'none'; b.click(); return 'clicked';})()`));
await new Promise(r=>setTimeout(r,1200));
console.log('menu items:', await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')||b.title||b.innerText.trim()).filter(Boolean).slice(0,30))`));
ws.close();
