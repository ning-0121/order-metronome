'use client';

import { useEffect } from 'react';
import { isChunkLoadError, selfHealReload } from '@/lib/utils/chunkReload';

/**
 * 全局「丢页面」自愈兜底 —— 根治部署后 "This page couldn't load"。
 *
 * 背景:系统在生产中高频部署。每次部署后,构建产物(JS chunk / RSC payload)的
 * hash 都变。用户开着的旧标签页里仍持有旧 chunk 引用,一旦导航/切 tab 去加载一个
 * 已经不存在的旧 chunk,就会抛 ChunkLoadError → 浏览器/框架显示 "This page
 * couldn't load",所有人被卡住。
 *
 * 对策:全局监听 chunk 加载失败,自动整页重载一次 —— 重载会拉到最新构建,自愈。
 * 护栏:同一会话短时间内只自愈一次(sessionStorage 记时戳),避免真·坏页时无限重载。
 *
 * 这是纯客户端安全网,不写任何数据,符合「AI/系统不自主写库」铁律。
 */
export function ChunkErrorReloader() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      // <script>/chunk 加载失败会以 error 事件冒到 window
      if (isChunkLoadError(e?.error) || isChunkLoadError(e?.message)) {
        selfHealReload();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      // 动态 import() 失败(切 tab 懒载模块等)以 unhandledrejection 出现
      if (isChunkLoadError(e?.reason)) {
        selfHealReload();
      }
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
