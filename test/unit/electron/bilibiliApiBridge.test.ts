import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bilibiliApiBridge.test.ts
//
// Bilibili 的 WAF 会对突发请求返回 HTTP 412（以及 200 body 里的 code:-412），一旦触发就把整个
// IP+会话拒掉一段时间。这些用例锁住两件事：桥在被拒时必须立刻停手（熔断 + 不重试），以及设备指纹
// buvid3/buvid4 必须在第一个业务请求之前就被引导出来。net.fetch 的 cookie 归属也在下面锁了一条。

const require = createRequire(import.meta.url);
const { createBilibiliApiBridge } = require('../../../electron/bilibiliApiBridge.cjs');

const SESSION_KEY = 'BILIBILI_SESSION_V1';
const RISK_CONTROL_KEY = 'BILIBILI_RISK_CONTROL_V1';
const FINGER = '/x/frontend/finger/spi';
const NAV = '/x/web-interface/nav';

const createStore = () => {
    const values = new Map<string, any>();
    return {
        values,
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
        delete: (key: string) => values.delete(key),
    };
};

// 可逆变换即可：单测不需要真实钥匙串，只要 store 看到的是密文、桥看到的是明文。
const createSafeStorage = () => ({
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plaintext: string): Buffer =>
        Buffer.from(Buffer.from(plaintext, 'utf8').map(byte => byte ^ 0xa5))),
    decryptString: vi.fn((ciphertext: Buffer) =>
        Buffer.from(Buffer.from(ciphertext).map(byte => byte ^ 0xa5)).toString('utf8')),
});

const readEnvelope = (store: ReturnType<typeof createStore>, safeStorage: ReturnType<typeof createSafeStorage>) => {
    const stored = store.get(SESSION_KEY);
    if (!stored) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(stored.data, 'base64')));
};

type Plan =
    | { status?: number; json?: unknown; contentType?: string; setCookie?: string; getSetCookie?: boolean; body?: unknown }
    | Error;

const jsonResponse = (json: unknown) => ({ status: 200, json, contentType: 'application/json' });
const fingerPlan = (b3 = 'BUVID3', b4 = 'BUVID4') => jsonResponse({ code: 0, data: { b_3: b3, b_4: b4 } });
const navPlan = (over: Record<string, unknown> = {}) =>
    jsonResponse({ code: 0, data: { isLogin: false, ...over } });

/**
 * 造一个桥 + 出站请求记录器。`plan` 可以是数组（按次序应答，越界重复最后一个）
 * 或函数（按请求自行决定），抛错项用来模拟瞬时网络故障。
 */
const createHarness = (
    plan: Plan[] | ((call: { url: string; path: string; headers: Record<string, string> }, index: number) => Plan),
    options: { store?: ReturnType<typeof createStore>; safeStorage?: ReturnType<typeof createSafeStorage> } = {},
) => {
    const store = options.store ?? createStore();
    const safeStorage = options.safeStorage ?? createSafeStorage();
    const calls: { url: string; path: string; headers: Record<string, string>; credentials?: string }[] = [];
    let index = 0;

    const netFetch = vi.fn(async (url: string | URL, init: any = {}) => {
        const parsed = new URL(String(url));
        const call = { url: String(url), path: parsed.pathname, headers: init.headers ?? {}, credentials: init.credentials };
        calls.push(call);
        const step = typeof plan === 'function' ? plan(call, index) : plan[Math.min(index, plan.length - 1)];
        index += 1;
        if (step instanceof Error) throw step;
        const headers: Record<string, string> = { 'content-type': step.contentType ?? 'application/json' };
        if (step.setCookie) headers['set-cookie'] = step.setCookie;
        const response: any = {
            status: step.status ?? 200,
            headers: {
                get: (name: string) => headers[String(name).toLowerCase()] ?? null,
                ...(step.getSetCookie === false ? {} : {
                    getSetCookie: () => (headers['set-cookie'] ? [headers['set-cookie']] : []),
                }),
            },
            json: async () => {
                if (step.json === undefined) throw new Error('body is not json');
                return step.json;
            },
            body: step.body ?? { cancel: vi.fn(async () => {}) },
        };
        return response;
    });

    const bridge = createBilibiliApiBridge({ store, safeStorage, netFetch, warn: vi.fn() });
    const paths = () => calls.map(call => call.path);
    return { bridge, store, safeStorage, calls, netFetch, paths };
};

