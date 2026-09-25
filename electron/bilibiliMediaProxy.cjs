// electron/bilibiliMediaProxy.cjs
// Streams Bilibili CDN audio through a privileged custom scheme. Bilibili CDNs reject requests
// whose Referer is not bilibili.com, so the renderer can never fetch the stream URLs directly.
// This handler rewrites the Referer/UA and forwards Range headers so seeking keeps working.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALLOWED_HOST_SUFFIXES = [
    'bilivideo.com',
    'bilivideo.audio',
    'bilivideo.cn',
    'bcbilivideo.com',
    'mcbilivideo.com',
    'akamaized.net',
    'hdslb.com',
    'szbdyd.com',
];

const isAllowedRemoteUrl = (remoteUrl) => {
    try {
        const parsed = new URL(remoteUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        const hostname = parsed.hostname.toLowerCase();
        return ALLOWED_HOST_SUFFIXES.some((suffix) => (
            hostname === suffix || hostname.endsWith(`.${suffix}`)
        ));
    } catch {
        return false;
    }
};

const createBilibiliMediaProxy = ({ logWarn }) => {
    const warn = logWarn || ((message, error) => console.warn('[BilibiliMediaProxy]', message, error || ''));

    const registerProtocolHandler = (protocol, net) => {
        const fetchUpstream = async (remoteUrl, request) => {
            const headers = {
                'User-Agent': USER_AGENT,
                Referer: 'https://www.bilibili.com/',
                Origin: 'https://www.bilibili.com',
            };
            const range = request.headers.get('range');
            if (range) headers.Range = range;
            return net.fetch(remoteUrl, { headers });
        };

        protocol.handle('folia-bili', async (request) => {
            let primaryUrl = null;
            let altUrl = null;
            try {
                const url = new URL(request.url);
                if (url.hostname !== 'stream') throw new Error('Invalid folia-bili host');
                primaryUrl = decodeURIComponent(url.pathname.replace(/^\//, ''));
                const alt = url.searchParams.get('alt');
                if (alt) altUrl = decodeURIComponent(alt);
            } catch (error) {
                warn('bad folia-bili request', error);
                return new Response('Bad request', { status: 400 });
            }

            if (!isAllowedRemoteUrl(primaryUrl)) {
                warn(`blocked non-allowlist remote host: ${primaryUrl.slice(0, 120)}`);
                return new Response('Forbidden remote host', { status: 403 });
            }
            // B 站 PCDN 的 backup_url 常是纯 IP 直连形态（如 http://122.x.x.x:8082/...），
            // 无法用域名白名单校验。alt 只是备用线路，忽略它即可，主线路照播——
            // 之前 alt 不在白名单会把整个请求 403，播放表现就是永远转圈。
            if (altUrl && !isAllowedRemoteUrl(altUrl)) {
                warn(`ignoring non-allowlist alt host: ${altUrl.slice(0, 120)}`);
                altUrl = null;
            }

            // Bilibili PCDN nodes are flaky: connections get closed or return empty replies at
            // random. Try the primary host, then the CDN-provided backup before giving up.
            let upstream = null;
            let lastError = null;
            for (const candidate of altUrl ? [primaryUrl, altUrl] : [primaryUrl]) {
                try {
                    const response = await fetchUpstream(candidate, request);
                    if (response.ok || response.status === 206) {
                        upstream = response;
                        break;
                    }
                    lastError = new Error(`upstream status ${response.status}`);
                    lastError.upstreamStatus = response.status;
                    warn(`upstream fetch failed with status ${response.status}`);
                } catch (error) {
                    lastError = error;
                    warn('upstream fetch threw', error);
                }
            }
            if (!upstream) {
                // 上游给出了明确状态码（如 416 Range 越界——PCDN 节点只缓存部分内容）时原样
                // 透传，audio 元素能理解这些语义；只有真正的网络异常才用 502。
                const status = typeof lastError?.upstreamStatus === 'number' ? lastError.upstreamStatus : 502;
                return new Response(`Upstream error: ${lastError instanceof Error ? lastError.message : 'unknown'}`, { status });
            }
            const responseHeaders = new Headers();
            const contentType = upstream.headers.get('content-type');
            responseHeaders.set('Content-Type', contentType && !contentType.includes('text/html') ? contentType : 'audio/mpeg');
            const contentLength = upstream.headers.get('content-length');
            if (contentLength) responseHeaders.set('Content-Length', contentLength);
            const contentRange = upstream.headers.get('content-range');
            if (contentRange) responseHeaders.set('Content-Range', contentRange);
            responseHeaders.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
            return new Response(upstream.body, {
                status: upstream.status,
                headers: responseHeaders,
            });
        });
    };

    const wrapStreamUrl = (remoteUrl, altUrl) => (
        remoteUrl
            ? `folia-bili://stream/${encodeURIComponent(remoteUrl)}${altUrl ? `?alt=${encodeURIComponent(altUrl)}` : ''}`
            : ''
    );

    return { registerProtocolHandler, wrapStreamUrl, isAllowedRemoteUrl };
};

module.exports = { createBilibiliMediaProxy };
