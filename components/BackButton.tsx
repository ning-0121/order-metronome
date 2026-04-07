'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface BackButtonProps {
  fromUrl: string;
}

export function BackButton({ fromUrl }: BackButtonProps) {
  const router = useRouter();

  const getLabel = () => {
    if (fromUrl.includes('risk-orders')) return '返回风险订单列表，继续处理其他订单';
    if (fromUrl === '/ceo') return '返回我的节拍';
    if (fromUrl === '/dashboard') return '返回我的工作台';
    if (fromUrl === '/orders') return '返回订单列表';
    if (fromUrl.includes('briefing')) return '返回今日简报';
    return '返回上一页';
  };

  // 如果有明确的 from，用 Link
  if (fromUrl && fromUrl !== '/orders') {
    return (
      <Link
        href={fromUrl}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
      >
        ← {getLabel()}
      </Link>
    );
  }

  // 没有 from 参数时，用浏览器历史后退（适配从任意页面进入的情况）
  return (
    <button
      onClick={() => router.back()}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
    >
      ← 返回上一页
    </button>
  );
}
