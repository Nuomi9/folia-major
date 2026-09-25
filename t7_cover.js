// T7: 收藏夹封面排查 —— 接口是否返回 cover + 图床防盗链验证
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const pls = await p.library.getUserPlaylists('3881499', 20, 0);
    const covers = pls.items.slice(0, 6).map(c => ({
        name: c.name,
        hasCover: Boolean(c.coverUrl),
        coverUrl: c.coverUrl || null,
    }));
    // 用第一个真实 cover URL 做防盗链验证：无 Referer vs 伪 Referer
    const withCover = covers.find(c => c.coverUrl);
    let hotlink = null;
    if (withCover) {
        const url = withCover.coverUrl;
        const bare = await fetch(url, { method: 'GET' }).then(r => r.status).catch(e => String(e.message).slice(0, 60));
        const spoofed = await fetch(url, {
            method: 'GET',
            referrerPolicy: 'no-referrer',
            headers: { Referer: 'https://www.bilibili.com/' },
        }).then(r => r.status).catch(e => String(e.message).slice(0, 60));
        // renderer 实际加载时 Referer 是 localhost:3001
        const appRef = await fetch(url, {
            headers: { Referer: 'http://localhost:3001/' },
        }).then(r => r.status).catch(e => String(e.message).slice(0, 60));
        hotlink = { bare, spoofed, appRef, url: url.slice(0, 80) };
    }
    return JSON.stringify({ covers, hotlink });
})()
