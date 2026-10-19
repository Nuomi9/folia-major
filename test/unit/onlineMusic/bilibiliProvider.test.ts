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

    it('reads an ordinary favorite folder through the paged list, like biu does', async () => {
        // 回归点：resource/infos 是 B站 风控最敏感的接口之一（实测 2 首歌的收藏夹也会 412），
        // 所以主路径只走 fav/resource/list——它一页 20 条、一次给全字段，不需要第二步补详情。
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation !== 'fav_resources') return [];
            return { medias: [videoMedia(params.pn * 10)], info: { media_count: 1 } };
        });

        const page = await getPlaylistTracks('1234', 20, 0, favFolder);

        expect(requestMock.mock.calls.map(call => call[0])).toEqual(['fav_resources']);
        expect(requestMock.mock.calls[0][1]).toMatchObject({ mediaId: '1234', pn: 1, ps: 20 });
        expect(page.items.map(song => song.id)).toEqual(['bili-video-10']);
        expect(page.total).toBe(1);
        expect(page.hasMore).toBe(false);
    });

    it('caps how many upstream pages one call may fetch', async () => {
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation !== 'fav_resources') return [];
            // 永远返回满一页，逼出分页上限
            return {
                medias: Array.from({ length: 20 }, (_, i) => videoMedia((params.pn - 1) * 20 + i)),
                info: { media_count: 2000 },
            };
        });

        // 曲墙后台补全一次要 1000 条
        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        // MAX_PAGES_PER_CALL = 3：一次调用最多替调用方打 3 个分页请求，剩下的由它自己接着要。
        expect(requestMock.mock.calls).toHaveLength(3);
        expect(page.items).toHaveLength(60);
        expect(page.total).toBe(2000);
        expect(page.hasMore).toBe(true);
        expect(page.nextOffset).toBe(60);
    });

    it('does not claim more entries than the folder has', async () => {
        requestMock.mockImplementation(async (operation: string, params: any = {}) => {
            if (operation !== 'fav_resources') return [];
            return { medias: Array.from({ length: 5 }, (_, i) => videoMedia(i)), info: { media_count: 5 } };
        });

        const page = await getPlaylistTracks('1234', 1000, 0, favFolder);

        expect(page.items).toHaveLength(5);
        expect(page.hasMore).toBe(false);
    });

    it('normalizes search results: strips highlight tags, parses mm:ss duration', async () => {
        requestMock.mockResolvedValue({
            numResults: 42,
            result: [
                {
                    type: 'video', aid: 777, bvid: 'BV777',
                    title: '【4K】<em class="keyword">我好想你</em> - 苏打绿',
                    author: '音乐私藏馆', mid: 9, duration: '5:01',
                    pic: 'http://i0.hdslb.com/bfs/archive/777.jpg',
                },
                { type: 'live', title: '不相关的直播', duration: '123:45' },
            ],
        });

        const page = await bilibiliProvider.search!.searchSongs('我好想你 苏打绿', 20, 0);

        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
            id: 'bili-video-777',
            name: '【4K】我好想你 - 苏打绿',
            artists: [{ id: '9', name: '音乐私藏馆' }],
            durationMs: 301_000,
            sourceRef: { mediaId: 'video:777', providerData: { bvid: 'BV777' } },
        });
        expect(page.total).toBe(42);
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
