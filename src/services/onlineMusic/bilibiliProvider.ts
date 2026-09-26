import type {
    AudioQualityPreference,
    MediaId,
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderCollection,
    ProviderLyricsResult,
    ProviderPage,
    ProviderUser,
    QrLoginState,
} from '../../types/onlineMusic';
import type { JsonValue } from '../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import { fetchBilibiliBridgeStatus, getBilibiliTransportAvailability, requestBilibili } from './bilibiliTransport';

// src/services/onlineMusic/bilibiliProvider.ts
// Adapter for the Bilibili bridge in the Electron main process: QR scan login, favorite folders
// and seasons, audio/video playback, and lyrics borrowed from NetEase.
// Search, albums, artists, recommendations and mutations are not implemented — capabilities stay
// honest so the Omni layer never routes a request the adapter cannot serve.

const QR_TTL_MS = 180_000; // Bilibili scan codes expire after ~3 minutes (poll code 86038).

// 风控冷却是进程级状态：一旦触发，这段时间里所有 B站 请求都会失败。把它暴露出去，UI 才能
// 显示"风控冷却中，约 xx 秒"，并且在冷却期内干脆不要发请求——撞上去只会把封禁拖更长。
let riskControlState = { cooling: false, remainingMs: 0 };

export const getBilibiliRiskControlState = () => riskControlState;

export const refreshBilibiliRiskControlState = async () => {
    const status = await fetchBilibiliBridgeStatus();
    if (status) {
        riskControlState = {
            cooling: Boolean(status.cooling),
            remainingMs: Number(status.remainingMs) || 0,
        };
    }
    return riskControlState;
};

