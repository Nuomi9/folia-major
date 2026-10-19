import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10022/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,150));};
console.log('status before:', await ev(`(async()=>JSON.stringify(await window.electron.getBilibiliApiStatus()))()`));
console.log('infos:', await ev(`(async()=>{
  const ids = await window.electron.bilibiliRequest('fav_resource_ids',{mediaId:'3950615899'});
  const res = ids.map(e=>e.id+':'+e.type).join(',');
  try {
    const v = await window.electron.bilibiliRequest('fav_resource_infos',{resources:res});
    return 'OK len='+(Array.isArray(v)?v.length:'?')+' first='+JSON.stringify((v&&v[0])||{}).slice(0,200);
  } catch(e) { return 'ERR:'+(e&&e.message); }
})()`));
console.log('status after:', await ev(`(async()=>JSON.stringify(await window.electron.getBilibiliApiStatus()))()`));
ws.close();
