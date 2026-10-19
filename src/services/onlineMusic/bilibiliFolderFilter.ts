// src/services/onlineMusic/bilibiliFolderFilter.ts
// 只读用户挑出来的那几个收藏夹。
//
// B 站的「收藏夹」在这个应用里就是歌单：`getUserPlaylists` 把自建夹和订阅夹一起列成
// `ProviderCollection`，首页歌单页把每个夹子铺成一张卡。一个账号攒下二三十个夹子之后，
// 真正当音乐听的往往只有一两个，其余的（视频合集、教程、剪辑素材）会把歌单页淹没。
//
// 这里存一份白名单：没有这个键 = 全部显示（默认，跟以前一样）；有这个键 = 只显示列出的 id
// （空数组也是一个有效状态，表示一个都不显示）。存 id 不存名字：B 站允许重名，id 才是身份。
//
// 只在 provider 的 `getUserPlaylists` 一处生效：搜索、已打开的集合、播放都不受影响，
// 隐藏一个夹子不会让它从正在播的队列里消失。

const STORAGE_KEY = 'bilibili_visible_folders';

/** 白名单；`null` 表示没设过，全部显示。 */
export const readBilibiliVisibleFolderIds = (): string[] | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
        return null;
    }
};

export const writeBilibiliVisibleFolderIds = (ids: readonly string[] | null): void => {
    if (typeof window === 'undefined') return;
    try {
        if (ids === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids.map(String))]));
    } catch {
        // 存储不可用时这次改动只留在内存里，和别的设置项一样。
    }
};

/** 按白名单过滤收藏夹；没设过白名单时原样返回。 */
export const filterBilibiliCollections = <T extends { id: unknown }>(collections: readonly T[]): T[] => {
    const only = readBilibiliVisibleFolderIds();
    if (only === null) return [...collections];
    const allowed = new Set(only);
    return collections.filter(collection => allowed.has(String(collection.id)));
};
