'use client';

import { useState, useEffect, useCallback } from 'react';
import { getUnreadNotifications, markNotificationRead, markAllNotificationsRead } from '@/app/actions/notification-queries';
import Link from 'next/link';

export function NotificationBell() {
  const [notifications, setNotifications] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);

  const fetchNotifications = useCallback(async () => {
    try {
      const { data } = await getUnreadNotifications();
      const prev = notifications.length;
      setNotifications(data || []);

      // 浏览器弹窗：有新通知时触发
      if (hasPermission && data && data.length > prev && prev > 0) {
        const latest = data[0];
        new Notification('订单节拍器', {
          body: latest.title || latest.message,
          icon: '/icon-192.png',
        });
      }
    } catch {
      // ignore
    }
  }, [hasPermission, notifications.length]);

  // 请求浏览器通知权限
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        setHasPermission(true);
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => setHasPermission(p === 'granted'));
      }
    }
  }, []);

  // 轮询未读通知（每15秒，保证催办能及时弹出）
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  const handleMarkRead = async (id: string) => {
    await markNotificationRead(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const handleMarkAllRead = async () => {
    await markAllNotificationsRead();
    setNotifications([]);
    setOpen(false);
  };

  const count = notifications.length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
        title="通知"
      >
        <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-80 max-w-sm bg-white rounded-xl shadow-xl border border-gray-200 z-50 max-h-96 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <span className="text-sm font-semibold text-gray-900">通知 ({count})</span>
              {count > 0 && (
                <button onClick={handleMarkAllRead} className="text-xs text-indigo-600 hover:text-indigo-700">
                  全部已读
                </button>
              )}
            </div>
            <div className="overflow-y-auto max-h-72">
              {notifications.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">暂无新通知</p>
              ) : (
                notifications.map(n => (
                  <div key={n.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{n.title}</p>
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.message}</p>
                        <div className="flex items-center gap-2 mt-1.5">
                          {n.related_order_id && (
                            <Link
                              href={`/orders/${n.related_order_id}?tab=progress`}
                              onClick={() => { handleMarkRead(n.id); setOpen(false); }}
                              className="text-xs text-indigo-600 hover:text-indigo-700"
                            >
                              查看订单 →
                            </Link>
                          )}
                          <span className="text-xs text-gray-300">
                            {new Date(n.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleMarkRead(n.id)}
                        className="text-xs text-gray-400 hover:text-gray-600 flex-shrink-0 mt-0.5"
                        title="标记已读"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