// Bilibili APIs return http:// image URLs; http subresources are blocked in the app context, which
// renders every cover as a black card. hdslb.com and its CDN mirrors all serve https, so upgrade.
const toHttpsImageUrl = (url: unknown): string => {
    const text = String(url || '');
    return text ? text.replace(/^http:\/\//, 'https://') : '';
};

type BridgeLoginStatusResult = {
    authenticated: boolean;
    user?: {
        id: number | string;
        nickname: string;
        avatarUrl: string;
        vipType?: number;
    };
};

const getLoginStatus = async (): Promise<ProviderUser | null> => {
    const result = await requestBilibili<BridgeLoginStatusResult>('login_status');
    if (!result?.authenticated || !result.user) return null;
    return {
        id: result.user.id,
        nickname: result.user.nickname,
        avatarUrl: toHttpsImageUrl(result.user.avatarUrl) || undefined,
        vipType: result.user.vipType,
    };
};

const logout = async (): Promise<void> => {
    await requestBilibili('logout');
};

// No getQrLoginMethods: the account store treats a provider without declared methods as a
// single-step QR flow, which is exactly what Bilibili offers (one scan-code channel).
const getQrKey = async (): Promise<string> => {
    const data = await requestBilibili<{ url: string; qrcode_key: string }>('qr_generate');
    if (!data?.qrcode_key) {
        throw new OnlineProviderError('invalid-response', 'Bilibili QR generate returned no key', 'bilibili');
    }
    return String(data.qrcode_key);
};

const createQr = async (key: string): Promise<string> => {
    const data = await requestBilibili<{ imageUrl: string }>('qr_image', { key });
    if (!data?.imageUrl) {
        throw new OnlineProviderError('invalid-response', 'Bilibili QR image was not produced', 'bilibili');
    }
    return data.imageUrl;
};

const checkQr = async (key: string): Promise<QrLoginState> => {
    const data = await requestBilibili<{ state: string; message?: string }>('qr_poll', { key });
    const state = data?.state;
    if (state === 'confirmed') return { state: 'confirmed' };
    if (state === 'scanned') return { state: 'scanned' };
    if (state === 'waiting') return { state: 'waiting' };
    if (state === 'expired') return { state: 'expired' };
    return { state: 'error', message: data?.message || 'Unknown QR polling state' };
};

const cancelQr = async (_key: string): Promise<void> => {
    // Bilibili has no explicit QR cancel endpoint; unscanned keys simply expire server-side.
    // The contract requires idempotent success, so this resolves without network I/O.
};

// --- Library ---

// Fav media types that map to one playable song. 2 = video upload, 12 = audio track.
// 21 (video collections) and 24 (movies) are containers, not songs, so they are filtered out.
const PLAYABLE_FAV_MEDIA_TYPES = new Set([2, 12]);

// 收藏夹条目类型 21 = 订阅来的视频「合集」。它只是一个容器：fav/resource/list 对它返回 code 0 +
// 空 medias，内容得走 seasons_archives_list。
const SEASON_FAV_TYPE = 21;
// fav/resource/list 在 ps>20 时直接回 code -400（实测 ps=50/100 都是）。
const FAV_PAGE_SIZE = 20;
// 合集接口实测 ps=100 也能一次给满；取 50 是因为它正好整除曲墙的两档批量
// （首屏 150、后台 1000），分页边界永不重叠，不会回头重取已经显示的条目。
const SEASON_PAGE_SIZE = 50;
// 一次 UI 翻页最多替我们打这么多个上游分页请求：GridView 后台补全会单次索要 1000 条，
// 不截断就是一次操作换来几十连续请求，B站 在第 7 页左右回 412。多出来的条目由调用方
// 拿着 nextOffset/hasMore 再要一次，节奏交给上层的循环间隔去控制。
const MAX_PAGES_PER_CALL = 3;
// 走 ids + infos 两阶段时的批量上限：一次调用最多补 4 批 × 20 条。比逐页 list 少一半往返，
// 而且总数来自 ids，不需要靠"页面返回不足一页"去猜是否到底。
const FAV_INFO_BATCH_SIZE = 20;
const MAX_INFO_BATCHES_PER_CALL = 4;
// ids 列表在一次浏览会话里是稳定的，缓存住可以省掉每次翻页的一个额外请求。
const FAV_IDS_CACHE_TTL_MS = 10 * 60 * 1000;
const favIdsCache = new Map<string, { at: number; entries: { id: string; type: number; bvid: string }[] }>();

// 收藏夹列表一刷新，之前缓存的条目身份就必须作废：用户可能刚收藏/取消了歌。
export const clearBilibiliFavIdsCache = (mediaId?: string) => {
    if (mediaId) favIdsCache.delete(mediaId);
    else favIdsCache.clear();
};

const normalizeFavMediaSong = (media: any): UnifiedSong | null => {
    const mediaType = Number(media?.type);
    if (!PLAYABLE_FAV_MEDIA_TYPES.has(mediaType)) return null;
    const rawId = media?.id;
    if (rawId === undefined || rawId === null || rawId === '') return null;
    const id = String(rawId);
    const kind = mediaType === 12 ? 'audio' : 'video';
    const bvid = String(media?.bvid || media?.bv_id || '');
    const providerData: Record<string, JsonValue> = { kind, favType: mediaType };
    if (kind === 'audio') providerData.songid = id;
    if (kind === 'video') {
        providerData.avid = id;
        if (bvid) providerData.bvid = bvid;
    }
    return {
        id: `bili-${kind}-${id}`,
        name: String(media?.title || ''),
        artists: [{
            id: media?.upper?.mid ?? '',
            name: String(media?.upper?.name || '未知上传者'),
        }],
        album: {
            id: '',
            name: '',
            ...(media?.cover ? { coverUrl: toHttpsImageUrl(media.cover) } : {}),
        },
        durationMs: Math.max(0, Number(media?.duration) || 0) * 1000,
        sourceRef: {
            kind: 'online',
            providerId: 'bilibili',
            mediaId: `${kind}:${id}`,
            providerData,
        },
    };
};

const normalizeFavFolder = (folder: any, owned?: boolean): ProviderCollection | null => {
    const id = folder?.id ?? folder?.fid;
    if (id === undefined || id === null || id === '') return null;
    const favType = Number(folder?.type) || 0;
    const ownerMid = String(folder?.upper?.mid ?? folder?.mid ?? '');
    const ownerName = String(folder?.upper?.name || '');
    return {
        providerId: 'bilibili',
        id,
        name: String(folder?.title || '未命名收藏夹'),
        type: 'playlist',
        ...(folder?.cover ? { coverUrl: toHttpsImageUrl(folder.cover) } : {}),
        ...(folder?.intro ? { description: String(folder.intro) } : {}),
        trackCount: Number(folder?.media_count) || 0,
        isOwned: Number(folder?.attr ?? 0) >= 0 && folder?.mid !== undefined,
        providerData: {
            mlid: String(id),
            fid: String(folder?.fid ?? id),
            favType,
            ownerMid,
            ownerName,
            ...(owned === undefined ? {} : { owned }),
        },
    };
};

// 合集里的一个视频。字段名和 fav/resource/list 的 media 不同（aid/pic/upper 都不在），
// 作者只能取合集的上传者：archive 本身不带 mid。
const normalizeSeasonArchiveSong = (
    archive: any,
    ownerMid: string,
    ownerName: string,
): UnifiedSong | null => {
    const rawId = archive?.aid ?? archive?.id;
    if (rawId === undefined || rawId === null || rawId === '') return null;
    const avid = String(rawId);
    const bvid = String(archive?.bvid || '');
    const providerData: Record<string, JsonValue> = { kind: 'video', favType: 2, avid };
    if (bvid) providerData.bvid = bvid;
    return {
        id: `bili-video-${avid}`,
        name: String(archive?.title || ''),
        artists: [{ id: ownerMid, name: ownerName || '未知上传者' }],
        album: {
            id: '',
            name: '',
            ...(archive?.pic ? { coverUrl: toHttpsImageUrl(archive.pic) } : {}),
        },
        durationMs: Math.max(0, Number(archive?.duration) || 0) * 1000,
        sourceRef: {
            kind: 'online',
            providerId: 'bilibili',
            mediaId: `video:${avid}`,
            providerData,
        },
    };
};

// --- Playback ---

// sourceRef.mediaId encodes both the fav-entry kind and the raw id: `audio:123` (audio region
// auid) or `video:456` (avid). The fav entry type governs which playurl API applies.
type BilibiliMediaIdentity = { kind: 'audio' | 'video'; rawId: string };

const parseMediaIdentity = (value: unknown): BilibiliMediaIdentity | null => {
    if (value === null || value === undefined) return null;
    const text = String(value);
    const match = text.match(/^(audio|video):(\w+)$/u);
    if (match) return { kind: match[1] as 'audio' | 'video', rawId: match[2] };
    const legacy = text.match(/^bili-(audio|video)-(\w+)$/u);
    if (legacy) return { kind: legacy[1] as 'audio' | 'video', rawId: legacy[2] };
    return null;
};

const mediaIdentityOfSong = (song: SongResult): BilibiliMediaIdentity | null => {
    const sourceRef = song.sourceRef;
    if (sourceRef?.kind === 'online' && sourceRef.providerId === 'bilibili') {
        const identity = parseMediaIdentity(sourceRef.mediaId);
        if (identity) return identity;
        const providerData = sourceRef.providerData || {};
        if (providerData.songid) return { kind: 'audio', rawId: String(providerData.songid) };
        if (providerData.bvid) return { kind: 'video', rawId: String(providerData.avid || '') };
    }
    return parseMediaIdentity(song.id);
};

const normalizeAudioSongDetail = (data: any): UnifiedSong | null => {
    const song = data?.data || data;
    const sid = song?.sid ?? song?.id;
    if (!sid) return null;
    return {
        id: `bili-audio-${sid}`,
        name: String(song?.title || song?.uname || ''),
        artists: [{ id: song?.owner?.mid ?? song?.uid ?? '', name: String(song?.owner?.name ?? song?.uname ?? '未知上传者') }],
        album: { id: '', name: String(song?.album ?? ''), ...(song?.cover ? { coverUrl: toHttpsImageUrl(song.cover) } : {}) },
        durationMs: Math.max(0, Number(song?.duration) || 0) * 1000,
        sourceRef: {
            kind: 'online',
            providerId: 'bilibili',
            mediaId: `audio:${sid}`,
            providerData: { kind: 'audio', favType: 12, songid: String(sid) },
        },
    };
};

const normalizeVideoSongDetail = (view: any): UnifiedSong | null => {
    if (!view?.cid) return null;
    const avid = view.avid || view.aid;
    // UP 主名由主进程透传：原始 view 响应里有 owner，但 renderer 拿不到，之前这里判断用
    // upper、取值用 owner，两边都不存在，结果所有视频稿件的歌手名都显示成占位串。
    const ownerName = String(view?.ownerName || '');
    const ownerMid = String(view?.ownerMid ?? '');
    return {
        id: `bili-video-${avid}`,
        name: String(view.title || ''),
        artists: [{ id: ownerMid, name: ownerName || '未知上传者' }],
        album: { id: '', name: '', ...(view?.pic ? { coverUrl: toHttpsImageUrl(view.pic) } : {}) },
        durationMs: Math.max(0, Number(view?.pages?.[0]?.duration ?? view?.duration ?? 0)) * 1000,
        sourceRef: {
            kind: 'online',
            providerId: 'bilibili',
            mediaId: `video:${avid}`,
            providerData: { kind: 'video', favType: 2, avid: String(avid), bvid: String(view.bvid || '') },
        },
    };
};

const getAudioSource = async (
    song: SongResult,
    quality: AudioQualityPreference,
): Promise<ProviderAudioSource | null> => {
    const identity = mediaIdentityOfSong(song);
    if (!identity) {
        console.warn('[BilibiliProvider] audio-source:missing-identity', { songId: String(song.id) });
        return null;
    }

    let remoteUrl = '';
    let altRemoteUrl = '';
    let expiresAt: number | undefined;
    if (identity.kind === 'audio') {
        const data = await requestBilibili<any>('audio_url', { songid: identity.rawId });
        remoteUrl = String(data?.url || '');
        altRemoteUrl = String(data?.backupUrl || '');
        if (data?.timeoutSec > 0) {
            expiresAt = Date.now() + Math.min(data.timeoutSec, 7200) * 1000;
        }
    } else {
        const sourceRef = song.sourceRef;
        const providerData = ((sourceRef && 'providerData' in sourceRef ? sourceRef.providerData : undefined) || {}) as Record<string, JsonValue>;
        const avid = identity.rawId;
        const bvidHint = String(providerData.bvid || '');
        const view = await requestBilibili<any>('video_view', bvidHint ? { bvid: bvidHint } : { avid });
        const bvid = String(view?.bvid || bvidHint);
        const cid = Number(view?.cid ?? 0);
        if (!cid) {
            console.warn('[BilibiliProvider] audio-source:no-cid', { avid, bvid });
            return null;
        }
        const playData = await requestBilibili<any>('video_playurl', { avid, bvid, cid });
        remoteUrl = String(playData?.url || '');
        altRemoteUrl = String(playData?.backupUrl || '');
        // Dash URLs are short-lived; a conservative 90 minutes matches observed CDN behaviour.
        expiresAt = Date.now() + 90 * 60 * 1000;
    }
    if (!remoteUrl) return null;

    return {
        url: wrapBilibiliStreamUrl(remoteUrl, altRemoteUrl),
        fetchedAt: Date.now(),
        expiresAt,
        quality,
    };
};

const wrapBilibiliStreamUrl = (remoteUrl: string, altUrl?: string): string => (
    remoteUrl
        ? `folia-bili://stream/${encodeURIComponent(remoteUrl)}${altUrl ? `?alt=${encodeURIComponent(altUrl)}` : ''}`
        : ''
);

// --- Lyrics (netease fallback) ---

// Bilibili uploads almost never carry usable lyrics, but the same song usually exists on NetEase.
// The fullscreen stage is lyric-centric, so without a fallback the stage renders as a blank
// surface. Borrow the netease provider's lyrics (including word-by-word lines when available).
const DURATION_MATCH_TOLERANCE_MS = 12_000;

const pickNeteaseLyricsCandidate = (candidates: UnifiedSong[], song: SongResult): UnifiedSong | null => {
    if (candidates.length === 0) return null;
    const songDuration = song.durationMs || 0;
    let best: UnifiedSong | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate) => {
        const diff = Math.abs((candidate.durationMs || 0) - songDuration);
        if (diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
    });
    return bestDiff <= DURATION_MATCH_TOLERANCE_MS ? best : null;
};

