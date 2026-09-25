import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/bilibiliProvider.test.ts
//
// 锁三件事：订阅来的「合集」收藏夹（folder type 21）必须走 season_archives —— fav/resource/*
// 对它返回空列表，整夹歌曲就是这么"拉不出来"的；普通收藏夹走 ids + infos 两阶段，一次调用最多
// 补 4 批详情，曲墙后台补全单次索要 1000 条时不能再把它变成几十个排队请求（B站 会回 412）；
// 以及视频稿件的 UP 主名要能从主进程透传出来，不能永远显示占位串。

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/bilibiliTransport', () => ({
    getBilibiliTransportAvailability: () => ({ configured: true }),
    requestBilibili: requestMock,
}));

import { bilibiliProvider, clearBilibiliFavIdsCache } from '@/services/onlineMusic/bilibiliProvider';
import type { ProviderCollection } from '@/types/onlineMusic';

const seasonFolder: ProviderCollection = {
    providerId: 'bilibili',
    id: 1797750,
    name: '【悬念剧场】',
    type: 'playlist',
    trackCount: 83,
    isOwned: false,
    providerData: { mlid: '1797750', fid: '0', favType: 21, ownerMid: '3546378898770447', ownerName: '竖了个三' },
};

const favFolder: ProviderCollection = {
    providerId: 'bilibili',
    id: 1234,
    name: '默认收藏夹',
    type: 'playlist',
    trackCount: 2,
    isOwned: true,
    providerData: { mlid: '1234', fid: '1234', favType: 11, ownerMid: '42', ownerName: '我自己' },
};

const videoMedia = (id: number, title = `视频${id}`) => ({
    id, type: 2, title, cover: `http://i0.hdslb.com/bfs/archive/${id}.jpg`, duration: 100,
    upper: { mid: 7, name: '上传者' }, bvid: `BV${id}`,
});

const archive = (aid: number, title = `合集条目${aid}`) => ({
    aid, bvid: `BV${aid}`, title, pic: `http://i0.hdslb.com/bfs/archive/${aid}.jpg`, duration: 240,
});

const getPlaylistTracks = (id: number | string, limit: number, offset: number, collection?: ProviderCollection) =>
    bilibiliProvider.catalog!.getPlaylistTracks!(id, limit, offset, collection);
// 收藏夹内容的身份列表（resource/ids）与详情（resource/infos）
const favIds = (count: number, start = 100) =>
    Array.from({ length: count }, (_, i) => ({ id: start + i, type: 2, bvid: `BV${start + i}` }));

const requestedResources = () =>
    requestMock.mock.calls
        .filter(call => call[0] === 'fav_resource_infos')
        .map(call => String(call[1].resources));

