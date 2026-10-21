import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/qqLyricSearchFields.test.ts
// The QQ lyric tab builds its own SongResult list, separate from qqNormalize. It used to read the
// numeric id from `info.id`, which the search answer does not carry, so every candidate came back
// with id 0; fetchQQLyrics then refused each one as "Missing song ID or mid" and a lyric picked
// from that tab was never stored. These pin the field names the endpoint actually answers with.
//
// requestQQ posts through the lyric proxy, so the answer is supplied by stubbing fetch.

const answerWith = (songs: unknown[]) => {
    // requestQQ unwraps `request.data`, and requires both codes to be 0.
    const payload = { code: 0, request: { code: 0, data: { body: { item_song: songs } } } };
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    })));
};

afterEach(() => {
    vi.unstubAllGlobals();
});

const { searchQQSongs } = await import('@/services/onlineMusic/qq/qqLyricProvider');

describe('QQ lyric search candidates', () => {
    it('reads the numeric id from songid, not from id', async () => {
        answerWith([{
            // What the endpoint answers: songid + mid, no `id`.
            songid: 435278010,
            mid: '003abcXYZ',
            title: 'MIDNIGHT DEFAULT',
            interval: 216,
            singer: [{ id: 1, name: 'Someone' }],
            album: { id: 12, name: 'Some Album', mid: 'albumMid' },
        }]);

        const songs = await searchQQSongs('MIDNIGHT DEFAULT');

        expect(songs).toHaveLength(1);
        expect(songs[0].id).toBe(435278010);
        expect(songs[0].qqMid).toBe('003abcXYZ');
        expect(songs[0].name).toBe('MIDNIGHT DEFAULT');
    });

    it('falls back to the mid when the answer carries no numeric id', async () => {
        answerWith([{
            mid: '003onlyMid',
            title: 'Only Mid',
            interval: 100,
            singer: [],
        }]);

        const songs = await searchQQSongs('Only Mid');

        // A usable identity rather than 0: fetchQQLyrics rejects a falsy id outright.
        expect(songs[0].id).toBe('003onlyMid');
        expect(songs[0].id).not.toBe(0);
    });

    it('keeps reading `id` when that is all the answer has', async () => {
        answerWith([{ id: 12345, mid: '003withId', title: 'Has Id', interval: 60, singer: [] }]);

        const songs = await searchQQSongs('Has Id');

        expect(songs[0].id).toBe(12345);
    });
});
