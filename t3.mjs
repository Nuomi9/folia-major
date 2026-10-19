import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:10099/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const p=new Map();
ws.on('message', r=>{const m=JSON.parse(r.toString()); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
const send=(me,pa)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:me,params:pa}));});
await new Promise(r=>ws.on('open',r));
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? ('EXC:'+(r.result?.exceptionDetails?.exception?.description||'').slice(0,200));};
// Ctrl+B 关掉 Lattice，回到资料库墙（Bravais）
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'b',code:'KeyB',windowsVirtualKeyCode:66,modifiers:2});
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'b',code:'KeyB',windowsVirtualKeyCode:66,modifiers:2});
await new Promise(r=>setTimeout(r,3000));
console.log('lattice posters:', await ev(`document.querySelectorAll('.lattice-poster').length`));
console.log('bravais seam:', await ev(`!!document.querySelector('[data-bravais-home-seam]')`));
console.log('bravais tiles:', await ev(`document.querySelectorAll('[data-bravais-item], .bravais-tile').length`));
console.log('any canvas:', await ev(`document.querySelectorAll('canvas').length`));
console.log('body head:', (await ev(`document.body.innerText`)).slice(0,140).replace(/\n+/g,' | '));
ws.close();
