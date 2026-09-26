(async () => {
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    const detail = await omni.getCollectionDetail(
        { kind: 'collection', providerId: 'netease', id: '5142150027', collectionType: 'playlist' },
    );
    return JSON.stringify({ name: detail?.name ?? null, keys: detail ? Object.keys(detail).slice(0, 10) : null });
})()
