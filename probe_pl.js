(async () => {
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    const page = await omni.getCollectionTracks(
        { kind: 'collection', providerId: 'netease', id: '5142150027', collectionType: 'playlist' },
        { limit: 3, offset: 0 },
    );
    return JSON.stringify({
        total: page.total,
        first3: page.items.map(s => `${s.name} - ${s.artists?.[0]?.name}`),
    });
})()