describe('bilibiliProvider catalog', () => {
    beforeEach(() => {
        requestMock.mockReset();
        clearBilibiliFavIdsCache();
    });

    it('reads 合集 folders through season_archives instead of the empty fav_resources list', async () => {
        requestMock.mockImplementation(async (operation: string) => (operation === 'season_archives'
            ? {
                aids: [],
                archives: Array.from({ length: 50 }, (_, i) => archive(1000 + i)),
                meta: { season_id: 1797750, total: 83, mid: 3546378898770447 },
                page: { page_num: 1, page_size: 50, total: 83 },
            }
            : { medias: [], info: { media_count: 83 } }));

        const page = await getPlaylistTracks('1797750', 50, 0, seasonFolder);

        expect(requestMock.mock.calls.map(call => call[0])).toEqual(['season_archives']);
        expect(requestMock.mock.calls[0][1]).toMatchObject({
            seasonId: '1797750', mid: '3546378898770447', pn: 1, ps: 50,
        });
        expect(requestMock).not.toHaveBeenCalledWith('fav_resources', expect.anything());
        expect(page.total).toBe(83);
        expect(page.items).toHaveLength(50);
        expect(page.hasMore).toBe(true);
        expect(page.nextOffset).toBe(50);
        expect(page.items[0]).toMatchObject({
            id: 'bili-video-1000',
            name: '合集条目1000',
            artists: [{ id: '3546378898770447', name: '竖了个三' }],
            durationMs: 240_000,
            sourceRef: { mediaId: 'video:1000', providerData: { kind: 'video', avid: '1000', bvid: 'BV1000' } },
        });
        // 封面是 http 的，渲染层会被拦成黑卡
        expect(page.items[0].album?.coverUrl).toBe('https://i0.hdslb.com/bfs/archive/1000.jpg');
    });

    it('reads ordinary favorite folders through ids + infos instead of paging one by one', async () => {
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation === 'fav_resource_ids') return favIds(2, 11);
            const ids = String(params.resources || '').split(',').map(entry => Number(entry.split(':')[0]));
            return ids.map(id => videoMedia(id));
        });

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(requestMock.mock.calls.map(call => call[0])).toEqual(['fav_resource_ids', 'fav_resource_infos']);
        expect(requestedResources()).toEqual(['11:2,12:2']);
        expect(page.items.map(song => song.id)).toEqual(['bili-video-11', 'bili-video-12']);
        expect(page.total).toBe(2);
        expect(page.hasMore).toBe(false);
        expect(page.nextOffset).toBe(2);
    });

    it('caps detail batches per call and lets the caller keep paging', async () => {
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation === 'fav_resource_ids') return favIds(200);
            const ids = String(params.resources || '').split(',').map(entry => Number(entry.split(':')[0]));
            return ids.map(id => videoMedia(id));
        });

        // 曲墙后台补全一次要 1000 条
        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        // 4 批 x 20 条：比逐页 list 少一半往返，而且总数是 ids 给的，不用靠"页面不满"去猜。
        expect(requestedResources()).toHaveLength(4);
        expect(requestedResources()[0].split(',')).toHaveLength(20);
        expect(page.items).toHaveLength(80);
        expect(page.total).toBe(200);
        expect(page.hasMore).toBe(true);
        expect(page.nextOffset).toBe(80);

        const next = await getPlaylistTracks('1234', 1000, 80, favFolder);
        expect(next.items[0].id).toBe('bili-video-180');
    });

    it('does not claim more entries than the folder has', async () => {
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation === 'fav_resource_ids') return favIds(20);
            const ids = String(params.resources || '').split(',').map(entry => Number(entry.split(':')[0]));
            return ids.map(id => videoMedia(id));
        });

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(requestedResources()).toHaveLength(1);
        expect(page.items).toHaveLength(20);
        expect(page.hasMore).toBe(false);
    });

    it('falls back to paged fav_resources when the ids path fails', async () => {
        // ids 接口挂了也不能让整个收藏夹变成"拉不出来"
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation === 'fav_resource_ids') throw new Error('resource ids failed: -400');
            if (operation === 'fav_resources') {
                return { medias: [videoMedia(params.pn * 100)], info: { media_count: 1 } };
            }
            return [];
        });

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(requestMock.mock.calls.some(call => call[0] === 'fav_resources')).toBe(true);
        expect(page.items.map(song => song.id)).toEqual(['bili-video-100']);
    });

    it('advances paging by consumed ids even when dead entries drop out of infos', async () => {
        // 回归点：收藏夹里的失效稿件不会出现在 infos 响应里。若按"拿到的条目数"推进
        // nextOffset，offset 会和 ids 索引错位（重复拉、漏拉、提前收尾）。
        const allIds = favIds(30);
        const alive = new Set(allIds.filter(entry => entry.id % 2 === 0).map(entry => entry.id));
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation === 'fav_resource_ids') return allIds;
            const requested = String(params.resources || '')
                .split(',')
                .map(entry => Number(entry.split(':')[0]))
                .filter(id => alive.has(id));
            return requested.map(id => videoMedia(id));
        });

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(page.items).toHaveLength(15);
        // 30 个 id 全部消费掉，哪怕只有 15 个有效
        expect(page.nextOffset).toBe(30);
        expect(page.hasMore).toBe(false);
    });

    it('rejects a 合集 folder cached without its author mid rather than returning an empty wall', async () => {
        const stale = { ...seasonFolder, providerData: { mlid: '1797750', fid: '0', favType: 21 } };

        await expect(getPlaylistTracks('1797750', 50, 0, stale)).rejects.toMatchObject({
            code: 'invalid-response',
            message: expect.stringMatching(/owner mid/iu),
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('carries folder type, author and cover through getUserPlaylists so tracks can be routed', async () => {
        // 回归点：list-all 不带 cover，网格里的文件夹封面全靠分页版 created/list。
        requestMock.mockImplementation(async (operation: string) => (operation === 'fav_created_paged'
            ? { count: 1, list: [{ id: 1234, fid: 1234, title: '默认收藏夹', media_count: 2, cover: 'http://i0.hdslb.com/fav/1234.png', upper: { mid: 42, name: '我自己' } }] }
            : { list: [{ id: 1797750, fid: 0, title: '【悬念剧场】', media_count: 83, type: 21, cover: 'http://i0.hdslb.com/fav/1797750.png', upper: { mid: 3546378898770447, name: '竖了个三' } }] }));

        const page = await bilibiliProvider.library!.getUserPlaylists('42', 50, 0);

        expect(page.items.map(c => c.coverUrl)).toEqual([
            'https://i0.hdslb.com/fav/1234.png',
            'https://i0.hdslb.com/fav/1797750.png',
        ]);

        expect(page.items.map(collection => collection.providerData?.favType)).toEqual([0, 21]);
        expect(page.items[1].providerData).toMatchObject({
            ownerMid: '3546378898770447',
            ownerName: '竖了个三',
        });
        // 自己的收藏夹没有 type 字段，必须留在 fav_resources 通路上
        expect(page.items[0].providerData).toMatchObject({ ownerMid: '42' });
    });
});

describe('bilibiliProvider playback', () => {
    beforeEach(() => {
        requestMock.mockReset();
    });

    it('carries the video uploader through the bridge payload', async () => {
        // 回归点：以前判断用 upper、取值用 owner，两个字段都不存在，歌手名恒为占位串。
        requestMock.mockResolvedValue({
            bvid: 'BV42',
            avid: 42,
            cid: 7,
            title: '标题',
            pic: 'http://i0.hdslb.com/bfs/archive/42.jpg',
            ownerMid: 7,
            ownerName: '上传者',
            pages: [{ cid: 7, part: '1', duration: 100 }],
        });

        const song = await bilibiliProvider.playback!.getSongDetail('video:42');

        expect(song?.artists).toEqual([{ id: '7', name: '上传者' }]);
        expect(song?.album?.coverUrl).toBe('https://i0.hdslb.com/bfs/archive/42.jpg');
        expect(song?.durationMs).toBe(100_000);
    });
});
