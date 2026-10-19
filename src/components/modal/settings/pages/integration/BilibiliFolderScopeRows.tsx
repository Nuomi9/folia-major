// src/components/modal/settings/pages/integration/BilibiliFolderScopeRows.tsx
// 设置 → 连接与集成：挑哪几个 B 站收藏夹算作歌单。
//
// 首页的歌单页会把账号下所有收藏夹铺成卡片；这个面板把清单列出来，勾上的才进歌单页。
// 一个都没勾 = 一个都不显示；「全部显示」把白名单清掉，回到以前的行为。
//
// 清单直接问桥要（fav_created_paged + fav_collected），不走 provider：provider 的
// getUserPlaylists 已经被这份白名单过滤过，用它列清单会把没勾上的藏起来，再也勾不回来。

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button, Row, Toggle } from '../../kit';
import { SettingsAnchor } from '../../navigation/SettingsAnchorContext';
import { SETTINGS_ANCHOR_DEFINITIONS } from '../../navigation/settingsAnchorModel';
import { requestBilibili } from '../../../../../services/onlineMusic/bilibiliTransport';
import {
    readBilibiliVisibleFolderIds,
    writeBilibiliVisibleFolderIds,
} from '../../../../../services/onlineMusic/bilibiliFolderFilter';

type FolderRow = { id: string; title: string; count: number; owned: boolean };

const loadFolders = async (): Promise<FolderRow[]> => {
    const status = await requestBilibili<{ authenticated?: boolean; user?: { id: number | string } }>('login_status');
    const mid = status?.user?.id;
    if (!status?.authenticated || !mid) return [];
    const [created, collected] = await Promise.allSettled([
        requestBilibili<{ list?: any[] }>('fav_created_paged', { mid: String(mid), pn: 1, ps: 50 }),
        requestBilibili<{ list?: any[] }>('fav_collected', { mid: String(mid), pn: 1, ps: 70 }),
    ]);
    const toRow = (entry: any, owned: boolean): FolderRow => ({
        id: String(entry?.id ?? entry?.fid ?? ''),
        title: String(entry?.title || '未命名收藏夹'),
        count: Number(entry?.media_count) || 0,
        owned,
    });
    const rows = [
        ...(created.status === 'fulfilled' ? (created.value?.list ?? []) : []).map(entry => toRow(entry, true)),
        ...(collected.status === 'fulfilled' ? (collected.value?.list ?? []) : []).map(entry => toRow(entry, false)),
    ];
    return rows.filter(row => Boolean(row.id));
};

const BilibiliFolderScopeRows = () => {
    const { t } = useTranslation();
    const [rows, setRows] = useState<FolderRow[]>([]);
    const [selected, setSelected] = useState<Set<string> | null>(() => {
        const stored = readBilibiliVisibleFolderIds();
        return stored === null ? null : new Set(stored);
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setRows(await loadFolders());
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const all = selected === null;
    const isChecked = (id: string) => all || selected.has(id);

    const toggle = (id: string) => {
        // 第一次勾选时把「全部」展开成显式的全集：取消一个就是取消一个，其余照旧显示。
        const next = new Set(selected ?? rows.map(row => row.id));
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelected(next);
        writeBilibiliVisibleFolderIds([...next]);
    };

    const showAll = () => {
        setSelected(null);
        writeBilibiliVisibleFolderIds(null);
    };

    return (
        <SettingsAnchor
            anchorId={'bilibiliFolders' satisfies keyof typeof SETTINGS_ANCHOR_DEFINITIONS}
            label={t('options.bilibiliFolders') || 'B 站收藏夹'}
        >
            <div className="space-y-3">
                <p className="text-sm opacity-70">
                    {t('bilibiliFolders.description')
                        || '勾上的收藏夹才会出现在首页歌单页。一个都不勾就一个都不显示；「全部显示」恢复原样。'}
                </p>
                <div className="flex items-center gap-2">
                    <Button onClick={() => void refresh()} disabled={loading}>
                        {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                        {t('bilibiliFolders.refresh') || '重新读取'}
                    </Button>
                    <Button onClick={showAll} disabled={all}>
                        {t('bilibiliFolders.showAll') || '全部显示'}
                    </Button>
                </div>
                {error && <p className="text-sm text-red-500">{error}</p>}
                {!loading && !error && rows.length === 0 && (
                    <p className="text-sm opacity-60">{t('bilibiliFolders.empty') || '没有读到收藏夹：先在应用里登录 B 站。'}</p>
                )}
                {rows.map(row => (
                    <Row
                        key={row.id}
                        label={row.title}
                        note={`${row.count} ${t('home.songs') || '首'}${row.owned ? '' : ` · ${t('bilibiliFolders.collected') || '订阅'}`}`}
                    >
                        <Toggle checked={isChecked(row.id)} onChange={() => toggle(row.id)} />
                    </Row>
                ))}
            </div>
        </SettingsAnchor>
    );
};

export default BilibiliFolderScopeRows;
