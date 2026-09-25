// T2: bilibili 可用性与登录态（真实走主进程桥）
(async () => {
    const omni = (await import('/src/services/onlineMusic/omni.ts')).omni;
    const t0 = Date.now();
    const avail = omni.getProviderAvailability('bilibili');
    const t1 = Date.now();
    let user = null, userErr = null;
    try {
        user = await omni.getLoginStatus('bilibili');
    } catch (e) {
        userErr = String(e && e.message || e);
    }
    const t2 = Date.now();
    return JSON.stringify({
        availability: avail,
        loginMs: t2 - t1,
        user: user ? { id: user.id, nickname: user.nickname } : null,
        userErr,
        totalMs: t2 - t0,
    });
})()
