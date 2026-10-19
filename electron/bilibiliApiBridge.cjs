let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* optional peer: only qr_image needs it */ }

// electron/bilibiliApiBridge.cjs
// Bilibili credentials live in the main process only: cookies (SESSDATA / bili_jct / buvid…) are
// persisted as a safeStorage-encrypted envelope and never handed to the renderer. The renderer
// keeps only non-secret hints (mid, nickname, avatar) through providerStorage.

const SESSION_KEY = 'BILIBILI_SESSION_V1';
// Kept separate from the session envelope: the cooldown outlives logout and must survive a restart
// even when safeStorage is unavailable, and it holds no credential.
const RISK_CONTROL_KEY = 'BILIBILI_RISK_CONTROL_V1';
const ENVELOPE_VERSION = 1;

const PASSPORT_BASE = 'https://passport.bilibili.com';
const API_BASE = 'https://api.bilibili.com';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COMMON_HEADERS = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
};

const QR_POLL_STATE = {
    0: 'confirmed',
    86038: 'expired',
    86090: 'scanned',
    86101: 'waiting',
};

const SESSION_COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4'];

// --- WBI request signing (ported from Biu's electron/ipc/api/wbi.ts) ---
const crypto = require('crypto');

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
    13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
    44, 52,
];

const getMixinKey = (orig) => MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32);

const signWbiParams = (params, wbi) => {
    if (!wbi?.imgKey || !wbi?.subKey) return params;
    const mixinKey = getMixinKey(wbi.imgKey + wbi.subKey);
    const chrFilter = /[!'()*]/g;
    const signed = { ...params, wts: Math.round(Date.now() / 1000) };
    const query = Object.keys(signed)
        .sort()
        .map((key) => {
            const value = String(signed[key]).replace(chrFilter, '');
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        })
        .join('&');
    const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
    return { ...signed, w_rid: wRid };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bilibili's WAF answers abusive bursts with HTTP 412 (and `code: -412` inside a 200 body), and
// rate-limits with 429/503. Once tripped it keeps rejecting the whole IP + session for a while, so
// the bridge stops sending for a cooldown window instead of retrying straight back into a longer ban.
const RISK_CONTROL_COOLDOWN_MS = 10 * 60 * 1000;
const RISK_CONTROL_HTTP_STATUSES = new Set([412, 429, 503]);
// A blocked finger/spi endpoint must not be re-probed ahead of every business request, or the
// bootstrap doubles our request volume precisely while Bilibili is throttling us.
const FINGERPRINT_RETRY_BACKOFF_MS = 60 * 1000;
// Serialized, paced requests: Bilibili rate-limits fav/playurl aggressively and treats parallel
// bursts as scraping, so keep one request in flight with a small gap between them.
const MIN_REQUEST_GAP_MS = 300;
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_MAX_ATTEMPTS = 2;

class BilibiliRiskControlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BilibiliRiskControlError';
        this.isRiskControl = true;
    }
}

