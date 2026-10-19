import { getFromCacheWithMigration, saveToCache } from '../services/db';
import { getSongResourceCacheKey } from '../services/onlineMusic/resourceKeys';
import type { OnlineLyricsState, SongResult } from '../types';
import type { MigrationResult } from './lyrics/renderHints';
import { migrateLyricDataRenderHints as migrateLyrics } from './lyrics/renderHints';
import { isPureMusicLyricText } from './lyrics/pureMusic';

// src/utils/onlineLyricsState.ts

const ONLINE_LYRICS_STATE_SUFFIX = '_state';

const migrateOnlineLyricsState = (value: OnlineLyricsState): MigrationResult<OnlineLyricsState> => {
    const importedMigration = migrateLyrics(value.importedLyrics);
    const overrideMigration = migrateLyrics(value.onlineOverrideLyrics);

    return {
        value: {
            ...value,
            importedLyrics: importedMigration.value,
            onlineOverrideLyrics: overrideMigration.value,
        },
        changed: importedMigration.changed || overrideMigration.changed,
    };
};

export const getOnlineLyricsStateCacheKey = (song: SongResult) =>
    `${getSongResourceCacheKey('lyric', song)}${ONLINE_LYRICS_STATE_SUFFIX}`;

/**
 * The keys an entry for this song could have been written under before `sourceRef` was reliable.
 *
 * A song rebuilt without `sourceRef` was read as Netease, so an entry saved for a Bilibili track
 * landed under `lyric_online:netease:bili-video-<avid>_state` while the next play looked for
 * `lyric_online:bilibili:video:<avid>_state`. Both spellings mean the same track, and the wrong
 * one is not worth losing a hand-picked lyric over: read falls back through them and writes the
 * canonical one.
 */
export const getLegacyOnlineLyricsStateCacheKeys = (song: SongResult): string[] => {
    const bare = String(song?.id ?? '');
    if (!bare) return [];
    const legacy = `${getSongResourceCacheKey('lyric', song)}${ONLINE_LYRICS_STATE_SUFFIX}`;
    const canonical = getOnlineLyricsStateCacheKey(song);
    // The id itself as the media id, which is what the lost-sourceRef path produced.
    const misspelled = `lyric_online:netease:${bare}${ONLINE_LYRICS_STATE_SUFFIX}`;
    return Array.from(new Set([canonical, legacy, misspelled])).filter(key => key !== canonical);
};

export const loadOnlineLyricsState = async (song: SongResult): Promise<OnlineLyricsState | null> => {
    const key = getOnlineLyricsStateCacheKey(song);
    const direct = await getFromCacheWithMigration<OnlineLyricsState>(key, migrateOnlineLyricsState);
    if (direct) return direct;

    for (const fallbackKey of getLegacyOnlineLyricsStateCacheKeys(song)) {
        const legacy = await getFromCacheWithMigration<OnlineLyricsState>(fallbackKey, migrateOnlineLyricsState);
        if (!legacy) continue;
        // Rewrite under the canonical key so this fallback is paid once per song rather than
        // on every play. Awaited: the caller resolves the lyrics right after this.
        await saveToCache(key, legacy);
        return legacy;
    }

    return null;
};

export const saveOnlineLyricsState = async (song: SongResult, state: OnlineLyricsState): Promise<void> => {
    const key = getOnlineLyricsStateCacheKey(song);
    await saveToCache(key, migrateOnlineLyricsState(state).value);
};

/**
 * Stores a lyric an automatic matcher chose, unless a real choice landed while it was searching.
 *
 * Auto-match is slow - it asks every provider - and it decides to run by reading this state when
 * it STARTS. A listener who opens the match window and picks a version during those seconds used
 * to have that pick silently overwritten by the search result that arrived afterwards, stored as
 * an "override" indistinguishable from their own. Re-reading here is what keeps the listener's
 * choice: an override already on disk is theirs (manual picks and imports are the only writers
 * that set one before an automatic match could), so the automatic result is dropped.
 */
export const saveAutoMatchedOnlineLyricsState = async (
    song: SongResult,
    state: OnlineLyricsState,
): Promise<boolean> => {
    const current = await loadOnlineLyricsState(song);
    if (current?.hasOnlineOverride && current.matchedSongId !== state.matchedSongId) {
        return false;
    }
    await saveOnlineLyricsState(song, state);
    return true;
};

export const resolveOnlineLyrics = (
    state: OnlineLyricsState | null | undefined,
    fallbackLyrics: OnlineLyricsState['onlineOverrideLyrics']
) => {
    if (!state) {
        return fallbackLyrics ?? null;
    }

    if (state.lyricsSource === 'imported' && state.importedLyrics) {
        return state.importedLyrics;
    }

    if (state.hasOnlineOverride) {
        return state.onlineOverrideLyrics ?? null;
    }

    return fallbackLyrics ?? null;
};

/**
 * Whether the stored lyrics mean "instrumental", decided the way cached playback decides it:
 * an online match that recorded a verdict is trusted as-is; anything else (an imported file, or a
 * match from before the verdict was stored) falls back to reading the lyric text.
 */
export const resolveOnlineLyricsPureMusic = (
    state: OnlineLyricsState | null | undefined,
    lyricsText: string,
): boolean => (
    state?.lyricsSource === 'online' && typeof state.matchedIsPureMusic === 'boolean'
        ? state.matchedIsPureMusic
        : isPureMusicLyricText(lyricsText)
);

export const getOnlineLyricsSourceLabel = (state: OnlineLyricsState | null | undefined): 'online' | 'imported' =>
    state?.lyricsSource === 'imported' ? 'imported' : 'online';

/**
 * The state to store once auto-match has concluded a track simply has no lyrics.
 *
 * "Every source agrees this one is instrumental" is an ANSWER and has to be persisted like any
 * other match. Storing nothing leaves `hasOnlineOverride` false, which is the flag that decides
 * whether to auto-match at all - so the full multi-provider search runs again on every prefetch
 * pass and every play, forever, for every instrumental in the library.
 *
 * Merged onto whatever was already there rather than replacing it: an imported selection stays
 * imported, and `resolveOnlineLyrics` keeps preferring it, so a background auto-match can never
 * take the listener's own choice away.
 */
export const markOnlineLyricsPureMusic = (
    previous: OnlineLyricsState | null | undefined,
): OnlineLyricsState => ({
    ...previous,
    lyricsSource: previous?.lyricsSource ?? 'online',
    hasOnlineOverride: true,
    // The override IS "there are none". Spelled out rather than left undefined so the stored state
    // reads the same way `resolveOnlineLyrics` will read it.
    onlineOverrideLyrics: null,
    matchedIsPureMusic: true,
});
