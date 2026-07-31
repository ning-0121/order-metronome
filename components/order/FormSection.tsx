'use client';

/**
 * 建单表单的分区表头 + 底部必填进度(2026-07-31)。
 *
 * 背景:同事反馈建单页"看着头晕不知道怎么填"。量下来是 42 个控件 / 22 个必填散落其中 /
 * 19 条彩色横幅 / 81 处小字;而分区其实**已经存在**(录入方式/基本信息/贸易&航运/风险标记/
 * 客户备注/文件上传 6 个),只是标题是 `text-xs text-gray-400 uppercase` 的淡灰小字,
 * 视觉上完全不成区 —— 读起来就是一片平铺。所以要补的是"层次"和"我还差什么",不是重排字段。
 *
 * 为什么做成「只替换 h3」而不是包一层 <FormSection>{children}</FormSection>:
 *   LegacyOrderForm 有 2374 行,把 6 个区块的开闭标签都改对、还不碰中间几百行 JSX,
 *   出错概率远高于收益。这里改的是 6 行,组件靠 parentElement 拿到所属区块 ——
 *   h3 的父元素正好就是区块 div,结构上是稳的。
 *
 * ⚠️ 折叠用 hidden 属性,不是条件渲染/卸载。
 *    FormData 收集的是 form.elements,只排除 disabled 和无 name 的元素,
 *    display:none 的字段照常提交。若折叠时把节点卸载,折叠区的值提交时会全部丢失。
 *
 * 必填进度靠扫描区块内的 [required] 元素统计,不需要给 42 个字段逐个加 props,
 * 以后新增/删除字段都自动纳入,不会像硬编码清单那样漂移。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

function countRequired(root: HTMLElement): { done: number; total: number } {
  const els = Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input[required],select[required],textarea[required]',
    ),
  ).filter((el) => !el.disabled && (el as HTMLInputElement).type !== 'hidden');
  const done = els.filter((el) => {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
    if (el instanceof HTMLInputElement && el.type === 'file') return !!el.files?.length;
    return String(el.value || '').trim() !== '';
  }).length;
  return { done, total: els.length };
}

interface Props {
  /** 区块序号 —— 对应真实填写顺序,不是装饰 */
  num: number;
  title: string;
  /** 一句话说清这一区在干什么 */
  hint?: string;
  /** 允许折叠;全部选填的区块建议配合 defaultCollapsed */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export function SectionHeader({ num, title, hint, collapsible = false, defaultCollapsed = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(!defaultCollapsed);
  const [stat, setStat] = useState({ done: 0, total: 0 });

  const recount = useCallback(() => {
    const section = hostRef.current?.parentElement;
    if (section) setStat(countRequired(section));
  }, []);

  useEffect(() => {
    const section = hostRef.current?.parentElement;
    if (!section) return;
    recount();
    section.addEventListener('input', recount);
    section.addEventListener('change', recount);
    // 字段常是条件渲染的(选 DDP 才出 ETD、勾了才出截止日),结构变了也要重算
    const mo = new MutationObserver(recount);
    mo.observe(section, { childList: true, subtree: true });
    return () => {
      section.removeEventListener('input', recount);
      section.removeEventListener('change', recount);
      mo.disconnect();
    };
  }, [recount]);

  // 折叠:把同级的其余节点 hidden 掉(自己这一行留着)。见文件顶部——不能卸载。
  useEffect(() => {
    if (!collapsible) return;
    const section = hostRef.current?.parentElement;
    if (!section) return;
    for (const child of Array.from(section.children)) {
      if (child !== hostRef.current) (child as HTMLElement).hidden = !open;
    }
  }, [open, collapsible]);

  const allDone = stat.total > 0 && stat.done === stat.total;

  const Inner = (
    <>
      <span
        className={`shrink-0 w-6 h-6 rounded-full grid place-items-center text-[11px] font-bold tabular-nums border ${
          allDone ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
        }`}
      >
        {allDone ? '✓' : num}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-gray-900 leading-tight">{title}</span>
        {hint && <span className="block text-xs text-gray-500 mt-0.5 font-normal">{hint}</span>}
      </span>
      {stat.total > 0 && (
        <span
          className={`shrink-0 text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full ${
            allDone ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
          }`}
        >
          必填 {stat.done}/{stat.total}
        </span>
      )}
      {collapsible && (
        <span className={`shrink-0 text-gray-400 text-xs transition-transform ${open ? '' : '-rotate-90'}`}>▼</span>
      )}
    </>
  );

  return (
    <div ref={hostRef} className="mb-3 pb-2.5 border-b border-gray-200">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full flex items-center gap-2.5 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          {Inner}
        </button>
      ) : (
        <div className="flex items-center gap-2.5">{Inner}</div>
      )}
    </div>
  );
}

/** 底部常驻:整表还差几项必填。同样靠扫描 [required],不维护硬编码清单。 */
export function RequiredProgressBar({ formRef }: { formRef: React.RefObject<HTMLFormElement | null> }) {
  const [stat, setStat] = useState({ done: 0, total: 0 });

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const recount = () => setStat(countRequired(form));
    recount();
    form.addEventListener('input', recount);
    form.addEventListener('change', recount);
    const mo = new MutationObserver(recount);
    mo.observe(form, { childList: true, subtree: true });
    return () => {
      form.removeEventListener('input', recount);
      form.removeEventListener('change', recount);
      mo.disconnect();
    };
  }, [formRef]);

  if (stat.total === 0) return null;
  const left = stat.total - stat.done;
  const pct = Math.round((stat.done / stat.total) * 100);

  return (
    <div className="sticky bottom-0 z-20 border-t border-gray-200 bg-white/95 backdrop-blur py-2.5 mt-2">
      <div className="flex items-center gap-3">
        <span className={`text-sm font-semibold tabular-nums shrink-0 ${left === 0 ? 'text-emerald-700' : 'text-gray-700'}`}>
          {left === 0 ? '✓ 必填已齐' : `还差 ${left} 项必填`}
        </span>
        <span className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden min-w-[80px]">
          <span
            className={`block h-full transition-all duration-300 ${left === 0 ? 'bg-emerald-500' : 'bg-indigo-500'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="text-xs text-gray-400 tabular-nums shrink-0">{stat.done}/{stat.total}</span>
      </div>
    </div>
  );
}