describe('Bilibili API bridge device-fingerprint bootstrap', () => {
    it('calls finger before the first API request and reuses its buvid', async () => {
        const { bridge, calls, paths } = createHarness([fingerPlan(), navPlan()]);

        await bridge.request('login_status');

        expect(paths().slice(0, 2)).toEqual([FINGER, NAV]);
        // finger 自己还不能带 cookie；拿到 buvid 后立刻用于后续请求。
        expect(calls[0].headers.Cookie).toBeUndefined();
        expect(calls[1].headers.Cookie).toContain('buvid3=BUVID3');
        expect(calls[1].headers.Cookie).toContain('buvid4=BUVID4');
    });

    it('does not bootstrap in front of passport calls that mint the session', async () => {
        const { bridge, paths } = createHarness([jsonResponse({ code: 0, data: { url: 'https://x', qrcode_key: 'k' } })]);

        await bridge.request('qr_generate');

        expect(paths()).toEqual(['/x/passport-login/web/qrcode/generate']);
    });

    it('probes finger once per backoff window when the endpoint keeps failing', async () => {
        // 回归点：失败的 spi 曾经被每个业务请求各触发一次。一次 bootstrap 仍是 2 次出站
        // （内部对瞬时错误重试一次），关键是它不再随业务请求数量线性增长。
        const { bridge, paths } = createHarness(() => new Error('ETIMEDOUT'));

        await expect(bridge.request('login_status')).rejects.toThrow();
        await expect(bridge.request('login_status')).rejects.toThrow();
        await expect(bridge.request('login_status')).rejects.toThrow();

        // 修复前是 3 x 2 = 6 次。
        expect(paths().filter(path => path === FINGER)).toHaveLength(2);
    });

    it('lets logout re-arm the fingerprint bootstrap for the next sign-in', async () => {
        const { bridge, paths } = createHarness([
            fingerPlan(),
            navPlan({ isLogin: true, mid: 42, uname: 'u' }),
            jsonResponse({ code: 0 }),
            fingerPlan('BUVID3-NEW'),
            navPlan(),
        ]);

        await bridge.request('login_status');
        await bridge.request('logout');
        await bridge.request('login_status');

        expect(paths().filter(path => path === FINGER)).toHaveLength(2);
    });
});

describe('Bilibili API bridge risk control', () => {
    const blockers: [string, Record<string, unknown>][] = [
        ['HTTP 412', { status: 412, contentType: 'text/html' }],
        ['HTTP 429', { status: 429, json: { code: -1 } }],
        ['HTTP 503', { status: 503, json: { code: -1 } }],
        ['code -412 inside a 200', { status: 200, json: { code: -412, message: 'blocked' } }],
        // 滑块验证以 200 + HTML 下发，曾经被当成普通失败重试一次。
        ['a 200 HTML challenge page', { status: 200, contentType: 'text/html', json: undefined }],
    ];

    it.each(blockers)('%s trips the breaker and stops further requests', async (_label, plan) => {
        const { bridge, paths } = createHarness([fingerPlan(), plan as Plan]);

        await expect(bridge.request('login_status')).rejects.toMatchObject({ isRiskControl: true });
        const outbound = paths().length;

        await expect(bridge.request('login_status')).rejects.toMatchObject({ isRiskControl: true });

        // 冷却期内一条请求都不该再发出去。
        expect(paths()).toHaveLength(outbound);
    });

    it('does not let a 429 read as "logged out"', async () => {
        // 回归点：429 曾带着 code:-1 原样返回，login_status 把它读成未登录，用户看到的是莫名掉号。
        const { bridge } = createHarness([fingerPlan(), { status: 429, json: { code: -1 } }]);

        await expect(bridge.request('login_status')).rejects.toThrow(/风控/);
    });

    it('never retries a blocked call but does retry a transient failure', async () => {
        const transient = createHarness([fingerPlan(), new Error('ECONNRESET'), navPlan()]);
        await expect(transient.bridge.request('login_status')).resolves.toEqual({ authenticated: false });
        expect(transient.paths().filter(path => path === NAV)).toHaveLength(2);

        const blocked = createHarness([fingerPlan(), { status: 412, contentType: 'text/html' }]);
        await expect(blocked.bridge.request('login_status')).rejects.toThrow();
        expect(blocked.paths().filter(path => path === NAV)).toHaveLength(1);
    });

    it('cancels the response body on the paths that throw before reading it', async () => {
        const body = { cancel: vi.fn(async () => {}) };
        const { bridge } = createHarness([fingerPlan(), { status: 412, contentType: 'text/html', body }]);

        await expect(bridge.request('login_status')).rejects.toThrow();

        // net.fetch 会一直占住 Chromium 的底层请求直到 body 被消费或取消。
        expect(body.cancel).toHaveBeenCalled();
    });

    it('survives a restart: a fresh bridge honours the persisted cooldown', async () => {
        const store = createStore();
        const safeStorage = createSafeStorage();
        const first = createHarness([fingerPlan(), { status: 412, contentType: 'text/html' }], { store, safeStorage });
        await expect(first.bridge.request('login_status')).rejects.toThrow();
        expect(store.get(RISK_CONTROL_KEY)).toMatchObject({ until: expect.any(Number) });

        // 用户看到"冷却中"最自然的动作就是重启，而重启不能变成再次冲撞封禁的逃生口。
        const second = createHarness([fingerPlan(), navPlan()], { store, safeStorage });
        await expect(second.bridge.request('login_status')).rejects.toMatchObject({ isRiskControl: true });
        expect(second.calls).toHaveLength(0);
    });

    it('clears the persisted cooldown once the window has elapsed', async () => {
        const store = createStore();
        store.set(RISK_CONTROL_KEY, { until: Date.now() - 1000 });
        const { bridge } = createHarness([fingerPlan(), navPlan()], { store });

        await expect(bridge.request('login_status')).resolves.toEqual({ authenticated: false });

        expect(store.get(RISK_CONTROL_KEY)).toBeUndefined();
    });

    it('keeps buvid across restarts so finger is not re-probed on every launch', async () => {
        const store = createStore();
        const safeStorage = createSafeStorage();
        const first = createHarness([fingerPlan('BUVID3-KEEP', 'BUVID4-KEEP'), navPlan()], { store, safeStorage });
        await first.bridge.request('login_status');
        expect(readEnvelope(store, safeStorage).cookies).toMatchObject({ buvid3: 'BUVID3-KEEP', buvid4: 'BUVID4-KEEP' });

        const second = createHarness([navPlan()], { store, safeStorage });
        await second.bridge.request('login_status');

        expect(second.paths()).toEqual([NAV]);
        expect(second.calls[0].headers.Cookie).toContain('buvid3=BUVID3-KEEP');
    });
});

