(async () => {
    // 验证：设置面板新 anchor 已注册 + B 站 mutations 可用 + 导入服务可 import
    const { SETTINGS_ANCHOR_DEFINITIONS } = await import('/src/components/modal/settings/navigation/settingsAnchorModel.ts');
    const bp = await import('/src/services/onlineMusic/bilibiliProvider.ts');
    const svc = await import('/src/services/bilibiliPlaylistImport.ts');
    const hasBilibiliImport = 'bilibiliImport' in SETTINGS_ANCHOR_DEFINITIONS;
    const caps = bp.bilibiliProvider.capabilities;
    const folder = await svc.ensureBilibiliFolder('网易云导入测试');
    // mutations del 冒烟：对测试夹里第一首执行 del 再 add（还原）
    const page = await bp.bilibiliProvider.catalog.getPlaylistTracks(folder.id, 5, 0,
        { providerId: 'bilibili', id: folder.id, name: folder.name, type: 'playlist', providerData: { owned: true, favType: 0 } });
    const first = page.items[0];
    let delOk = false, reAddOk = false;
    if (first) {
        await bp.bilibiliProvider.mutations.updatePlaylistTracks('del', folder.id, [first]);
        delOk = true;
        await bp.bilibiliProvider.mutations.updatePlaylistTracks('add', folder.id, [first]);
        reAddOk = true;
    }
    return JSON.stringify({
        anchorRegistered: hasBilibiliImport,
        capabilities: { search: caps.search, mutations: caps.mutations },
        delSmoke: delOk, reAddSmoke: reAddOk,
    });
})()
