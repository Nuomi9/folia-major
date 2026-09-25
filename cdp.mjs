// _src/full/cdp.mjs
// CDP 驱动：连 Folia renderer，在页面上下文执行指定 .js 文件里的表达式（awaitPromise）。
// 用法: node cdp.mjs <expr-file>
import fs from 'node:fs';
import WebSocket from 'ws';

const http = (path) => fetch(`http://127.0.0.1:9222${path}`).then(r => r.json());
const pages = await http('/json');
const page = pages.find(p => p.type === 'page' && /folia/i.test(p.title))
    ?? pages.find(p => p.type === 'page');
if (!page) { console.error('NO_PAGE'); process.exit(1); }

const exprFile = process.argv[2];
if (!exprFile) { console.error('usage: node cdp.mjs <expr-file>'); process.exit(1); }
const expression = fs.readFileSync(exprFile, 'utf8');

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
});
const timeout = setTimeout(() => { console.error('TIMEOUT_120s'); process.exit(2); }, 120_000);

ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
    }
});
ws.on('open', async () => {
    try {
        await send('Runtime.enable');
        const res = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            replMode: false,
        });
        clearTimeout(timeout);
        if (res.result?.exceptionDetails) {
            const d = res.result.exceptionDetails;
            console.error('EXCEPTION:', d.exception?.description || d.text);
            process.exit(3);
        }
        const value = res.result?.result?.value;
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('CDP_ERR:', e.message);
        process.exit(4);
    }
});
ws.on('error', (e) => { console.error('WS_ERR:', e.message); process.exit(5); });
