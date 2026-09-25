// T9: 真实播放管线验证 —— renderer 里用 Audio 元素实际加载 folia-bili:// 流到可解码
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const pls = await p.library.getUserPlaylists('3881499', 50, 0);
    const folder = pls.items.find(c => (c.providerData?.favType ?? 0) !== 21 && (c.trackCount ?? 0) > 3);
    const page = await p.catalog.getPlaylistTracks(folder.id, 1000, 0, folder);
    const song = page.items[0];
    const src = await p.playback.getAudioSource(song, 'high');
    if (!src?.url) return JSON.stringify({ song: song.name, error: 'no source' });

    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = src.url;
    const result = await new Promise((resolve) => {
        const done = (event, extra = {}) => {
            audio.pause();
            audio.removeAttribute('src');
            resolve(JSON.stringify({
                song: song.name, event,
                ms: Date.now() - t0,
                durationSec: audio.duration && isFinite(audio.duration) ? Math.round(audio.duration) : null,
                ...extra,
            }));
        };
        const t0 = Date.now();
        audio.addEventListener('loadedmetadata', () => done('loadedmetadata'));
        audio.addEventListener('canplay', () => done('canplay'));
        audio.addEventListener('error', () => done('error', { code: audio.error?.code, message: audio.error?.message }));
        setTimeout(() => done('timeout-30s'), 30000);
        audio.load();
    });
    return result;
})()
