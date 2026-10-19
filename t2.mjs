import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10099/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,200));};
// 当前界面是什么：Lattice 队列墙
console.log('=== 现在这一屏 ===');
console.log('lattice posters:', await ev(`document.querySelectorAll('.lattice-poster').length`));
console.log('expanded:', await ev(`document.querySelectorAll('.lattice-poster.is-expanded').length`));
console.log('lyric canvas inside poster:', await ev(`document.querySelectorAll('.lattice-poster canvas').length`));
// 切歌看是否跟随
console.log('before:', await ev(`(()=>{const e=document.querySelector('.lattice-poster.is-expanded'), c=document.querySelector('.lattice-poster.is-current'); return JSON.stringify({exp:e?.getAttribute('aria-label')?.slice(0,20), cur:c?.getAttribute('aria-label')?.slice(0,20), same:e===c});})()`));
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(n=>/下一首/.test(n.getAttribute('aria-label')||n.title||'')); b&&b.click(); return !!b;})()`);
await new Promise(r=>setTimeout(r,6000));
console.log('after :', await ev(`(()=>{const e=document.querySelector('.lattice-poster.is-expanded'), c=document.querySelector('.lattice-poster.is-current'); return JSON.stringify({exp:e?.getAttribute('aria-label')?.slice(0,20), cur:c?.getAttribute('aria-label')?.slice(0,20), same:e===c});})()`));
ws.close();
