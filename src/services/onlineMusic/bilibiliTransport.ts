import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/bilibiliTransport.ts
// Renderer-side boundary for the Bilibili bridge. All network I/O and credential storage happen in
// the Electron main process (electron/bilibiliApiBridge.cjs); the renderer only ever sees
// non-secret results. Web deployments are intentionally unsupported in this first iteration.

export type BilibiliOperation =
    | 'qr_generate'
    | 'qr_image'
    | 'qr_poll'
    | 'finger'
    | 'login_status'
    | 'logout'
    | 'fav_created'
    | 'fav_collected'
    | 'fav_resources'
    | 'season_archives'
    | 'audio_song_info'
    | 'audio_url'
    | 'video_view'
    | 'video_playurl';

export type BilibiliParams = Record<string, string | number | boolean | undefined>;

export const getBilibiliBridge = (): {
    getBilibiliApiStatus: () => Promise<unknown>;
    bilibiliRequest: (operation: BilibiliOperation, params?: BilibiliParams) => Promise<unknown>;
} | null => (
    typeof window !== 'undefined' && window.electron?.bilibiliRequest
        ? window.electron as unknown as {
            getBilibiliApiStatus: () => Promise<unknown>;
            bilibiliRequest: (operation: BilibiliOperation, params?: BilibiliParams) => Promise<unknown>;
        }
        : null
);

export const getBilibiliTransportAvailability = (): { configured: boolean; reason?: 'runtime-unavailable' } => (
    getBilibiliBridge()
        ? { configured: true }
        : { configured: false, reason: 'runtime-unavailable' }
);

export const requestBilibili = async <T = unknown>(
    operation: BilibiliOperation,
    params: BilibiliParams = {},
): Promise<T> => {
    const bridge = getBilibiliBridge();
    if (!bridge) {
        throw new OnlineProviderError(
            'unavailable',
            'The Bilibili bridge is only available in the desktop app',
            'bilibili',
        );
    }
    try {
        return await bridge.bilibiliRequest(operation, params) as T;
    } catch (error) {
        if (error instanceof OnlineProviderError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new OnlineProviderError('network', `Bilibili request failed: ${message}`, 'bilibili', error);
    }
};
