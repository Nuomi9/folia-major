import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10022/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map(); const logs=[];
ws.on('message', r=>{const m=JSON.parse(r.toString());
  if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}
  if(m.method==='Runtime.consoleAPICalled') logs.push('['+m.params.type+'] '+m.params.args.map(a=>a.value??a.description??'').join(' ').slice(0,300));
  if(m.method==='Runtime.exceptionThrown') logs.push('[exc] '+(m.params.exceptionDetails.exception?.description||'').slice(0,300));
});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
await send('Runtime.enable',{});
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,150));};
console.log('status:', await ev(`(async()=>JSON.stringify(await window.electron.getBilibiliApiStatus()))()`));
// click a small folder to see what happens
console.log('click 瓦:', await ev(`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent.trim()==='瓦'); if(!n) return 'no'; n.click(); return 'ok';})()`));
await new Promise(r=>setTimeout(r,7000));
console.log('BODY:', (await ev(`document.body.innerText`)).slice(0,400).replace(/\n+/g,' | '));
console.log('LOGS:', logs.slice(-8).join(' || ').slice(0,900));
ws.close();
