// src/services/bilibiliPlaylistImport.ts
// 网易云歌单 -> B 站收藏夹 的批量导入：逐首搜索（token 相似度 + 时长容差打分，
// 伴奏/翻唱压分）后经 Omni mutations 收藏。进度通过 onProgress 回调上报；
// 撞上 B 站搜索风控时自动等待冷却并重试（最多 2 次）。

import type { UnifiedSong } from '../types';
import { omni } from './onlineMusic/omni';
import { bilibiliProvider } from './onlineMusic/bilibiliProvider';
import { requestBilibili } from './onlineMusic/bilibiliTransport';

export interface ImportProgress {
    current: number;
    total: number;
    song: string;
    phase: 'searching' | 'saving' | 'waiting-risk-control';
}

export interface ImportMatched {
    name: string;
    artist?: string;
    score: number;
    bili: string;
    bvid: string;
}

export interface ImportUnmatched {
    name: string;
    artist?: string;
    bestScore: number;
    bestTitle?: string;
}

export interface ImportFailed {
    name: string;
    error: string;
}

export interface ImportReport {
    folderId: string;
    folderName: string;
    total: number;
    matched: ImportMatched[];
    unmatched: ImportUnmatched[];
    failed: ImportFailed[];
}

export const PLAYLIST_ID_PATTERN = /[?&]id=(\d+)/;
const THRESHOLD = 0.55;
const PER_SONG_DELAY_MS = 1200;
const RISK_CONTROL_RETRY_WAIT_MS = 80_000;

const extractPlaylistId = (raw: string): string | null => {
    const text = String(raw || '').trim();
    return text.match(PLAYLIST_ID_PATTERN)?.[1] ?? (/^\d+$/.test(text) ? text : null);
};

const cleanText = (s: string): string => String(s || '').toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const tokenize = (s: string): Set<string> => new Set(cleanText(s).split(' ').filter(Boolean));

const textSim = (a: string, b: string): number => {
    const A = tokenize(a);
    const B = tokenize(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / Math.max(A.size, B.size);
};

const scoreCandidate = (cand: UnifiedSong, song: UnifiedSong): number => {
    const dur = (cand.durationMs || 0) / 1000;
    const want = (song.durationMs || 0) / 1000;
    let s = textSim(song.name, cand.name) * 0.45;
    if (cleanText(cand.name).includes(cleanText(song.name))) s += 0.2;
    const artist = song.artists?.[0]?.name;
    if (artist && (cleanText(cand.artists?.[0]?.name || '').includes(cleanText(artist))
        || cleanText(cand.name).includes(cleanText(artist)))) s += 0.2;
    const dDiff = Math.abs(dur - want);
    s += dDiff <= 5 ? 0.15 : dDiff <= 15 ? 0.08 : dDiff <= 30 ? 0.02 : 0;
    if (/伴奏|翻唱|cover|纯音乐|铃声|instrumental/i.test(cand.name)) s -= 0.18;
    return s;
};

// 解析网易云歌单链接/ID
export const parsePlaylistId = extractPlaylistId;

// 拉取网易云歌单全部曲目（走 Omni，providerId=netease）
export async function fetchNeteasePlaylist(playlistIdOrUrl: string): Promise<UnifiedSong[]> {
    const id = extractPlaylistId(playlistIdOrUrl);
    if (!id) throw new Error('无法从输入中解析网易云歌单 ID');
    const ref = {
        kind: 'collection' as const,
        providerId: 'netease' as const,
        id,
        collectionType: 'playlist',
        name: '',
        type: 'playlist' as const,
    };
    const songs: UnifiedSong[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard += 1) {
        const page = await omni.getCollectionTracks(ref, { limit: 100, offset });
        const items = page.items || [];
        if (!items.length) break;
        songs.push(...items);
        offset += items.length;
        if (!page.hasMore) break;
    }
    if (!songs.length) throw new Error('歌单为空或不可访问');
    return songs;
}

// 目标收藏夹：同名复用，否则新建（只允许写自己创建的夹子）
export async function ensureBilibiliFolder(name: string): Promise<{ id: string; name: string }> {
    const user = await bilibiliProvider.auth!.getLoginStatus();
    if (!user) throw new Error('B 站未登录，请先在应用内扫码登录 B 站');
    const created = await requestBilibili<any>('fav_created_paged', { mid: user.id, pn: 1, ps: 50 });
    const found = (created?.list || []).find((f: any) => String(f.title) === name);
    if (found) return { id: String(found.id), name };
    const added = await requestBilibili<any>('fav_folder_add', { title: name });
    const id = added?.id ?? added?.folder_id;
    if (!id) throw new Error(`新建收藏夹失败：未返回 id`);
    return { id: String(id), name };
}

// 批量导入主流程
export async function importPlaylistToBilibili(
    songs: UnifiedSong[],
    folderName: string,
    onProgress?: (progress: ImportProgress) => void,
): Promise<ImportReport> {
    if (!songs.length) throw new Error('没有可导入的歌曲');
    const folder = await ensureBilibiliFolder(folderName);
    const folderCollection = {
        providerId: 'bilibili',
        id: folder.id,
        name: folder.name,
        type: 'playlist' as const,
        providerData: { owned: true, favType: 0 },
    };

    const report: ImportReport = {
        folderId: folder.id,
        folderName: folder.name,
        total: songs.length,
        matched: [],
        unmatched: [],
        failed: [],
    };

    for (let index = 0; index < songs.length; index += 1) {
        const song = songs[index];
        // 搜索 + 收藏，遇风控冷却自动等待后重试（最多 2 次）
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                onProgress?.({ current: index + 1, total: songs.length, song: song.name, phase: 'searching' });
                const query = [song.name, song.artists?.[0]?.name].filter(Boolean).join(' ');
                const res = await bilibiliProvider.search!.searchSongs(query, 10, 0);
                let best: UnifiedSong | null = null;
                let bestScore = 0;
                for (const cand of res.items) {
                    const sc = scoreCandidate(cand, song);
                    if (sc > bestScore) { bestScore = sc; best = cand; }
                }
                if (!best || bestScore < THRESHOLD) {
                    report.unmatched.push({
                        name: song.name,
                        artist: song.artists?.[0]?.name,
                        bestScore: Number(bestScore.toFixed(2)),
                        bestTitle: best?.name || undefined,
                    });
                    break;
                }
                onProgress?.({ current: index + 1, total: songs.length, song: best.name, phase: 'saving' });
                await bilibiliProvider.mutations!.updatePlaylistTracks!('add', folderCollection, [best]);
                report.matched.push({
                    name: song.name,
                    artist: song.artists?.[0]?.name,
                    score: Number(bestScore.toFixed(2)),
                    bili: best.name,
                    bvid: String((best.sourceRef as { providerData?: { bvid?: string } })?.providerData?.bvid || ''),
                });
                break;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                if (/风控|RiskControl/.test(msg) && attempt < 2) {
                    onProgress?.({ current: index + 1, total: songs.length, song: song.name, phase: 'waiting-risk-control' });
                    await new Promise(r => setTimeout(r, RISK_CONTROL_RETRY_WAIT_MS));
                    continue;
                }
                report.failed.push({ name: song.name, error: msg.slice(0, 300) });
                break;
            }
        }
        // 逐首间隔：搜索接口对突发敏感
        if (index < songs.length - 1) {
            await new Promise(r => setTimeout(r, PER_SONG_DELAY_MS));
        }
    }
    return report;
}
