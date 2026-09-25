// T8: 端到端播放验证 —— 真实 fetch folia-bili:// 流（Range 请求），验证代理放行与数据返回
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const pls = await p.library.getUserPlaylists('3881499', 50, 0);
    const folder = pls.items.find(c => (c.providerData?.favType ?? 0) !== 21 && (c.trackCount ?? 0) > 3);
    const page = await p.catalog.getPlaylistTracks(folder.id, 1000, 0, folder);
    const song = page.items[0];
    const t0 = Date.now();
    const src = await p.playback.getAudioSource(song, 'high');
    const getUrlMs = Date.now() - t0;
    if (!src?.url) return JSON.stringify({ song: song.name, error: 'no audio source' });

    // 模拟 audio 元素的首个 Range 请求（renderer 里 fetch folia-bili:// 会走主进程代理）
    const t1 = Date.now();
    const res = await fetch(src.url, { headers: { Range: 'bytes=0-262143' } });
    const buf = await res.arrayBuffer();
    const firstByteMs = Date.now() - t1;
    // 中段 seek 验证（1MB 处起读 64KB）
    const t2 = Date.now();
    const res2 = await fetch(src.url, { headers: { Range: 'bytes=1048576-1114111' } });
    const buf2 = await res2.arrayBuffer();
    const seekMs = Date.now() - t2;
    return JSON.stringify({
        song: song.name,
        getUrlMs,
        streamStatus: res.status,
        firstByteMs, firstChunkKB: Math.round(buf.byteLength / 1024),
        seekStatus: res2.status, seekMs, seekChunkKB: Math.round(buf2.byteLength / 1024),
    });
})()
