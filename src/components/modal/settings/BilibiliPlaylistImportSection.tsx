// src/components/modal/settings/BilibiliPlaylistImportSection.tsx
// 设置面板「集成」区：把网易云歌单批量导入 B 站收藏夹。
// 流程：贴歌单链接 -> 解析预览 -> 选目标收藏夹（默认同名新建）-> 开始 -> 进度与报告。

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Loader2, Play, Square, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import type { UnifiedSong } from '../../../types';
import {
    fetchNeteasePlaylist,
    importPlaylistToBilibili,
    type ImportProgress,
    type ImportReport,
} from '../../../services/bilibiliPlaylistImport';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import { SETTINGS_ANCHOR_DEFINITIONS } from './navigation/settingsAnchorModel';

type Phase = 'idle' | 'parsing' | 'parsed' | 'running' | 'done';

const BilibiliPlaylistImportSection = () => {
    const { t } = useTranslation();
    const [link, setLink] = useState('');
    const [folderName, setFolderName] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [songs, setSongs] = useState<UnifiedSong[]>([]);
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [report, setReport] = useState<ImportReport | null>(null);
    const [running, setRunning] = useState(false);

    const parseError = useMemo(() => {
        if (!link.trim()) return null;
        if (!/[?&]id=\d+/.test(link) && !/^\d+$/.test(link.trim())) return t('bilibiliImport.badLink') || '链接里没有找到歌单 ID（?id=...）';
        return null;
    }, [link, t]);

    const handleParse = useCallback(async () => {
        setError(null);
        setReport(null);
        setPhase('parsing');
        try {
            const list = await fetchNeteasePlaylist(link);
            setSongs(list);
            setFolderName(prev => prev || `${t('bilibiliImport.importedPrefix') || '网易云导入'} · ${list.length}`);
            setPhase('parsed');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('idle');
        }
    }, [link, t]);

    const handleStart = useCallback(async () => {
        setError(null);
        setReport(null);
        setRunning(true);
        setPhase('running');
        try {
            const result = await importPlaylistToBilibili(songs, folderName, setProgress);
            setReport(result);
            setPhase('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('parsed');
        } finally {
            setRunning(false);
            setProgress(null);
        }
    }, [folderName, songs]);

    const stopRequested = running && progress === null && phase === 'running';

    return (
        <SettingsAnchor anchorId={'bilibiliImport' satisfies keyof typeof SETTINGS_ANCHOR_DEFINITIONS} label={t('options.bilibiliImport') || 'B 站歌单导入'}>
            <div className="space-y-4">
                <p className="text-sm opacity-70">
                    {t('bilibiliImport.description') || '把网易云歌单批量导入 B 站收藏夹：逐首在 B 站搜索匹配（标题相似度 + 时长容差），自动收藏到指定收藏夹。全程约每首 2 秒，请保持应用前台运行。'}
                </p>

                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        value={link}
                        onChange={e => setLink(e.target.value)}
                        placeholder={t('bilibiliImport.linkPlaceholder') || '网易云歌单链接或 ID，如 https://music.163.com/playlist?id=...'}
                        className="flex-1 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/10 text-sm outline-none focus:ring-2 focus:ring-blue-400/50"
                        disabled={running}
                    />
                    <button
                        onClick={() => void handleParse()}
                        disabled={running || !link.trim() || Boolean(parseError)}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 flex items-center gap-2"
                    >
                        {phase === 'parsing' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                        {t('bilibiliImport.parse') || '解析歌单'}
                    </button>
                </div>
                {parseError && <p className="text-sm text-red-500">{parseError}</p>}
                {error && <p className="text-sm text-red-500">{error}</p>}

                {phase === 'parsed' || phase === 'running' || phase === 'done' ? (
                    <div className="space-y-3">
                        <p className="text-sm">
                            {t('bilibiliImport.parsed', { count: songs.length }) || `已解析 ${songs.length} 首`}
                        </p>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={folderName}
                                onChange={e => setFolderName(e.target.value)}
                                placeholder={t('bilibiliImport.folderPlaceholder') || '目标 B 站收藏夹名（不存在会自动新建）'}
                                className="flex-1 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/10 text-sm outline-none focus:ring-2 focus:ring-blue-400/50"
                                disabled={running}
                            />
                            <button
                                onClick={() => void handleStart()}
                                disabled={running}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-2"
                            >
                                {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                                {t('bilibiliImport.start') || '开始导入'}
                            </button>
                        </div>

                        {running && progress && (
                            <div className="space-y-1">
                                <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                                    <div
                                        className="h-full bg-emerald-500 transition-all"
                                        style={{ width: `${Math.round((progress.current / Math.max(1, progress.total)) * 100)}%` }}
                                    />
                                </div>
                                <p className="text-xs opacity-70 flex items-center gap-1">
                                    {progress.phase === 'waiting-risk-control' ? <AlertTriangle size={12} /> : <Square size={12} />}
                                    {progress.current}/{progress.total}
                                    {' · '}
                                    {progress.phase === 'waiting-risk-control'
                                        ? (t('bilibiliImport.waitingRiskControl') || 'B 站风控冷却中，自动等待重试…')
                                        : progress.song}
                                </p>
                            </div>
                        )}

                        {report && (
                            <div className="space-y-2 text-sm">
                                <p className="flex items-center gap-1 text-emerald-600">
                                    <CheckCircle2 size={14} />
                                    {t('bilibiliImport.done', {
                                        matched: report.matched.length,
                                        unmatched: report.unmatched.length,
                                        failed: report.failed.length,
                                    }) || `完成：成功 ${report.matched.length} · 未匹配 ${report.unmatched.length} · 失败 ${report.failed.length}`}
                                </p>
                                {report.unmatched.length > 0 && (
                                    <div className="rounded-lg bg-amber-500/10 p-2 space-y-1">
                                        <p className="text-xs font-medium text-amber-600">{t('bilibiliImport.unmatchedTitle') || '未匹配（没有找到足够像的 B 站版本）'}</p>
                                        {report.unmatched.map(u => (
                                            <p key={u.name} className="text-xs opacity-80">
                                                {u.name}{u.artist ? ` - ${u.artist}` : ''}{u.bestTitle ? `（最像：${u.bestTitle}，${u.bestScore}）` : ''}
                                            </p>
                                        ))}
                                    </div>
                                )}
                                {report.failed.length > 0 && (
                                    <div className="rounded-lg bg-red-500/10 p-2 space-y-1">
                                        <p className="text-xs font-medium text-red-500 flex items-center gap-1"><XCircle size={12} />{t('bilibiliImport.failedTitle') || '失败'}</p>
                                        {report.failed.map(f => (
                                            <p key={f.name} className="text-xs opacity-80">{f.name}：{f.error}</p>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ) : null}
            </div>
        </SettingsAnchor>
    );
};

export default BilibiliPlaylistImportSection;
