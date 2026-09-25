// T6: 终极验证 —— 连续翻页拉完整收藏夹（998 条），验证无失败、无风控、总耗时
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const pls = await p.library.getUserPlaylists('3881499', 50, 0);
    const folder = pls.items.find(c => (c.providerData?.favType ?? 0) !== 21 && (c.trackCount ?? 0) > 3);
    const t0 = Date.now();
    let offset = 0, fetched = 0, calls = 0, errors = 0, lastErr = null;
    let hasMore = true;
    const ids = new Set();
    while (hasMore) {
        try {
            const pg = await p.catalog.getPlaylistTracks(folder.id, 1000, offset, folder);
            calls += 1;
            fetched += pg.items.length;
            pg.items.forEach(s => ids.add(s.id));
            hasMore = pg.hasMore;
            offset = pg.nextOffset;
            if (!pg.items.length && !pg.hasMore) break;
            if (calls > 40) break; // 安全阀
        } catch (e) {
            errors += 1;
            lastErr = String(e && e.message || e);
            if (String(e).includes('风控') || (e && e.isRiskControl)) break;
            await new Promise(r => setTimeout(r, 500));
            if (errors > 3) break;
        }
    }
    return JSON.stringify({
        folder: folder.name,
        totalMs: Date.now() - t0,
        calls, fetched, unique: ids.size,
        errors, lastErr,
        riskControl: Boolean(lastErr && lastErr.includes('风控')),
    });
})()
