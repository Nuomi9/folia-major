// T4c: 音频区(auid)取流计时 —— 遍历收藏夹找到音频条目
(async () => {
    const m = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const p = m.bilibiliProvider;
    const pls = await p.library.getUserPlaylists('3881499', 50, 0);
    const folders = pls.items.filter(c => (c.providerData?.favType ?? 0) !== 21 && (c.trackCount ?? 0) > 0);
    let audioSong = null;
    for (const folder of folders) {
        if (audioSong) break;
        const page = await p.catalog.getPlaylistTracks(folder.id, 100, 0, folder);
        audioSong = page.items.find(s => s.sourceRef?.mediaId?.startsWith('audio:')) || null;
    }
    if (!audioSong) return JSON.stringify({ audioStream: 'no-audio-entry-found-in-libraries' });
    const t = Date.now();
    const src = await p.playback.getAudioSource(audioSong, 'high');
    return JSON.stringify({
        audioStream: {
            song: audioSong.name,
            ms: Date.now() - t,
            ok: Boolean(src?.url?.startsWith('folia-bili://')),
            expiresMin: src?.expiresAt ? Math.round((src.expiresAt - Date.now()) / 60000) : null,
        },
    });
})()
