import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10099/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map(); const logs=[];
ws.on('message', r=>{const m=JSON.parse(r.toString());
  if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}
  if(m.method==='Runtime.consoleAPICalled') logs.push('['+m.params.type+'] '+m.params.args.map(a=>a.value??a.description??'').join(' ').slice(0,400));
});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
await send('Runtime.enable',{});
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,300));};
console.log('login_status:', await ev(`(async()=>{try{const d=await window.electron.bilibiliRequest('login_status',{}); return JSON.stringify(d).slice(0,200);}catch(e){return 'ERR:'+e.message}})()`));
console.log('api status:', await ev(`(async()=>JSON.stringify(await window.electron.getBilibiliApiStatus()))()`));
ws.close();
