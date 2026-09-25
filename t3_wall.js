// T3: 曲墙性能基准 —— 模拟 GridView 后台补全单次索要 1000 条的真实调用模式
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const out = {};
    let t0 = Date.now();
    const pls = await p.library.getUserPlaylists('3881499', 50, 0);
    out.playlists = {
        ms: Date.now() - t0,
        count: pls.items.length,
        sample: pls.items.slice(0, 6).map(c => ({
            name: c.name, favType: c.providerData?.favType ?? 0, trackCount: c.trackCount,
        })),
    };
    const normal = pls.items.find(c => (c.providerData?.favType ?? 0) !== 21 && (c.trackCount ?? 0) > 0);
    if (normal) {
        t0 = Date.now();
        const first = await p.catalog.getPlaylistTracks(normal.id, 1000, 0, normal);
        const firstMs = Date.now() - t0;
        const tPage = Date.now();
        let fetched = first.items.length, nextOffset = first.nextOffset, pages = 1;
        const cap = Math.min(200, first.total);
        while (fetched < cap && first.hasMore) {
            const pg = await p.catalog.getPlaylistTracks(normal.id, 1000, nextOffset, normal);
            pages += 1; fetched += pg.items.length; nextOffset = pg.nextOffset;
            if (!pg.items.length) break;
        }
        out.wall = {
            folder: normal.name, total: first.total,
            firstCallMs: firstMs, firstItems: first.items.length, firstHasMore: first.hasMore,
            pagesTo200: pages, msTo200: Date.now() - tPage, fetched,
        };
    }
    const season = pls.items.find(c => c.providerData?.favType === 21 && (c.trackCount ?? 0) > 0);
    if (season) {
        t0 = Date.now();
        const s = await p.catalog.getPlaylistTracks(season.id, 1000, 0, season);
        out.season = { name: season.name, ms: Date.now() - t0, items: s.items.length, total: s.total };
    } else {
        out.season = 'none-in-first-page';
    }
    return JSON.stringify(out);
})()
