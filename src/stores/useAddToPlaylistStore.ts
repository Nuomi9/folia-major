import { create } from 'zustand';
import type { SongResult } from '../types';

// src/stores/useAddToPlaylistStore.ts
// The "add a song to a playlist" dialog: whether it is up, which song it is about, and whether it
// could do anything if it were.
//
// The dialog used to be a local useState inside UnifiedPanel, next to the star button that opened
// it, which meant it only existed while the player panel was mounted. It is a decision about a
// song, not about the panel, so a command should be able to reach it from anywhere — and that
// requires the open state to outlive the panel.
//
// `subject` is the song the picker is about when it was opened from somewhere that is not the
// player: the + on a search result asks about that row, which is usually not what is playing.
// Absent means "the song on screen", which is what the star button and the command mean.
//
// `availability` is published by the host rather than derived per caller: answering it needs the
// Navidrome playlist list, which is fetched, and two consumers each fetching it would be worse
// than one owner saying what it found.

export type AddToPlaylistAvailability = {
    /** The current song is the sort of song that can go in a playlist at all. */
    isApplicable: boolean;
    /** There is somewhere to put it, and this provider allows it. */
    canAdd: boolean;
    /** Why not, when `canAdd` is false and the answer is worth stating. */
    disabledReason?: string;
};

const UNAVAILABLE: AddToPlaylistAvailability = { isApplicable: false, canAdd: false };

type AddToPlaylistState = {
    isOpen: boolean;
    subject: SongResult | null;
    availability: AddToPlaylistAvailability;
    open: (subject?: SongResult | null) => void;
    close: () => void;
    setAvailability: (availability: AddToPlaylistAvailability) => void;
};

export const useAddToPlaylistStore = create<AddToPlaylistState>((set) => ({
    isOpen: false,
    subject: null,
    availability: UNAVAILABLE,
    open: (subject) => set({ isOpen: true, subject: subject ?? null }),
    close: () => set({ isOpen: false, subject: null }),
    setAvailability: (availability) => set({ availability }),
}));

/** Opens the picker for the song on screen. */
export const openAddToPlaylist = () => useAddToPlaylistStore.getState().open();

/** Opens the picker for one particular song, whether or not it is the one playing. */
export const openAddToPlaylistForSong = (song: SongResult) => useAddToPlaylistStore.getState().open(song);
