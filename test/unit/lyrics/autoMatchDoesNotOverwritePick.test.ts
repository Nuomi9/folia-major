import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appDatabase } from '../../../src/services/appDatabase';
import {
    loadOnlineLyricsState,
    saveAutoMatchedOnlineLyricsState,
    saveOnlineLyricsState,
} from '../../../src/utils/onlineLyricsState';
import type { SongResult } from '../../../src/types';

// The listener's own lyric pick must survive an automatic match that was already running when
// they made it. Auto-match reads the state to decide to run, spends seconds searching, then used
// to write its result over whatever landed in between.

const song = {
    id: 'bili-video-117394223730844',
    name: 'world.execute(me);',
    artists: [{ id: '1', name: 'Mili' }],
    album: { id: '', name: '' },
    durationMs: 210000,
    sourceRef: { kind: 'online', providerId: 'bilibili', mediaId: 'video:117394223730844' },
} as unknown as SongResult;

const lyrics = (marker: string) => ({
    lines: [{ startTime: 0, endTime: 4000, fullText: marker, words: [] }],
} as any);

const pick = {
    lyricsSource: 'online' as const,
    hasOnlineOverride: true,
    matchedSongId: 'PICKED-BY-LISTENER',
    matchedLyricsSource: 'netease' as const,
    onlineOverrideLyrics: lyrics('PICKED'),
};

const autoResult = {
    lyricsSource: 'online' as const,
    hasOnlineOverride: true,
    matchedSongId: 'AUTO-MATCHED',
    matchedLyricsSource: 'qq' as const,
    onlineOverrideLyrics: lyrics('AUTO'),
};

describe('auto-match vs the listener pick', () => {
    beforeEach(async () => {
        await appDatabase.table('metadata_cache').clear();
    });

    it('keeps the pick that landed while the search was running', async () => {
        await saveAutoMatchedOnlineLyricsState(song, autoResult).catch(() => {});
        // Listener picks during the search window.
        await saveOnlineLyricsState(song, pick);
        // The search now tries to store its result.
        const stored = await saveAutoMatchedOnlineLyricsState(song, autoResult);

        expect(stored).toBe(false);
        const state = await loadOnlineLyricsState(song);
        expect(state?.matchedSongId).toBe('PICKED-BY-LISTENER');
        expect(state?.matchedLyricsSource).toBe('netease');
    });

    it('stores the auto result when nothing was picked', async () => {
        const stored = await saveAutoMatchedOnlineLyricsState(song, autoResult);
        expect(stored).toBe(true);
        expect((await loadOnlineLyricsState(song))?.matchedSongId).toBe('AUTO-MATCHED');
    });

    it('lets the same match be re-stored (idempotent re-run)', async () => {
        await saveAutoMatchedOnlineLyricsState(song, autoResult);
        const again = await saveAutoMatchedOnlineLyricsState(song, autoResult);
        expect(again).toBe(true);
    });
});
