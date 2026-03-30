'use client';

import { useState } from 'react';
import type { SOPConfig } from '@/lib/domain/sop';

interface SOPModalProps {
  stepKey: string;
  milestoneName: string;
  sop: SOPConfig;
}

export function SOPButton({ stepKey, milestoneName, sop }: SOPModalProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors"
      >
        📖 SOP
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          {/* 遮罩 */}
          <div className="absolute inset-0 bg-black/40" />

          {/* 弹窗内容 */}
          <div
            className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 rounded-t-2xl flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{sop.sop_title}</h2>
                <p className="text-xs text-gray-500 mt-0.5">{milestoneName}</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 内容 */}
            <div className="px-6 py-5 space-y-5">
              {/* 操作步骤 */}
              <section>
                <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-bold">1</span>
                  操作步骤
                </h3>
                <div className="space-y-2">
                  {sop.sop_steps.map((step, i) => (
                    <div key={i} className="flex gap-2 text-sm text-gray-700">
                      <span className="flex-shrink-0 text-gray-400">{step.startsWith(`${i + 1}.`) ? '' : `${i + 1}.`}</span>
                      <span>{step.replace(/^\d+\.\s*/, '')}</span>
                    </div>
                  ))}
                </div>
              </section>

              {/* 必须提交的内容 */}
              <section>
                <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md bg-amber-100 flex items-center justify-center text-amber-600 text-xs font-bold">2</span>
                  必须提交
                </h3>
                <ul className="space-y-1.5">
                  {sop.required_fields.map((field, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                      <span className="text-amber-500 mt-0.5">✦</span>
                      <span>{field}</span>
                    </li>
                  ))}
                </ul>
              </section>

              {/* 完成判定 */}
              <section>
                <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md bg-green-100 flex items-center justify-center text-green-600 text-xs font-bold">3</span>
                  完成标准
                </h3>
                <ul className="space-y-1.5">
                  {sop.completion_rules.map((rule, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                      <span className="text-green-500 mt-0.5">☑</span>
                      <span>{rule}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            {/* 底部 */}
            <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-3 rounded-b-2xl">
              <button
                onClick={() => setOpen(false)}
                className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
