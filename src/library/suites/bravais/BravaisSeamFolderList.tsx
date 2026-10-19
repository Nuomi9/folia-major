import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ListChecks, X } from 'lucide-react';
import type { BravaisHomeFolderList } from './bravaisHomeModels';
import { useBravaisReducedTransitions } from './bravaisMotion';
import { getSizedCoverUrl } from '../../../utils/coverUrl';

// src/library/suites/bravais/BravaisSeamFolderList.tsx
// 首页窄缝里的「收藏夹快览」：页签那一列下面的一个按钮，点它在窄缝左侧浮出一列歌单（B 站就是收藏夹），
// 一行 = 名称 + 曲目数 + 封面缩略，点一行和点墙上那张卡走同一条路（层描述的 onOpenItem，起点磁贴规则一致）。
//
// 存在的理由：墙是无限拼贴，二三十个收藏夹要左右转好几圈才找到那一个；快览是平铺的一列，一眼扫完。
// 数据是首页已经拿到的卡片（surface 给），不另发请求，因此不增加任何平台的风控成本。
//
// 浮层用 portal 挂在 document.body 并按按钮的屏幕矩形定位：窄缝本体 overflow: hidden、宽 0（展开靠 transform），
// 在它内部画一个往左伸出的浮层会被裁掉。挂在 body 上还避开祖先的 backdrop-filter（fixed/absolute 会按它测量）。
// 位置在打开时量一次；滚动 / 缩放 / 收起缝 / 组件卸载都关掉它，不做跟随定位——按钮贴着窗口右缘，位置基本不动。
// Esc 关、再点一次按钮关；点浮层外面关（用 pointerdown，比 click 早一拍，不会把那次点击也吃掉）。

const POPOVER_MAX_HEIGHT_VH = 60;
const POPOVER_WIDTH_PX = 300;

const Row: React.FC<{
    entry: BravaisHomeFolderList['entries'][number];
    onOpen: () => void;
}> = ({ entry, onOpen }) => (
    <button
        type="button"
        role="option"
        className="bravais-folder-row"
        data-bravais-folder-row={entry.itemKey}
        onClick={onOpen}
    >
        {entry.coverUrl
            ? <img className="bravais-folder-cover" src={getSizedCoverUrl(entry.coverUrl, 64)} alt="" loading="lazy" />
            : <span className="bravais-folder-cover is-empty" aria-hidden><ListChecks /></span>}
        <span className="bravais-folder-name">{entry.title}</span>
        {entry.countLabel && <span className="bravais-folder-count">{entry.countLabel}</span>}
    </button>
);

const BravaisSeamFolderList: React.FC<{
    /** surface 给的模型：标题、条目与打开动作。空列表也照画（说明文字），按钮只在有条目时出现。 */
    folderList: BravaisHomeFolderList;
    /** 窄缝（compact）还是书脊（不画列表，只画按钮）。 */
    anchorRef: React.RefObject<HTMLButtonElement | null>;
    open: boolean;
    onClose: () => void;
}> = ({ folderList, anchorRef, open, onClose }) => {
    const reduced = useBravaisReducedTransitions();
    const [top, setTop] = useState<number | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // 打开时量一次按钮位置，关闭时把量到的值丢掉（下次打开重新量）。量不到就不画面板。
    useEffect(() => {
        if (!open) { setTop(null); return; }
        const rect = anchorRef.current?.getBoundingClientRect();
        setTop(rect ? Math.round(rect.top) : null);
    }, [open, anchorRef]);

    useEffect(() => {
        if (!open) return undefined;
        const dismiss = (event: PointerEvent) => {
            const panel = panelRef.current;
            const anchor = anchorRef.current;
            if (panel && panel.contains(event.target as Node)) return;
            if (anchor && anchor.contains(event.target as Node)) return; // 按钮自己负责切换
            closeRef.current();
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
        const onScrollOrResize = () => closeRef.current();
        document.addEventListener('pointerdown', dismiss, true);
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', onScrollOrResize);
        window.addEventListener('scroll', onScrollOrResize, true);
        return () => {
            document.removeEventListener('pointerdown', dismiss, true);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onScrollOrResize);
            window.removeEventListener('scroll', onScrollOrResize, true);
        };
    }, [open, anchorRef]);

    // 窄缝贴窗口右缘：面板从按钮左边缘往左展开、顶边对齐按钮，高度到内容为止（上限 maxHeight，里面滚）。
    // 注意不能同时给 top 与 bottom：fixed 元素会被两者钉死成锚点那 36px 高，滚动区被压扁（实测踩过）。
    const style = useMemo(() => {
        if (top === null) return undefined;
        const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight;
        const maxHeight = Math.max(160, Math.round(viewportH * POPOVER_MAX_HEIGHT_VH / 100));
        const rect = anchorRef.current?.getBoundingClientRect();
        return {
            position: 'fixed' as const,
            right: Math.max(8, (typeof window === 'undefined' ? 0 : window.innerWidth) - (rect?.left ?? 0) + 10),
            top: Math.min(top, viewportH - Math.min(maxHeight, 240) - 12),
            width: POPOVER_WIDTH_PX,
            maxHeight,
        };
    }, [top, anchorRef]);

    const onOpenEntry = useCallback((itemKey: string) => {
        folderList.onOpenItem(itemKey);
        closeRef.current();
    }, [folderList]);

    if (typeof document === 'undefined' || top === null) return null;

    return createPortal(
        <AnimatePresence>
            {open && (
                <motion.div
                    ref={panelRef}
                    role="listbox"
                    aria-label={folderList.label}
                    data-bravais-folder-panel
                    className="bravais-folder-panel"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, x: 10, scale: 0.97 }}
                    animate={{ opacity: 1, x: 0, scale: 1, transition: { duration: reduced ? 0.1 : 0.18, ease: 'easeOut' } }}
                    exit={{ opacity: 0, x: 8, transition: { duration: 0.12, ease: 'easeIn' } }}
                    style={style}
                >
                    <div className="bravais-folder-head">
                        <span className="bravais-folder-title">{folderList.label}</span>
                        <span className="bravais-folder-total">{folderList.countLabel}</span>
                        <button type="button" className="bravais-folder-close" onClick={onClose}
                            aria-label={folderList.closeLabel} title={folderList.closeLabel}>
                            <X aria-hidden />
                        </button>
                    </div>
                    {folderList.entries.length === 0 ? (
                        <div className="bravais-folder-empty">{folderList.emptyLabel}</div>
                    ) : (
                        <div className="bravais-folder-scroll">
                            {folderList.entries.map(entry => (
                                <Row key={entry.itemKey} entry={entry} onOpen={() => onOpenEntry(entry.itemKey)} />
                            ))}
                        </div>
                    )}
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
};

export default BravaisSeamFolderList;
