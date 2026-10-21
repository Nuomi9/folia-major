import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/bilibiliSearchCover.test.ts
// The search answer gives the picture as a protocol-relative `//i1.hdslb.com/...`. Left as-is it
// resolves against the page, which is file:// in the desktop build, so the request never reaches
// the CDN and every row showed the placeholder instead of a cover. The other endpoints answer with
// http://, which was already upgraded; both spellings go through the same helper.

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlineMusic/bilibiliTransport', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/onlineMusic/bilibiliTransport')>(),
    requestBilibili: requestMock,
    getBilibiliTransportAvailability: () => ({ configured: true }),
}));

const { bilibiliProvider } = await import('@/services/onlineMusic/bilibiliProvider');

const searchAnswer = (pic: string) => ({
    numResults: 1,
    result: [{
        type: 'video',
        aid: 117346878490933,
        bvid: 'BV1xCai6aE9g',
        title: 'world.execute(me)',
        author: 'someone',
        mid: 6992634,
        pic,
        duration: '3:32',
    }],
});

afterEach(() => {
    requestMock.mockReset();
});

const searchCover = async (pic: string): Promise<string> => {
    requestMock.mockResolvedValueOnce(searchAnswer(pic));
    const page = await bilibiliProvider.search!.searchSongs('world.execute', 20, 0);
    return String(page.items[0]?.album?.coverUrl ?? '');
};

describe('Bilibili search covers', () => {
    it('upgrades a protocol-relative picture to https', async () => {
        expect(await searchCover('//i1.hdslb.com/bfs/archive/abc.jpg'))
            .toBe('https://i1.hdslb.com/bfs/archive/abc.jpg');
    });

    it('upgrades an http picture to https', async () => {
        expect(await searchCover('http://i1.hdslb.com/bfs/archive/abc.jpg'))
            .toBe('https://i1.hdslb.com/bfs/archive/abc.jpg');
    });

    it('leaves an https picture alone', async () => {
        expect(await searchCover('https://i1.hdslb.com/bfs/archive/abc.jpg'))
            .toBe('https://i1.hdslb.com/bfs/archive/abc.jpg');
    });
});