function createBilibiliApiBridge({ store, safeStorage, warn, netFetch }) {
    const logWarn = (message, error) => {
        const fn = warn || console.warn;
        fn('[BilibiliBridge]', message, error instanceof Error ? error.message : error || '');
    };

    // safeStorage is only usable after the app 'ready' event; the bridge is constructed earlier,
    // so availability is probed lazily on every persist/load instead of once at creation time.
    const isEncryptionAvailable = () => {
        if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false;
        try {
            return Boolean(safeStorage.isEncryptionAvailable());
        } catch {
            return false;
        }
    };

    let encryptionWarned = false;
    const encryptionAvailable = () => {
        const available = isEncryptionAvailable();
        if (!available && !encryptionWarned) {
            encryptionWarned = true;
            logWarn('safeStorage unavailable; keeping the session in memory only (it will not survive restarts)');
        }
        return available;
    };

    // In-memory session; hydrated from the encrypted store on first access.
    let session = null;
    let sessionLoaded = false;

    const loadSession = () => {
        if (sessionLoaded) return session;
        sessionLoaded = true;
        try {
            const envelope = store.get(SESSION_KEY);
            if (envelope && envelope.version === ENVELOPE_VERSION && envelope.encrypted && encryptionAvailable()) {
                const decrypted = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
                const parsed = JSON.parse(decrypted);
                if (parsed && typeof parsed === 'object') {
                    session = {
                        cookies: parsed.cookies || {},
                        refreshToken: parsed.refreshToken || '',
                        wbi: parsed.wbi || null,
                        mid: parsed.mid || null,
                        nickname: parsed.nickname || '',
                    };
                }
            }
        } catch (error) {
            logWarn('failed to load stored session', error);
        }
        return session;
    };

    const persistSession = () => {
        if (!session) return;
        if (!encryptionAvailable()) return; // degraded: memory-only
        try {
            const payload = JSON.stringify({
                cookies: session.cookies,
                refreshToken: session.refreshToken,
                wbi: session.wbi,
                mid: session.mid,
                nickname: session.nickname,
            });
            const encrypted = safeStorage.encryptString(payload);
            store.set(SESSION_KEY, {
                version: ENVELOPE_VERSION,
                encrypted: true,
                data: encrypted.toString('base64'),
            });
        } catch (error) {
            logWarn('failed to persist session', error);
        }
    };

    const setCookie = (name, value) => {
        if (!session) session = { cookies: {}, refreshToken: '', wbi: null, mid: null, nickname: '' };
        if (!name || !value) return;
        session.cookies[name] = value;
    };

    const collectSetCookieHeaders = (headers) => {
        if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
        const raw = headers.get('set-cookie');
        if (!raw) return [];
        // Fallback for stacks without getSetCookie(): split on the comma that precedes the next
        // `name=` pair, leaving `Expires=Wed, 21 Oct …` commas intact.
        return raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
    };

    const absorbSetCookies = (headers) => {
        let absorbed = 0;
        const entries = collectSetCookieHeaders(headers);
        entries.forEach((entry) => {
            const pair = entry.split(';')[0] || '';
            const separator = pair.indexOf('=');
            if (separator <= 0) return;
            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            if (!name) return;
            // Deletion cookies arrive as `name=; Expires=…` — treat an empty value as a removal.
            if (!value) delete session?.cookies?.[name];
            else setCookie(name, value);
            absorbed += 1;
        });
        return absorbed;
    };

    const cookieHeader = () => {
        if (!session) return '';
        return Object.entries(session.cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join('; ');
    };

    // Prefer Chromium's network stack (Electron `net.fetch`): the Bilibili WAF fingerprints the
    // TLS/HTTP2 client and lets browser-like clients through where Node's undici gets challenged.
    const doFetch = typeof netFetch === 'function' ? netFetch : fetch;

    // 冷却截止时间落盘：看到"冷却中"的用户第一反应就是重启应用，进程内计时器会让那次重启
    // 直接撞回还没过期的封禁上，把封禁越拖越长。
    const clearPersistedCooldown = () => {
        try {
            store.delete(RISK_CONTROL_KEY);
        } catch (error) {
            logWarn('failed to clear stored risk-control state', error);
        }
    };

    const readPersistedCooldown = () => {
        try {
            const stored = store.get(RISK_CONTROL_KEY);
            const until = Number(stored?.until);
            if (!Number.isFinite(until)) return 0;
            if (until > Date.now()) return until;
            // 过期就顺手删掉：留着它只会在每次启动时重新解析一遍。
            clearPersistedCooldown();
            return 0;
        } catch (error) {
            logWarn('failed to load stored risk-control state', error);
            return 0;
        }
    };

    let riskControlUntil = -1; // -1 = 还没从 store 读过；桥在 app ready 前就构造好了，别在模块求值期读写 store
    let requestChain = Promise.resolve();
    let lastRequestAt = 0;

    const assertNotCoolingDown = () => {
        if (riskControlUntil < 0) riskControlUntil = readPersistedCooldown();
        const remaining = riskControlUntil - Date.now();
        if (remaining <= 0) {
            if (riskControlUntil > 0) {
                riskControlUntil = 0;
                clearPersistedCooldown();
            }
            return;
        }
        throw new BilibiliRiskControlError(
            `Bilibili 风控冷却中，请约 ${Math.ceil(remaining / 60000)} 分钟后重试（或切换网络/IP）`,
        );
    };

    const tripRiskControl = (detail) => {
        riskControlUntil = Date.now() + RISK_CONTROL_COOLDOWN_MS;
        try {
            store.set(RISK_CONTROL_KEY, { until: riskControlUntil });
        } catch (error) {
            logWarn('failed to persist risk-control state', error);
        }
        logWarn(
            `risk control triggered${detail ? `: ${detail}` : ''}; `
            + `pausing requests for ${RISK_CONTROL_COOLDOWN_MS / 60000} min`,
        );
        return new BilibiliRiskControlError(
            `Bilibili 风控拦截：请求过于频繁或当前网络/IP 被限制，已暂停请求 `
            + `${RISK_CONTROL_COOLDOWN_MS / 60000} 分钟，请稍后再试（或切换网络/IP）`,
        );
    };

    // net.fetch 会一直占着 Chromium 的底层请求，直到 body 被读走或显式 cancel；下面每条抛错路径
    // 都没走到 response.json()，不主动释放就要等 GC。
    const discardBody = (response) => {
        try {
            Promise.resolve(response.body?.cancel?.()).catch(() => { /* 已消费或已锁定 */ });
        } catch { /* 测试里的简化 response */ }
    };

    const requestJsonOnce = async (url, options = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
        try {
            const response = await doFetch(url, {
                method: options.method || 'GET',
                headers: {
                    ...COMMON_HEADERS,
                    ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
                    ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
                },
                body: options.body,
                signal: controller.signal,
                // Load-bearing under net.fetch: as soon as defaultSession's cookie jar holds any
                // cookie for api.bilibili.com (Bilibili sets buvid3/sid on its own responses),
                // Chromium replaces the Cookie header above with the jar's contents, so SESSDATA and
                // bili_jct stop going out and every call silently degrades to anonymous. The bridge
                // owns its cookie store; the jar must not participate. A no-op on the undici path.
                credentials: 'omit',
            });
            const setCookies = absorbSetCookies(response.headers);
            const status = response.status;
            if (RISK_CONTROL_HTTP_STATUSES.has(status)) {
                discardBody(response);
                throw tripRiskControl(`HTTP ${status} for ${url}`);
            }
            const contentType = String(response.headers.get('content-type') || '');
            if (!contentType.includes('json')) {
                discardBody(response);
                if (status >= 200 && status < 300) {
                    // B 站的滑块验证就是以 200 + HTML 下发的。再戳它一次就是爬虫行为，只会把封禁挖更深，
                    // 所以按风控信号处理：立即熔断，且不进入重试。
                    throw tripRiskControl(`non-JSON 200 (${contentType || 'unknown type'}) for ${url}`);
                }
                throw new Error(`Bilibili API returned non-JSON response (${status})`);
            }
            const body = await response.json();
            // Bilibili also reports risk control inside a 200 body.
            if (body && Number(body.code) === -412) {
                throw tripRiskControl(`code -412 for ${url}`);
            }
            return { body, setCookies, status };
        } finally {
            clearTimeout(timer);
        }
    };

    // Serialize + pace every API call. `finger` and passport traffic go through here too, so the
    // device-fingerprint bootstrap can never race the request that triggered it.
    const requestJson = (url, options = {}) => {
        const run = async () => {
            assertNotCoolingDown();
            const gap = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
            if (gap > 0) await sleep(gap);
            lastRequestAt = Date.now();
            let lastError;
            for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
                try {
                    return await requestJsonOnce(url, options);
                } catch (error) {
                    if (error?.isRiskControl) throw error; // never retry into a ban
                    lastError = error;
                    if (attempt < REQUEST_MAX_ATTEMPTS) {
                        await sleep(400 * attempt + Math.floor(Math.random() * 200));
                    }
                }
            }
            throw lastError;
        };
        const result = requestChain.then(run, run);
        requestChain = result.then(() => undefined, () => undefined);
        return result;
    };

    const extractQrKeyFromUrl = (url) => {
        try {
            const parsed = new URL(url);
            return parsed.searchParams.get('qrcode_key') || '';
        } catch {
            return '';
        }
    };

    // Bilibili returns the login URL together with its key in a single call, while Folia's QR
    // contract is key-first (getQrKey → createQr(key)). Remember the URL per key so createQr can
    // render the image without a second round-trip. Keys expire in ~3 minutes, so the cache stays small.
    const qrUrlByKey = new Map();

    // Device fingerprint cookies; Bilibili's risk control expects them on every API call.
    const runFinger = async () => {
        const { body } = await requestJson(`${API_BASE}/x/frontend/finger/spi`);
        if (body?.code !== 0) throw new Error(`finger spi failed: ${body?.code}`);
        if (body?.data?.b_3) setCookie('buvid3', body.data.b_3);
        if (body?.data?.b_4) setCookie('buvid4', body.data.b_4);
        persistSession();
        return { b3: body?.data?.b_3 || '', b4: body?.data?.b_4 || '' };
    };

    // Passport endpoints are the exception: they mint the session, so they run before buvid exists.
    const PASSPORT_OPERATIONS = new Set(['qr_generate', 'qr_image', 'qr_poll', 'logout']);
    let fingerprintBootstrap = null;
    let fingerprintAttemptAt = 0;
    const ensureDeviceFingerprint = async () => {
        if (session?.cookies?.buvid3) return;
        // 失败的 spi 调用不能被每个业务请求各触发一次：那正好在被限流时把出站请求量翻倍，
        // 还要各付一次 15s 超时。退避窗口内直接放行，让上层请求自己去撞真实错误。
        if (fingerprintAttemptAt && Date.now() - fingerprintAttemptAt < FINGERPRINT_RETRY_BACKOFF_MS) return;
        if (!fingerprintBootstrap) {
            fingerprintAttemptAt = Date.now();
            fingerprintBootstrap = runFinger()
                .catch((error) => { logWarn('device fingerprint bootstrap failed', error); })
                .finally(() => { fingerprintBootstrap = null; });
        }
        return fingerprintBootstrap;
    };

    const operations = {
        qr_generate: async () => {
            const { body } = await requestJson(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`);
            if (body?.code !== 0 || !body?.data?.url || !body?.data?.qrcode_key) {
                throw new Error(`qrcode generate failed: ${body?.code} ${body?.message || ''}`);
            }
            qrUrlByKey.set(String(body.data.qrcode_key), String(body.data.url));
            return body.data;
        },

        qr_image: async ({ key }) => {
            if (!key) throw new Error('qr_image: missing key');
            const url = qrUrlByKey.get(String(key));
            if (!url) throw new Error('qr_image: unknown key (generate first)');
            if (!QRCode) throw new Error("the 'qrcode' package is not installed in the main process");
            const imageUrl = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'L' });
            return { imageUrl };
        },

        qr_poll: async ({ key }) => {
            if (!key) throw new Error('qr_poll: missing key');
            const { body } = await requestJson(`${PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`);
            const data = body?.data || {};
            const state = QR_POLL_STATE[Number(data.code)] || 'error';
            if (state === 'confirmed') {
                if (data.refresh_token) {
                    if (!session) session = { cookies: {}, refreshToken: '', wbi: null, mid: null, nickname: '' };
                    session.refreshToken = String(data.refresh_token);
                }
                persistSession();
            }
            return { state, message: data.message || '', url: data.url || '' };
        },

        finger: () => runFinger(),

        login_status: async () => {
            const { body } = await requestJson(`${API_BASE}/x/web-interface/nav`);
            const data = body?.data || {};
            if (body?.code === -101 || !data.isLogin) {
                return { authenticated: false };
            }
            const wbiUrl = (url) => {
                const text = String(url || '');
                if (!text) return '';
                const start = text.lastIndexOf('/') + 1;
                const end = text.lastIndexOf('.');
                return end > start ? text.slice(start, end) : '';
            };
            if (!session) session = { cookies: {}, refreshToken: '', wbi: null, mid: null, nickname: '' };
            session.mid = Number(data.mid) || session.mid;
            session.nickname = String(data.uname || session.nickname || '');
            session.vipStatus = Number(data.vipStatus) || 0;
            session.wbi = {
                imgKey: wbiUrl(data.wbi_img?.img_url),
                subKey: wbiUrl(data.wbi_img?.sub_url),
            };
            persistSession();
            return {
                authenticated: true,
                user: {
                    id: data.mid,
                    nickname: data.uname || '',
                    avatarUrl: data.face || '',
                    vipType: Number(data.vipType) || 0,
                },
            };
        },

        logout: async () => {
            const csrf = session?.cookies?.bili_jct || '';
            if (csrf) {
                try {
                    const form = new URLSearchParams({ biliCSRF: csrf });
                    await requestJson(`${PASSPORT_BASE}/x/passport-login/web/exit`, { method: 'POST', body: form });
                } catch (error) {
                    logWarn('server-side logout failed; clearing local session anyway', error);
                }
            }
            session = null;
            store.delete(SESSION_KEY);
            // 登号把 buvid3 一起清掉了，下次调用需要重新引导指纹；退避窗口随之作废。
            // 风控冷却故意不重置：那是 IP 级别的，登出解不开。
            fingerprintAttemptAt = 0;
            return { ok: true };
        },

        // Favorite folders. `mid` falls back to the stored account id; a missing mid means the
        // caller skipped login_status, which is a provider-side bug rather than a user error.
        fav_created: async ({ mid }) => {
            const targetMid = Number(mid || session?.mid || 0);
            if (!targetMid) throw new Error('fav_created: no account mid (login first)');
            const { body } = await requestJson(`${API_BASE}/x/v3/fav/folder/created/list-all?up_mid=${targetMid}&type=2`);
            if (body?.code !== 0) throw new Error(`fav created failed: ${body?.code} ${body?.message || ''}`);
            return body.data;
        },

        fav_collected: async ({ mid, pn = 1, ps = 20 }) => {
            const targetMid = Number(mid || session?.mid || 0);
            if (!targetMid) throw new Error('fav_collected: no account mid (login first)');
            const { body } = await requestJson(
                `${API_BASE}/x/v3/fav/folder/collected/list?up_mid=${targetMid}&pn=${Number(pn) || 1}&ps=${Number(ps) || 20}&platform=web`,
            );
            if (body?.code !== 0) throw new Error(`fav collected failed: ${body?.code} ${body?.message || ''}`);
            return body.data;
        },

        fav_resources: async ({ mediaId, pn = 1, ps = 20 }) => {
            const targetMediaId = String(mediaId || '').trim();
            if (!targetMediaId) throw new Error('fav_resources: missing mediaId');
            const { body } = await requestJson(
                `${API_BASE}/x/v3/fav/resource/list?media_id=${encodeURIComponent(targetMediaId)}&pn=${Number(pn) || 1}&ps=${Number(ps) || 20}&order=mtime&type=0&platform=web`,
            );
            if (body?.code !== 0) throw new Error(`fav resources failed: ${body?.code} ${body?.message || ''}`);
            return body.data;
        },

        // 订阅来的「合集」收藏夹（folder type 21）在 fav/resource/list 里返回 code 0 + 空列表，
        // 内容只能按合集作者的视频列表取。这里的 mid 是合集作者的 mid，不是当前登录用户，
        // 所以必须由调用方显式传，缺了就只能报错而不是猜。
        season_archives: async ({ seasonId, mid, pn = 1, ps = 20 }) => {
            const targetSeasonId = String(seasonId || '').trim();
            const ownerMid = String(mid || '').trim();
            if (!targetSeasonId) throw new Error('season_archives: missing seasonId');
            if (!ownerMid) throw new Error('season_archives: missing season owner mid');
            const { body } = await requestJson(
                `${API_BASE}/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(ownerMid)}&season_id=${encodeURIComponent(targetSeasonId)}&page_num=${Number(pn) || 1}&page_size=${Number(ps) || 20}`,
            );
            if (body?.code !== 0) throw new Error(`season archives failed: ${body?.code} ${body?.message || ''}`);
            return body.data;
        },

        // --- Playback ---

        audio_song_info: async ({ songid }) => {
            const targetSongId = String(songid || '').trim();
            if (!targetSongId) throw new Error('audio_song_info: missing songid');
            const { body } = await requestJson(
                `${API_BASE}/audio/music-service-c/web/song/info?sid=${encodeURIComponent(targetSongId)}`,
            );
            if (body?.code !== 0) throw new Error(`audio song info failed: ${body?.code}`);
            return body.data;
        },

        // Audio-region stream. quality: 0=128K 1=192K 2=320K 3=FLAC; type -1 in the reply marks a
        // paid preview clip, which callers use as the fallback trigger for the next-lower tier.
        audio_url: async ({ songid }) => {
            const targetSongId = String(songid || '').trim();
            if (!targetSongId) throw new Error('audio_url: missing songid');
            const targetMid = session?.mid || '';
            const vipStatus = session?.vipStatus ? 1 : 0;
            const fetchUrl = async (quality) => {
                const { body } = await requestJson(
                    `${API_BASE}/audio/music-service-c/url?mid=${targetMid}&songid=${encodeURIComponent(targetSongId)}&quality=${quality}&privilege=2&platform=web`,
                );
                return body;
            };
            let body = await fetchUrl(vipStatus ? 3 : 2);
            if (Number(body?.data?.type) === -1) {
                body = await fetchUrl(2);
            }
            if (body?.code !== 0 || !body?.data?.cdns?.length) {
                logWarn(`audio url failed: code=${body?.code} msg=${body?.msg || body?.message || ''} songid=${targetSongId}`);
                throw new Error(`audio url failed: ${body?.code} ${body?.msg || body?.message || ''}`);
            }
            return {
                url: String(body.data.cdns[0]),
                backupUrl: body.data.cdns[1] ? String(body.data.cdns[1]) : '',
                qualityType: Number(body.data.type),
                timeoutSec: Number(body.data.timeout) || 0,
                title: body.data.title || '',
            };
        },

        video_view: async ({ bvid, avid }) => {
            const query = bvid
                ? `bvid=${encodeURIComponent(String(bvid))}`
                : `aid=${Number(avid) || 0}`;
            const { body } = await requestJson(`${API_BASE}/x/web-interface/view?${query}`);
            if (body?.code !== 0) throw new Error(`view failed: ${body?.code} ${body?.message || ''}`);
            const data = body.data || {};
            const firstPage = Array.isArray(data.pages) && data.pages.length > 0 ? data.pages[0] : null;
            return {
                bvid: data.bvid || String(bvid || ''),
                avid: data.aid || Number(avid) || 0,
                cid: firstPage?.cid ?? data.cid ?? 0,
                title: data.title || '',
                pic: data.pic || '',
                pages: Array.isArray(data.pages)
                    ? data.pages.map(page => ({ cid: page.cid, part: page.part, duration: page.duration }))
                    : [],
            };
        },

        video_playurl: async ({ avid, bvid, cid }) => {
            const targetCid = Number(cid) || 0;
            if (!targetCid) throw new Error('video_playurl: missing cid');
            const params = signWbiParams({
                ...(bvid ? { bvid: String(bvid) } : { avid: Number(avid) || 0 }),
                cid: targetCid,
                qn: 64,
                fnval: 16,
                fnver: 0,
                fourk: 1,
            }, session?.wbi);
            const query = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined) query.set(key, String(value));
            });
            const { body } = await requestJson(`${API_BASE}/x/player/wbi/playurl?${query}`);
            if (body?.code !== 0) throw new Error(`playurl failed: ${body?.code} ${body?.message || ''}`);
            const dash = body?.data?.dash;
            const audioList = Array.isArray(dash?.audio) ? dash.audio : [];
            const best = audioList
                .filter(stream => stream?.base_url)
                .sort((left, right) => Number(right.bandwidth || 0) - Number(left.bandwidth || 0))[0];
            if (best) {
                return {
                    url: String(best.base_url),
                    backupUrl: Array.isArray(best.backup_url) && best.backup_url.length ? String(best.backup_url[0]) : '',
                    bandwidth: Number(best.bandwidth) || 0,
                    codecs: best.codecs || '',
                    timelengthMs: Number(body?.data?.timelength) || 0,
                };
            }
            // Legacy videos answer with a muxed durl (MP4) instead of DASH. An <audio> element can
            // still play its audio track, so hand the proxy the direct URL.
            const durl = Array.isArray(body?.data?.durl) ? body.data.durl[0] : null;
            if (durl?.url) {
                return {
                    url: String(durl.url),
                    backupUrl: Array.isArray(durl.backup_url) && durl.backup_url.length ? String(durl.backup_url[0]) : '',
                    bandwidth: 0,
                    codecs: 'muxed-durl',
                    timelengthMs: Number(body?.data?.timelength) || 0,
                };
            }
            logWarn(
                'playurl: no audio stream; '
                + `v_voucher=${body?.data?.v_voucher ? 'present(risk-control)' : 'absent'} `
                + `hasDash=${Boolean(dash)} durlCount=${Array.isArray(body?.data?.durl) ? body.data.durl.length : 0} `
                + `acceptQuality=${JSON.stringify(body?.data?.accept_quality || []).slice(0, 100)}`,
            );
            throw new Error('playurl: no audio stream in dash or durl response');
        },
    };

    const hasAuthenticatedCookies = () => {
        const cookies = session?.cookies || {};
        return SESSION_COOKIE_KEYS.filter((key) => cookies[key]).length >= 3;
    };

    const pruneNonSessionCookies = () => {
        if (!session) return;
        const next = {};
        SESSION_COOKIE_KEYS.forEach((key) => {
            if (session.cookies[key]) next[key] = session.cookies[key];
        });
        session.cookies = next;
    };

    return {
        getStatus() {
            const current = session || loadSession();
            if (!current) return { configured: true, authenticated: false };
            return { configured: true, authenticated: hasAuthenticatedCookies() };
        },

        async request(operation, params = {}) {
            if (!session) loadSession();
            const handler = operations[operation];
            if (!handler) throw new Error(`Unknown bilibili operation: ${operation}`);
            // Bootstrap buvid3/buvid4 before the first API call so it does not look like a bot.
            if (operation !== 'finger' && !PASSPORT_OPERATIONS.has(operation)) {
                await ensureDeviceFingerprint();
            }
            const result = await handler(params);
            // Keep the stored envelope focused on long-lived credentials; transient cookies are dropped.
            if (session) pruneNonSessionCookies();
            return result;
        },
    };
}

module.exports = { createBilibiliApiBridge };
