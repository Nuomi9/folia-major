# gen_import.py —— 生成网易云歌单 -> B 站收藏夹 的 CDP 导入脚本
# 用法: python gen_import.py <歌单id或链接> <目标收藏夹名> [limit]
# 产物: import_run.js（随后 node cdp.mjs import_run.js 执行）
import json, re, sys

raw = sys.argv[1]
folder_name = sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5
m = re.search(r'[?&]id=(\d+)', raw) or re.search(r'^(\d+)$', raw.strip())
assert m, f'无法从 {raw!r} 解析歌单 id'
pid = m.group(1)

js = """(async () => {
    const PLAYLIST_ID = '__PID__';
    const FOLDER_NAME = '__FOLDER__';
    const LIMIT = __LIMIT__;
    const THRESHOLD = 0.55;

    const clean = (s) => String(s || '').toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/【[^】]*】|\\[[^\\]]*\\]|\\([^)]*\\)|（[^）]*）/g, ' ')
        .replace(/[^\\p{L}\\p{N}]+/gu, ' ')
        .trim();
    const tokens = (s) => new Set(clean(s).split(' ').filter(Boolean));
    const sim = (a, b) => {
        const A = tokens(a), B = tokens(b);
        if (!A.size || !B.size) return 0;
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        return inter / Math.max(A.size, B.size);
    };
    const score = (cand, song) => {
        const dur = (cand.durationMs || 0) / 1000;
        const want = (song.durationMs || 0) / 1000;
        let s = sim(song.name, cand.name) * 0.45;
        if (clean(cand.name).includes(clean(song.name))) s += 0.2;
        const artist = song.artists?.[0]?.name;
        if (artist && (clean(cand.artists?.[0]?.name || '').includes(clean(artist))
            || clean(cand.name).includes(clean(artist)))) s += 0.2;
        const dDiff = Math.abs(dur - want);
        s += dDiff <= 5 ? 0.15 : dDiff <= 15 ? 0.08 : dDiff <= 30 ? 0.02 : 0;
        // 伴奏/翻唱/cover 通常不是想收藏的「原曲」，压分
        if (/伴奏|翻唱|cover|纯音乐|铃声|instrumental/i.test(cand.name)) s -= 0.18;
        return s;
    };

    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    const { bilibiliProvider } = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const { requestBilibili } = await import('/src/services/onlineMusic/bilibiliTransport.ts');
    const p = bilibiliProvider;

    // 1) 网易云歌单
    const songs = [];
    let offset = 0;
    while (songs.length < LIMIT) {
        const page = await omni.getCollectionTracks(
            { kind: 'collection', providerId: 'netease', id: PLAYLIST_ID, collectionType: 'playlist' },
            { limit: 50, offset },
        );
        const items = page.items || [];
        if (!items.length) break;
        songs.push(...items);
        offset += items.length;
        if (!page.hasMore) break;
    }
    const picked = songs.slice(0, LIMIT);
    if (!picked.length) return JSON.stringify({ error: 'playlist empty or not found', playlistId: PLAYLIST_ID });

    // 2) 目标收藏夹：同名复用，否则新建
    const created = await requestBilibili('fav_created_paged', { mid: (await omni.getLoginStatus('bilibili')).id, pn: 1, ps: 50 });
    let folder = (created?.list || []).find(f => String(f.title) === FOLDER_NAME);
    if (!folder) {
        const added = await requestBilibili('fav_folder_add', { title: FOLDER_NAME });
        folder = { id: added?.id ?? added?.folder_id ?? String(added) };
    }
    const folderId = String(folder.id);

    // 3) 逐首搜索匹配 + 收藏
    const matched = [], unmatched = [], failed = [];
    for (const song of picked) {
        const query = [song.name, song.artists?.[0]?.name].filter(Boolean).join(' ');
        try {
            const res = await p.search.searchSongs(query, 10, 0);
            let best = null, bestScore = 0;
            for (const cand of res.items) {
                const sc = score(cand, song);
                if (sc > bestScore) { bestScore = sc; best = cand; }
            }
            if (!best || bestScore < THRESHOLD) {
                unmatched.push({ name: song.name, artist: song.artists?.[0]?.name, bestScore: +bestScore.toFixed(2), bestTitle: best?.name || null });
                continue;
            }
            const avid = String(best.sourceRef?.providerData?.avid || '');
            await requestBilibili('fav_deal', { avid, addMediaIds: folderId });
            matched.push({ name: song.name, artist: song.artists?.[0]?.name, score: +bestScore.toFixed(2), bili: best.name, bvid: best.sourceRef?.providerData?.bvid });
        } catch (e) {
            failed.push({ name: song.name, error: String(e && e.message || e).slice(0, 400) });
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return JSON.stringify({
        folderId, folderName: FOLDER_NAME,
        total: picked.length, matched: matched.length, unmatched: unmatched.length, failed: failed.length,
        matched, unmatched, failed,
    });
})()
"""
js = js.replace('__PID__', pid).replace('__FOLDER__', folder_name).replace('__LIMIT__', str(limit))
open('import_run.js', 'w', encoding='utf-8').write(js)
print(f'generated import_run.js | playlist={pid} folder={folder_name!r} limit={limit}')
