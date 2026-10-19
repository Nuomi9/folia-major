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
    | 'fav_created_paged'
    | 'fav_collected'
    | 'fav_resources'
    | 'fav_resource_ids'
    | 'fav_resource_infos'
    | 'season_archives'
    | 'audio_song_info'
    | 'search_video'
    | 'fav_folder_add'
    | 'fav_deal'
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

// 主进程桥的状态里带着风控冷却信息（cooling / remainingMs）。UI 拿到它才能在"加载不出来"
// 的时候说明原因，而不是让用户以为 B站 音源挂了。
export const fetchBilibiliBridgeStatus = async (): Promise<{
    authenticated?: boolean;
    cooling?: boolean;
    remainingMs?: number;
} | null> => {
    const bridge = getBilibiliBridge();
    if (!bridge) return null;
    try {
        const status = await bridge.getBilibiliApiStatus() as {
            authenticated?: boolean;
            cooling?: boolean;
            remainingMs?: number;
        } | null;
        return status || null;
    } catch {
        return null;
    }
};

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
