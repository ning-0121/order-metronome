'use client';

/**
 * Order Intake 模式选择器（Order Intake · dual-mode）
 *
 * PO-first（主）+ Legacy manual（回退）。两者都可用；PO-first 仅软引导，不阻断 legacy。
 * 纯呈现：只切换渲染，不含任何业务逻辑。
 */

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { listCustomerPOsForIntake } from '@/app/actions/order-intake-read';
import { POOrderForm } from './POOrderForm';
import { LegacyOrderForm } from './LegacyOrderForm';

type Mode = 'po' | 'legacy';

export function OrderIntakeModeSelector({ showPrice = false }: { showPrice?: boolean }) {
  const searchParams = useSearchParams();
  const initialPo = searchParams.get('po'); // P1a:从 PO 页「从此 PO 建单」带过来
  const [mode, setMode] = useState<Mode>(initialPo ? 'po' : 'legacy'); // 带 ?po= 直接进 PO 模式,否则默认回退
  const [hasPo, setHasPo] = useState(false);

  useEffect(() => {
    // 软 PO-first：存在 PO → 默认进 PO 模式（不阻断 legacy）
    listCustomerPOsForIntake(1).then((r) => {
      if ((r.data?.length || 0) > 0) { setHasPo(true); if (!initialPo) setMode('po'); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      {/* PO-first 软引导横幅 */}
      <div className="mb-4 rounded-xl bg-indigo-50 border border-indigo-200 p-3 text-sm text-indigo-700">
        本订单系统以 <b>PO 驱动</b>为主路径（订单从已审批报价快照派生）。手工录入为 <b>legacy 回退</b>模式，仍可用。
      </div>

      {/* 模式切换 */}
      <div className="mb-6 inline-flex rounded-xl border border-gray-200 bg-white p-1">
        <button
          onClick={() => setMode('po')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'po' ? 'bg-emerald-600 text-white' : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          🟢 从 PO 创建{!hasPo && <span className="ml-1 text-[10px] opacity-70">（暂无 PO）</span>}
        </button>
        <button
          onClick={() => setMode('legacy')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'legacy' ? 'bg-amber-500 text-white' : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          🟡 手工录入（legacy）
        </button>
      </div>

      {/* 条件渲染：两条路径逻辑各自不变 */}
      {mode === 'po' ? <POOrderForm initialPoId={initialPo || undefined} /> : <LegacyOrderForm showPrice={showPrice} />}
    </div>
  );
}
