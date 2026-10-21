import { beforeEach, describe, expect, it } from 'vitest';

// test/unit/stores/addToPlaylistSubject.test.ts
// The picker can be asked about one particular song rather than the one playing: the + on a search
// result opens it for that row. The subject is what tells the picker which song its folders belong
// to, so it has to be set on open and cleared on close - a leftover subject would make the star
// button (which asks about the song on screen) answer for an old search row instead.

const { openAddToPlaylist, openAddToPlaylistForSong, useAddToPlaylistStore } =
    await import('@/stores/useAddToPlaylistStore');

const song = { id: 'bili-video-117346878490933', name: 'world.execute(me)' } as never;

beforeEach(() => {
    useAddToPlaylistStore.getState().close();
});

describe('add-to-playlist subject', () => {
    it('asks about the song on screen when opened without one', () => {
        openAddToPlaylist();
        const state = useAddToPlaylistStore.getState();
        expect(state.isOpen).toBe(true);
        expect(state.subject).toBeNull();
    });

    it('keeps the row it was opened for', () => {
        openAddToPlaylistForSong(song);
        const state = useAddToPlaylistStore.getState();
        expect(state.isOpen).toBe(true);
        expect(state.subject).toBe(song);
    });

    it('drops the subject on close, so the next open cannot inherit it', () => {
        openAddToPlaylistForSong(song);
        useAddToPlaylistStore.getState().close();
        const state = useAddToPlaylistStore.getState();
        expect(state.isOpen).toBe(false);
        expect(state.subject).toBeNull();

        openAddToPlaylist();
        expect(useAddToPlaylistStore.getState().subject).toBeNull();
    });
});
