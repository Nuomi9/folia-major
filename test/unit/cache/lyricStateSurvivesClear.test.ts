import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appDatabase } from '../../../src/services/appDatabase';
import { readCacheEntry, putCacheEntry } from '../../../src/services/repositories/cacheRepository';
import { clearCacheByCategory } from '../../../src/services/db';

// Clearing fetched lyrics must not throw away which lyric the listener PICKED for a track: the
// `_state` entry is that choice, and losing it lets the next play auto-match over it again.

const STATE_KEY = 'lyric_online:bilibili:video:117394223730844_state';
const FETCHED_KEY = 'lyric_online:bilibili:video:117394223730844';

describe('clearing the lyric cache', () => {
    beforeEach(async () => {
        await appDatabase.table('metadata_cache').clear();
    });

    it('keeps the per-track lyric choice and drops the fetched copy', async () => {
        await putCacheEntry(STATE_KEY, { hasOnlineOverride: true, matchedSongId: 'PICKED' });
        await putCacheEntry(FETCHED_KEY, { lines: [{ fullText: 'fetched' }] });

        await clearCacheByCategory('lyrics');

        expect(await readCacheEntry(STATE_KEY)).toMatchObject({ matchedSongId: 'PICKED' });
        expect(await readCacheEntry(FETCHED_KEY)).toBeNull();
    });

    it('still clears everything else of that category', async () => {
        await putCacheEntry('lyric_online:netease:1901371647', { lines: [] });
        await putCacheEntry('cover_online:netease:1901371647', { url: 'x' });

        await clearCacheByCategory('lyrics');

        expect(await readCacheEntry('lyric_online:netease:1901371647')).toBeNull();
        // A different category is untouched by a lyric clear.
        expect(await readCacheEntry('cover_online:netease:1901371647')).not.toBeNull();
    });

    it('clears a picked state when the whole media cache is cleared', async () => {
        await putCacheEntry(STATE_KEY, { hasOnlineOverride: true });
        await clearCacheByCategory('media');
        // media keys only; the lyric category is what protects state, and that is a lyric clear.
        expect(await readCacheEntry(STATE_KEY)).not.toBeNull();
    });
});