const getLyricsWithNeteaseFallback = async (
    song: SongResult,
): Promise<ProviderLyricsResult> => {
    // Lazy import: providerRegistry imports this module, so a top-level import would create a
    // module-initialisation cycle; the registry lookup only happens at request time.
    const { getOnlineMusicProvider } = await import('./providerRegistry');
    const netease = getOnlineMusicProvider('netease');
    let borrowed: ProviderLyricsResult | null = null;
    if (netease?.search && netease.lyrics) {
        try {
            const query = [song.name, song.artists[0]?.name || ''].filter(Boolean).join(' ');
            const page = await netease.search.searchSongs(query, 5, 0);
            const candidate = pickNeteaseLyricsCandidate(page.items, song);
            if (candidate) {
                borrowed = await netease.lyrics.getLyrics(candidate as SongResult);
            }
        } catch (error) {
            console.warn('[BilibiliProvider] lyrics:netease-fallback-failed', {
                name: error instanceof Error ? error.name : 'Error',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // Word-by-word beats line-level lyrics for the fullscreen stage. When the borrowed netease
    // result carries yrc timings, hand them straight over; otherwise probe Folia's shared
    // word-by-word matchers (netease yrc / QQ / kugou / AMLL TTML db) through its own scorer,
    // capped so an optional upgrade never holds playback hostage for long.
    if (borrowed?.lyrics && borrowed.wordByWordText) {
        return { ...borrowed, isPureMusic: false };
    }
    try {
        const { autoMatchBestLyric } = await import('../../utils/lyrics/autoMatchBestLyric');
        const artistName = song.artists.map(artist => artist.name).filter(Boolean).join(', ');
        const match = await Promise.race([
            autoMatchBestLyric(song.name, artistName, song.durationMs, {}),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 8_000)),
        ]);
        if (match && 'lyrics' in match && match.lyrics?.isWordByWord) {
            return {
                lyrics: match.lyrics,
                isPureMusic: false,
                mainText: null,
                wordByWordText: null,
                translationText: null,
                romanizationText: null,
            };
        }
    } catch (error) {
        console.warn('[BilibiliProvider] lyrics:word-by-word-probe-failed', {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
        });
    }

    if (borrowed?.lyrics) {
        return { ...borrowed, isPureMusic: borrowed.isPureMusic };
    }
    // No borrowed lyrics: declare pure-music so the stage renders its instrumental view
    // instead of a blank surface.
    return { lyrics: null, isPureMusic: true };
};

const getUserPlaylists = async (
    userId: MediaId,
    limit: number,
    offset: number,
): Promise<ProviderPage<ProviderCollection>> => {
    const mid = userId;
    // 自建夹走分页版 created/list（ps<=50）：list-all 是轻量接口不带 cover，网格封面全靠它。
    // 订阅夹的 collected/list 本身带 cover，保持一页 70。
    const [createdData, collectedFirstPage] = await Promise.allSettled([
        (async () => {
            const list: any[] = [];
            let pn = 1;
            let count = Number.POSITIVE_INFINITY;
            while (list.length < count && pn <= 4) {
                const data = await requestBilibili<any>('fav_created_paged', { mid, pn, ps: 50 });
                count = Number(data?.count) || 0;
                const entries = Array.isArray(data?.list) ? data.list : [];
                list.push(...entries);
                if (entries.length < 50) break;
                pn += 1;
            }
            return list;
        })(),
        requestBilibili<any>('fav_collected', { mid, pn: 1, ps: 70 }),
    ]);
    const createdList = createdData.status === 'fulfilled' ? (createdData.value ?? []) : [];
    const collectedList = collectedFirstPage.status === 'fulfilled' ? (collectedFirstPage.value?.list ?? []) : [];
    if (createdData.status === 'rejected') {
        console.warn('[BilibiliProvider] fav-created:error', createdData.reason);
    }
    if (collectedFirstPage.status === 'rejected') {
        console.warn('[BilibiliProvider] fav-collected:error', collectedFirstPage.reason);
    }

    const collections = [
        // created/list 的条目顶层没有 mid（UP 主在 upper 里），补上让 isOwned 语义不变。
        // owned 标记驱动 mutations.canAddToPlaylist：B 站只允许往自己创建的夹子里加歌。
        ...createdList.map((entry: any) => normalizeFavFolder({ ...entry, mid: entry?.upper?.mid ?? entry?.mid }, true)),
        ...collectedList.map((entry: any) => normalizeFavFolder(entry, false)),
    ].filter((collection): collection is ProviderCollection => collection !== null);
    // 这是一次真实的收藏夹刷新，之前缓存的条目身份不再可信。
    clearBilibiliFavIdsCache();

    const items = collections.slice(offset, offset + limit);
    return {
        items,
        total: collections.length,
        hasMore: offset + limit < collections.length,
        nextOffset: offset + items.length,
    };
};

// 收藏夹全部条目的身份列表。`resource/ids` 不受 ps<=20 限制，一个请求就能拿到准确总数和
// 所有 {id, type}，之后的详情按显示需要分批补，不必为了知道"还有没有"去多翻一页。
const loadFavIds = async (mediaId: string) => {
    const cached = favIdsCache.get(mediaId);
    if (cached && Date.now() - cached.at < FAV_IDS_CACHE_TTL_MS) return cached.entries;
    const data = await requestBilibili<any>('fav_resource_ids', { mediaId });
    const list = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : []);
    const entries = list
        .filter((entry: any) => PLAYABLE_FAV_MEDIA_TYPES.has(Number(entry?.type)))
        .map((entry: any) => ({
            id: String(entry?.id ?? ''),
            type: Number(entry?.type),
            bvid: String(entry?.bvid || entry?.bv_id || ''),
        }))
        .filter((entry: { id: string }) => Boolean(entry.id));
    favIdsCache.set(mediaId, { at: Date.now(), entries });
    return entries;
};

// 逐页 fav/resource/list 的老通路。ids/infos 任一环节出错时兜底，避免新通路把整个收藏夹
// 变成"拉不出来"。
const getPlaylistTracksByPages = async (
    mediaId: string,
    limit: number,
    offset: number,
): Promise<ProviderPage<UnifiedSong>> => {
    const pageSize = FAV_PAGE_SIZE;
    const startPage = Math.floor(offset / pageSize) + 1;
    const endPage = Math.floor((offset + Math.max(1, limit) - 1) / pageSize) + 1;
    const pageCount = Math.min(endPage - startPage + 1, MAX_PAGES_PER_CALL);

    const songs: UnifiedSong[] = [];
    let total = 0;
    let reachedEnd = false;
    for (let page = startPage; page < startPage + pageCount; page += 1) {
        const data = await requestBilibili<any>('fav_resources', { mediaId, pn: page, ps: pageSize });
        const medias: any[] = Array.isArray(data?.medias) ? data.medias : [];
        total = Number(data?.info?.media_count) || total;
        for (const media of medias) {
            const song = normalizeFavMediaSong(media);
            if (song) songs.push(song);
        }
        if (medias.length < pageSize) {
            reachedEnd = true;
            break;
        }
    }

    const sliceStart = Math.max(0, offset - (startPage - 1) * pageSize);
    const items = songs.slice(sliceStart, sliceStart + limit);
    return {
        items,
        total,
        // 上游还有分页没取完（被 MAX_PAGES_PER_CALL 截断）就如实说 hasMore，调用方自己接着要。
        hasMore: !reachedEnd || songs.length - sliceStart > items.length || offset + items.length < total,
        nextOffset: offset + items.length,
    };
};

const getPlaylistTracks = async (
    id: MediaId,
    limit: number,
    offset: number,
    collection?: ProviderCollection,
): Promise<ProviderPage<UnifiedSong>> => {
    const mediaId = String(id);
    const favType = Number(collection?.providerData?.favType) || 0;
    const ownerMid = String(collection?.providerData?.ownerMid ?? '');
    const ownerName = String(collection?.providerData?.ownerName ?? '');
    const isSeason = favType === SEASON_FAV_TYPE;
    if (isSeason && !ownerMid) {
        // 合集内容只能按作者 mid 取。缺 mid 说明拿到的是这次支持合集之前缓存的收藏夹快照，
        // 刷一次收藏夹就有了——静默返回空列表只会被当成"B站 又挂了"。
        throw new OnlineProviderError(
            'invalid-response',
            'Bilibili season collection has no owner mid; refresh the favorites list',
            'bilibili',
        );
    }
    if (isSeason) {
        // 合集（type 21）只有 season_archives 一条路：fav/resource/* 对它一律返回空。
        const pageSize = SEASON_PAGE_SIZE;
        const startPage = Math.floor(offset / pageSize) + 1;
        const endPage = Math.floor((offset + Math.max(1, limit) - 1) / pageSize) + 1;
        const pageCount = Math.min(endPage - startPage + 1, MAX_PAGES_PER_CALL);

        const songs: UnifiedSong[] = [];
        let total = 0;
        let reachedEnd = false;
        for (let page = startPage; page < startPage + pageCount; page += 1) {
            const data = await requestBilibili<any>('season_archives', {
                seasonId: mediaId, mid: ownerMid, pn: page, ps: pageSize,
            });
            const archives: any[] = Array.isArray(data?.archives) ? data.archives : [];
            total = Number(data?.page?.total) || Number(data?.meta?.total) || total;
            for (const archive of archives) {
                const song = normalizeSeasonArchiveSong(archive, ownerMid, ownerName);
                if (song) songs.push(song);
            }
            if (archives.length < pageSize) {
                reachedEnd = true;
                break;
            }
        }

        const sliceStart = Math.max(0, offset - (startPage - 1) * pageSize);
        const items = songs.slice(sliceStart, sliceStart + limit);
        return {
            items,
            total,
            hasMore: !reachedEnd || songs.length - sliceStart > items.length || offset + items.length < total,
            nextOffset: offset + items.length,
        };
    }

    // 普通收藏夹：ids 拿全部身份 → infos 按显示需要分批补详情。桥那边对只读请求放行到
    // 3 路并发，这些批次是并行发出去的，不再是逐页排队。
    try {
        const entries = await loadFavIds(mediaId);
        const total = entries.length;
        const start = Math.max(0, offset);
        const wanted = entries.slice(start, start + Math.max(1, limit));
        const capped = wanted.slice(0, MAX_INFO_BATCHES_PER_CALL * FAV_INFO_BATCH_SIZE);

        const batches: (typeof entries)[] = [];
        for (let index = 0; index < capped.length; index += FAV_INFO_BATCH_SIZE) {
            batches.push(capped.slice(index, index + FAV_INFO_BATCH_SIZE));
        }

        const songs: UnifiedSong[] = [];
        const results = await Promise.all(batches.map(async (batch) => {
            const data = await requestBilibili<any>('fav_resource_infos', {
                resources: batch.map((entry: { id: string; type: number }) => `${entry.id}:${entry.type}`).join(','),
            });
            const infos: any[] = Array.isArray(data) ? data : [];
            return infos
                // infos 的条目结构和 fav/resource/list 的 media 一致，直接复用归一化
                .map((info: any) => normalizeFavMediaSong({ ...info, bvid: info?.bvid || info?.bv_id }))
                .filter((song): song is UnifiedSong => song !== null);
        }));
        results.forEach(list => songs.push(...list));

        // 分页按"消费掉的 id 数"推进，而不是拿到的条目数：收藏夹里的失效稿件不会出现在
        // infos 响应里，若按条目数推进会让 offset 与 ids 索引错位（重复拉、漏拉、提前收尾）。
        const consumed = capped.length;
        return {
            items: songs,
            total,
            hasMore: start + consumed < total,
            nextOffset: start + consumed,
        };
    } catch (error) {
        console.warn('[BilibiliProvider] fav ids/infos path failed; falling back to paged list', {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
        });
        favIdsCache.delete(mediaId);
        return getPlaylistTracksByPages(mediaId, limit, offset);
    }
};

// 搜索结果归一化：B 站主搜索返回带 <em class="keyword"> 高亮标签的标题、'mm:ss' 时长字符串
const stripHighlight = (title: string): string => String(title || '').replace(/<[^>]+>/g, '');

const parseDurationText = (text: string): number => {
    const parts = String(text || '').split(':').map(Number).reverse();
    return (parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600;
};

const normalizeSearchVideo = (item: any): UnifiedSong | null => {
    const bvid = String(item?.bvid || '');
    const avid = String(item?.aid || '');
    if (!bvid && !avid) return null;
    return {
        id: `bili-video-${avid}`,
        name: stripHighlight(item?.title),
        artists: [{ id: String(item?.mid ?? ''), name: String(item?.author || '未知上传者') }],
        album: { id: '', name: '', ...(item?.pic ? { coverUrl: toHttpsImageUrl(item.pic) } : {}) },
        durationMs: parseDurationText(item?.duration) * 1000,
        sourceRef: {
            kind: 'online',
            providerId: 'bilibili',
            mediaId: `video:${avid}`,
            providerData: { kind: 'video', favType: 2, avid, ...(bvid ? { bvid } : {}) },
        },
    };
};

export const bilibiliProvider: OnlineMusicProvider = {
    id: 'bilibili',
    displayName: 'Bilibili',
    shortName: 'B站',
    getAvailability: () => {
        const availability = getBilibiliTransportAvailability();
        return availability.configured
            ? { configured: true }
            : { configured: false, reason: availability.reason === 'runtime-unavailable' ? 'runtime-unavailable' : 'not-configured' };
    },
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: false,
        artists: false,
        recommendations: false,
        mutations: true,
        wordByWordLyrics: false,
    },
    normalizeSong: () => {
        throw new OnlineProviderError('unsupported', 'Bilibili song normalization is not implemented yet', 'bilibili');
    },
    playback: {
        async getSongDetail(id: MediaId): Promise<UnifiedSong | null> {
            const identity = parseMediaIdentity(id);
            if (!identity) return null;
            if (identity.kind === 'audio') {
                const data = await requestBilibili<any>('audio_song_info', { songid: identity.rawId });
                return normalizeAudioSongDetail(data);
            }
            const view = await requestBilibili<any>('video_view', { avid: identity.rawId });
            if (!view) return null;
            return normalizeVideoSongDetail(view);
        },
        async getAudioSource(song: SongResult, quality: AudioQualityPreference) {
            return getAudioSource(song, quality);
        },
        getAvailability: () => ({ state: 'playable' as const }),
    },
    search: {
        async searchSongs(keyword: string, limit = 20, offset = 0): Promise<ProviderPage<UnifiedSong>> {
            const size = Math.min(Math.max(1, limit), 50);
            const pn = Math.floor(Math.max(0, offset) / size) + 1;
            const data = await requestBilibili<any>('search_video', { keyword, pn, ps: size });
            const rawResults: any[] = Array.isArray(data?.result) ? data.result : [];
            const items = rawResults
                .map(normalizeSearchVideo)
                .filter((song): song is UnifiedSong => song !== null);
            const total = Number(data?.numResults) || items.length;
            return {
                items,
                total,
                hasMore: offset + items.length < total,
                nextOffset: offset + items.length,
            };
        },
    },
    lyrics: {
        getLyrics: getLyricsWithNeteaseFallback,
    },
    normalizeCollection: (raw: unknown, _type?: string) => {
        const collection = normalizeFavFolder(raw);
        if (!collection) {
            throw new OnlineProviderError('invalid-response', 'Not a bilibili fav folder', 'bilibili');
        }
        return collection;
    },
    library: { getUserPlaylists },
    catalog: { getPlaylistTracks },
    auth: {
        getLoginStatus,
        logout,
        getQrKey,
        createQr,
        checkQr,
        cancelQr,
        getQrTtlMs: () => QR_TTL_MS,
    },
    mutations: {
        // B 站只允许操作自己创建的收藏夹（订阅来的夹子/合集只读）
        canAddToPlaylist: (playlist) => {
            const data = playlist.providerData as Record<string, JsonValue> | undefined;
            if (Number(data?.favType) === SEASON_FAV_TYPE) return false;
            return data?.owned === true;
        },
        async updatePlaylistTracks(operation, playlist, tracks) {
            const folderId = String(typeof playlist === 'object' ? playlist.id : playlist);
            for (const track of tracks) {
                const identity = typeof track === 'object'
                    ? mediaIdentityOfSong(track)
                    : parseMediaIdentity(track);
                // 音频区（auid）的收藏走另一套接口，尚未实现；明确报错而不是静默跳过
                if (!identity || identity.kind !== 'video') {
                    throw new OnlineProviderError(
                        'unsupported',
                        `Bilibili fav mutation supports video entries only: ${String(track)}`,
                        'bilibili',
                    );
                }
                const payload = operation === 'add'
                    ? { avid: identity.rawId, addMediaIds: folderId }
                    : { avid: identity.rawId, delMediaIds: folderId };
                await requestBilibili('fav_deal', payload);
            }
        },
    },
};
