// T4+T5: 播放取流计时（音频区 + 视频区）与歌词 fallback 计时
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const out = {};
    // 从默认收藏夹抓几首歌做样本：1 个音频(auid) + 1 个视频(avid)
    const pls = await p.library.getUserPlaylists('3881499', 50, 0);
    const folder = pls.items.find(c => (c.providerData?.favType ?? 0) !== 21 && (c.trackCount ?? 0) > 0);
    const page = await p.catalog.getPlaylistTracks(folder.id, 1000, 0, folder);
    const audioSong = page.items.find(s => s.sourceRef?.mediaId?.startsWith('audio:'));
    const videoSong = page.items.find(s => s.sourceRef?.mediaId?.startsWith('video:'));
    const quality = 'high';

    // T4a: 歌曲详情
    if (videoSong) {
        const t = Date.now();
        const detail = await p.playback.getSongDetail(videoSong.sourceRef.mediaId);
        out.videoDetail = { ms: Date.now() - t, name: detail?.name, artist: detail?.artists?.[0]?.name };
    }
    // T4b: 视频取流
    if (videoSong) {
        const t = Date.now();
        const src = await p.playback.getAudioSource(videoSong, quality);
        out.videoStream = {
            ms: Date.now() - t,
            ok: Boolean(src?.url?.startsWith('folia-bili://')),
            expiresMin: src?.expiresAt ? Math.round((src.expiresAt - Date.now()) / 60000) : null,
        };
    }
    // T4c: 音频取流
    if (audioSong) {
        const t = Date.now();
        const src = await p.playback.getAudioSource(audioSong, quality);
        out.audioStream = {
            ms: Date.now() - t,
            ok: Boolean(src?.url?.startsWith('folia-bili://')),
            expiresMin: src?.expiresAt ? Math.round((src.expiresAt - Date.now()) / 60000) : null,
        };
    }
    // T5: 歌词（B 站无词，走网易云 fallback：搜索 + 匹配 + 取词）
    if (videoSong) {
        const t = Date.now();
        try {
            const lyr = await p.lyrics.getLyrics(videoSong);
            out.lyrics = {
                ms: Date.now() - t,
                got: Boolean(lyr?.lyrics),
                lines: lyr?.lyrics ? (lyr.lyrics.length ?? 0) : 0,
                isPureMusic: Boolean(lyr?.isPureMusic),
            };
        } catch (e) {
            out.lyrics = { ms: Date.now() - t, error: String(e && e.message || e) };
        }
    }
    return JSON.stringify(out);
})()
