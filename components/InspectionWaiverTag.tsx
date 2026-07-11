'use client';

/**
 * 「免验货」标签 — 订单详情页头部快捷开关(2026-07-11 用户拍板)。
 * 出货前验货节点默认要验货报告;本单没有报告 / 客户免验时,业务或 QC 标记「免验货」+填原因,
 * 之后由 QC / 生产主管在验货节点「免报告放行」。颜色定了式的一等豁免,留痕可见。
 * 复用 orders.special_tags(无迁移),写回走 server action(需角色门禁 + 原因),与 [[color-pending]] 同理。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { INSPECTION_WAIVED_TAG } from '@/lib/domain/inspectionWaiver';
import { setInspectionWaiver } from '@/app/actions/inspection-waiver';

interface Props {
  orderId: string;
  initialTags: string[];
  /** 业务 / QC / 生产主管 / admin / 订单负责人 可操作 */
  canEdit: boolean;
}

export function InspectionWaiverTag({ orderId, initialTags, canEdit }: Props) {
  const router = useRouter();
  const [tags, setTags] = useState<string[]>(initialTags || []);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isMarked = tags.includes(INSPECTION_WAIVED_TAG);

  function toggle() {
    if (!canEdit || pending) return;
    setError(null);

    if (!isMarked) {
      // 设置:必填原因
      const reason = window.prompt(
        '标记本单「免验货」——出货前验货节点将免验货报告放行。\n请填写免验原因(客户免验 / 内销信任小单 / 客户自验不出报告…):',
        '',
      );
      if (reason == null) return;           // 取消
      if (!reason.trim()) { setError('需填写免验原因'); return; }
      startTransition(async () => {
        const res = await setInspectionWaiver(orderId, true, reason.trim());
        if (res?.error) { setError(res.error); return; }
        setTags((t) => [...t, INSPECTION_WAIVED_TAG]);
        router.refresh();
      });
    } else {
      // 取消:恢复需正常验货报告
      if (!window.confirm('取消「免验货」?取消后出货前验货节点需正常上传验货报告。')) return;
      startTransition(async () => {
        const res = await setInspectionWaiver(orderId, false, '');
        if (res?.error) { setError(res.error); return; }
        setTags((t) => t.filter((x) => x !== INSPECTION_WAIVED_TAG));
        router.refresh();
      });
    }
  }

  if (!canEdit && !isMarked) return null;

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={!canEdit || pending}
        title={
          !canEdit
            ? '仅业务 / QC / 生产主管 / 管理员可修改'
            : isMarked
              ? '本单免验货中 —— 出货前验货节点免报告放行。点此取消,恢复需验货报告'
              : '没有验货报告 / 客户免验? 标记「免验货」,出货前验货节点可免报告放行(需 QC/生产主管操作)'
        }
        className={`text-xs font-medium px-2.5 py-1 rounded-full transition-all ${
          isMarked
            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 ring-1 ring-emerald-300'
            : 'bg-gray-50 text-gray-500 hover:bg-emerald-50 hover:text-emerald-600 border border-dashed border-gray-300'
        } ${!canEdit ? 'cursor-default' : 'cursor-pointer'} ${pending ? 'opacity-60' : ''}`}
      >
        {pending ? '处理中…' : isMarked ? `🏷️ ${INSPECTION_WAIVED_TAG}` : `+ ${INSPECTION_WAIVED_TAG}`}
      </button>
      {error && (
        <span className="text-xs text-red-600 ml-1" title={error}>⚠ {error}</span>
      )}
    </div>
  );
}
