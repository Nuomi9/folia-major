import { useCallback, useEffect } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { refreshBilibiliRiskControlState } from '../services/onlineMusic/bilibiliProvider';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import type {
    ProviderUser,
} from '../types/onlineMusic';
import {
    clearProviderAccountSnapshot,
} from '../services/onlineMusic/providerAccountCache';

// src/hooks/useBilibiliLibrary.ts
// Hydrates the Bilibili account and its favorite folders on one refresh pass, and refuses to
// touch the API while the main-process bridge is inside a risk-control cooldown.

export const useBilibiliLibrary = () => {
    const updateAccount = useOnlineProviderAccountStore(state => state.updateAccount);
    const clearAccount = useOnlineProviderAccountStore(state => state.clearAccount);

    const clearAuthState = useCallback(async (error?: string) => {
        clearAccount('bilibili', error);
        console.info('[BilibiliLibrary] auth-state-cleared', { reason: error || 'manual-logout' });
        await omni.logout('bilibili').catch(error2 => {
            console.warn('[BilibiliLibrary] provider-logout:error', {
                name: error2 instanceof Error ? error2.name : 'Error',
                message: error2 instanceof Error ? error2.message : String(error2),
            });
        });
        await clearProviderAccountSnapshot('bilibili').catch(() => undefined);
    }, [clearAccount]);

    const checkLoginStatus = useCallback(async (): Promise<ProviderUser | null> => {
        try {
            const user = await omni.getLoginStatus('bilibili');
            if (!user) {
                await clearAuthState();
                console.info('[BilibiliLibrary] login-status:anonymous');
                return null;
            }
            updateAccount('bilibili', {
                status: 'authenticated',
                user,
                hydration: 'ready',
                error: undefined,
            });
            return user;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'bilibili_login_status_failed';
            await clearAuthState('auth-required');
            console.warn('[BilibiliLibrary] login-status:error', {
                name: error instanceof Error ? error.name : 'Error',
                message,
            });
            return null;
        }
    }, [clearAuthState, updateAccount]);

    const refresh = useCallback(async (): Promise<boolean> => {
        const availability = omni.getProviderAvailability('bilibili');
        console.info('[BilibiliLibrary] refresh:start', { configured: availability.configured });
        if (!availability.configured) {
            updateAccount('bilibili', {
                status: 'anonymous',
                user: null,
                error: availability.reason,
                hydration: 'ready',
                freshness: 'fresh',
            });
            return false;
        }
        // 冷却期内不要发任何 B站 请求：发了也只会被桥直接拒掉，还会把退避窗口继续拉长。
        const riskControl = await refreshBilibiliRiskControlState();
        if (riskControl.cooling) {
            updateAccount('bilibili', {
                status: 'anonymous',
                user: null,
                error: 'risk-control',
                hydration: 'ready',
                freshness: 'stale',
            });
            console.info('[BilibiliLibrary] refresh:skipped-risk-control', {
                remainingMs: riskControl.remainingMs,
            });
            return false;
        }

        updateAccount('bilibili', {
            status: 'unknown',
            hydration: 'loading',
            freshness: 'refreshing',
            error: undefined,
        });
        const user = await checkLoginStatus();
        if (!user) return false;
        updateAccount('bilibili', {
            status: 'authenticated',
            user,
            hydration: 'ready',
            freshness: 'fresh',
            error: undefined,
        });
        // Favorite folders are the account's playlist catalog; hydrate them right after the
        // login check so the home surface has collections on the same refresh pass.
        await omni.refreshProviderPlaylists('bilibili').catch(error => {
            console.warn('[BilibiliLibrary] playlists:refresh-failed', {
                name: error instanceof Error ? error.name : 'Error',
                message: error instanceof Error ? error.message : String(error),
            });
        });
        console.info('[BilibiliLibrary] refresh:complete', { hasUserId: Boolean(user.id) });
        return true;
    }, [checkLoginStatus, updateAccount]);

    const logout = useCallback(async () => {
        await clearAuthState();
    }, [clearAuthState]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return { refresh, logout, checkLoginStatus };
};
