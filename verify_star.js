(async () => {
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    const bp = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    // 从测试夹拿一首真歌，验证五角星依赖的 getPlaylistsForSong 有候选
    const page = await bp.bilibiliProvider.catalog.getPlaylistTracks('4186852999', 3, 0,
        { providerId: 'bilibili', id: '4186852999', name: 'x', type: 'playlist', providerData: { owned: true, favType: 0 } });
    const song = page.items[0];
    const lists = omni.getPlaylistsForSong(song);
    return JSON.stringify({
        song: song.name,
        playlistsForSong: lists.map(l => ({ id: l.id, name: l.name, owned: l.providerData?.owned })),
        canAddSongToPlaylist: omni.canAddSongToPlaylist(song),
    });
})()