describe('Bilibili API bridge cookie ownership', () => {
    it('asks the transport to keep the session cookie jar out of the request', async () => {
        const { bridge, calls } = createHarness([fingerPlan(), navPlan()]);

        await bridge.request('login_status');

        expect(calls).toHaveLength(2);
        expect(calls[0].credentials).toBe('omit');
        expect(calls[1].credentials).toBe('omit');
    });

    it('parses Set-Cookie without getSetCookie(), keeping Expires commas intact', async () => {
        const store = createStore();
        const safeStorage = createSafeStorage();
        const combined = 'SESSDATA=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, bili_jct=def; Path=/';
        const { bridge } = createHarness([
            fingerPlan(),
            {
                status: 200,
                contentType: 'application/json',
                getSetCookie: false,
                setCookie: combined,
                json: { code: 0, data: { isLogin: true, mid: 7, uname: 'u' } },
            },
        ], { store, safeStorage });

        await bridge.request('login_status');

        expect(readEnvelope(store, safeStorage).cookies).toMatchObject({
            buvid3: 'BUVID3',
            SESSDATA: 'abc',
            bili_jct: 'def',
        });
    });
});

describe('Bilibili API bridge 合集 seasons', () => {
    const SEASON_PATH = '/x/polymer/web-space/seasons_archives_list';

    it('lists a season through the space endpoint using the season owner mid', async () => {
        const { bridge, calls } = createHarness([
            fingerPlan(),
            jsonResponse({ code: 0, data: { archives: [{ aid: 1, title: 'a' }], page: { total: 83 } } }),
        ]);

        const data = await bridge.request('season_archives', {
            seasonId: '1797750', mid: '3546378898770447', pn: 2, ps: 50,
        });

        const url = new URL(calls[1].url);
        expect(calls[1].path).toBe(SEASON_PATH);
        // 合集作者是别人：mid 必须由调用方给，绝不能拿登录用户的 mid 顶替
        expect(url.searchParams.get('mid')).toBe('3546378898770447');
        expect(url.searchParams.get('season_id')).toBe('1797750');
        expect(url.searchParams.get('page_num')).toBe('2');
        expect(url.searchParams.get('page_size')).toBe('50');
        expect(data.page).toEqual({ total: 83 });
    });

    it('refuses to guess the season owner instead of querying someone else\'s library', async () => {
        const { bridge, paths } = createHarness([fingerPlan(), jsonResponse({ code: 0, data: {} })]);

        await expect(bridge.request('season_archives', { seasonId: '1797750' }))
            .rejects.toThrow(/season_archives: missing season owner mid/);
        // 只有指纹引导打过出站，合集请求根本没发出去
        expect(paths()).toEqual([FINGER]);
    });

    it('turns a non-zero season list code into an error', async () => {
        const { bridge } = createHarness([fingerPlan(), jsonResponse({ code: -404, message: '啥都木有' })]);

        await expect(bridge.request('season_archives', { seasonId: '9', mid: '7' }))
            .rejects.toThrow(/season archives failed: -404/u);
    });
});
