'use client';

/**
 * 工作台锚点(2026-07-03 用户反馈:采购刷新/重新打开系统仍停在上次浏览页)。
 *
 * 规则:「打开系统」→ 回自己的工作台;「工作中」→ 不打扰。
 *  - 首次打开 / 闲置超过 2 小时后再打开(含浏览器恢复上次标签页、次日上班)
 *    → 跳到 /(首页按角色分流:采购→采购中心,管理员→CEO,其他→我的工作台)
 *  - 2 小时内有过操作(点击/键盘)→ 刷新留在原地,不打断正在干的活
 *  - 具体单据深链(订单详情/采购单/报价单,企微群里点进来的)永不劫持
 *
 * 活跃时间落 localStorage(跨标签页共享),30 秒节流写入。
 */

import { useEffect } from 'react';

const KEY = 'qimo_last_active_at';
const IDLE_MS = 2 * 60 * 60 * 1000;   // 闲置 2 小时 = "重新打开系统"
// 不劫持:登录/授权/待审批/API + 具体单据深链(orders/xxx、po/xxx、报价单)
const EXEMPT = /^\/(login|auth|pending-approval|api)|^\/(orders|quoter)\/[^/]+|^\/procurement\/po\/[^/]+/;

export function WorkbenchAnchor() {
  useEffect(() => {
    const now = Date.now();
    const last = Number(localStorage.getItem(KEY) || 0);
    const path = window.location.pathname;
    const stale = !last || now - last > IDLE_MS;
    localStorage.setItem(KEY, String(now));

    if (stale && path !== '/' && !EXEMPT.test(path)) {
      window.location.replace('/');
      return;
    }

    let lastWrite = now;
    const tick = () => {
      const t = Date.now();
      if (t - lastWrite > 30_000) { lastWrite = t; localStorage.setItem(KEY, String(t)); }
    };
    window.addEventListener('pointerdown', tick);
    window.addEventListener('keydown', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.removeEventListener('pointerdown', tick);
      window.removeEventListener('keydown', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return null;
}
