import { describe, expect, it } from 'vitest';
import {
    getLegacyOnlineLyricsStateCacheKeys,
    getOnlineLyricsStateCacheKey,
} from '../../../src/utils/onlineLyricsState';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../../src/utils/appPlaybackGuards';
import type { SongResult } from '../../../src/types';

// A Bilibili track as the grid and the queue hand it to playback.
const biliSong = {
    id: 'bili-video-117394223730844',
    name: 'world.execute(me);',
    artists: [{ id: '1', name: 'Mili' }],
    album: { id: '', name: '' },
    durationMs: 210000,
    sourceRef: { kind: 'online', providerId: 'bilibili', mediaId: 'video:117394223730844' },
} as unknown as SongResult;

describe('appPlaybackGuards source inference', () => {
    it('reads a Bilibili provider back off the id when sourceRef is missing', () => {
        // Regression: a rebuilt song without sourceRef was silently treated as Netease, so every
        // source-keyed cache lookup missed the entry it had written a moment earlier.
        const stripped = { id: biliSong.id, name: biliSong.name } as SongResult;
        expect(getPlaybackSourceRef(stripped)).toMatchObject({
            kind: 'online',
            providerId: 'bilibili',
            mediaId: 'video:117394223730844',
        });
        expect(getPlaybackSongKey(stripped)).toBe(getPlaybackSongKey(biliSong));
    });

    it('leaves a plain Netease id alone', () => {
        const netease = { id: '1901371647', name: 'x' } as SongResult;
        expect(getPlaybackSourceRef(netease)).toMatchObject({ providerId: 'netease', mediaId: '1901371647' });
    });
});

describe('online lyrics state fallback keys', () => {
    it('pairs the canonical key with the spelling a lost sourceRef used to write', () => {
        const keys = getLegacyOnlineLyricsStateCacheKeys(biliSong);
        expect(getOnlineLyricsStateCacheKey(biliSong)).toBe('lyric_online:bilibili:video:117394223730844_state');
        expect(keys).toContain('lyric_online:netease:bili-video-117394223730844_state');
        expect(keys).not.toContain(getOnlineLyricsStateCacheKey(biliSong));
    });
});
