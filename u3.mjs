import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10099/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,300));};
// 用一个不存在的 avid=1 去删，看是本地就抛「not logged in」还是真打到 API
console.log('probe fav_deal:', await ev(`window.electron.bilibiliRequest('fav_deal',{avid:'1',delMediaIds:'4023618399'}).then(v=>'OK '+JSON.stringify(v).slice(0,120)).catch(e=>'ERR:'+(e&&e.message))`));
ws.close();
