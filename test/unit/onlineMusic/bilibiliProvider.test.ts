import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/bilibiliProvider.test.ts
//
// 锁两件事：订阅来的「合集」收藏夹（folder type 21）必须走 season_archives —— fav/resource/list
// 对它返回空列表，整夹歌曲就是这么"拉不出来"的；以及一次翻页最多打 MAX_PAGES_PER_CALL 个上游
// 分页请求，曲墙后台补全单次索要 1000 条时不能再把它变成 50 连续请求（B站 会回 412）。

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/bilibiliTransport', () => ({
    getBilibiliTransportAvailability: () => ({ configured: true }),
    requestBilibili: requestMock,
}));

import { bilibiliProvider } from '@/services/onlineMusic/bilibiliProvider';
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

const requestedPn = (operation: string) =>
    requestMock.mock.calls.filter(call => call[0] === operation).map(call => Number(call[1].pn));

describe('bilibiliProvider catalog', () => {
    beforeEach(() => {
        requestMock.mockReset();
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

    it('keeps ordinary favorite folders on fav_resources', async () => {
        requestMock.mockResolvedValue({
            medias: [videoMedia(11), videoMedia(12)],
            info: { media_count: 2 },
        });

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(requestMock.mock.calls.map(call => call[0])).toEqual(['fav_resources']);
        expect(requestMock.mock.calls[0][1]).toMatchObject({ mediaId: '1234', pn: 1, ps: 20 });
        expect(page.items.map(song => song.id)).toEqual(['bili-video-11', 'bili-video-12']);
        expect(page.total).toBe(2);
        expect(page.hasMore).toBe(false);
        expect(page.nextOffset).toBe(2);
    });

    it('caps upstream page requests per call and lets the caller keep paging', async () => {
        requestMock.mockImplementation(async (_operation: string, params: any = {}) => ({
            medias: Array.from({ length: 20 }, (_, i) => videoMedia(params.pn * 100 + i)),
            info: { media_count: 1178 },
        }));

        // 曲墙后台补全一次要 1000 条
        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(requestedPn('fav_resources')).toEqual([1, 2, 3]);
        expect(page.items).toHaveLength(60);
        expect(page.hasMore).toBe(true);
        expect(page.nextOffset).toBe(60);

        const next = await getPlaylistTracks('1234', 1000, 60, favFolder);
        expect(requestedPn('fav_resources').slice(3)).toEqual([4, 5, 6]);
        expect(next.items[0].id).toBe('bili-video-400');
    });

    it('does not claim more pages than the folder has', async () => {
        requestMock.mockImplementation(async (_operation: string, params: any = {}) => ({
            medias: params.pn === 1 ? Array.from({ length: 20 }, (_, i) => videoMedia(i)) : [],
            info: { media_count: 20 },
        }));

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(requestedPn('fav_resources')).toEqual([1, 2]);
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

    it('carries folder type and author through getUserPlaylists so tracks can be routed', async () => {
        requestMock.mockImplementation(async (operation: string) => (operation === 'fav_created'
            ? { list: [{ id: 1234, fid: 1234, title: '默认收藏夹', media_count: 2, mid: 42 }] }
            : { list: [{ id: 1797750, fid: 0, title: '【悬念剧场】', media_count: 83, type: 21, upper: { mid: 3546378898770447, name: '竖了个三' } }] }));

        const page = await bilibiliProvider.library!.getUserPlaylists('42', 50, 0);

        expect(page.items.map(collection => collection.providerData?.favType)).toEqual([0, 21]);
        expect(page.items[1].providerData).toMatchObject({
            ownerMid: '3546378898770447',
            ownerName: '竖了个三',
        });
        // 自己的收藏夹没有 type 字段，必须留在 fav_resources 通路上
        expect(page.items[0].providerData).toMatchObject({ ownerMid: '42' });
    });
});
