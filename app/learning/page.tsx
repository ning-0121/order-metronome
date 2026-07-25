import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listRecentMaterialDecisions } from '@/app/actions/material-decisions';
import { knowledgeLayerMode } from '@/lib/engine/featureFlags';
import { LearningClient } from './LearningClient';

export const dynamic = 'force-dynamic';

/**
 * Knowledge Layer K1 — 学习中心（只读 + 结果评估）
 * 展示每次关键 Material Override 的原因/证据/结果。不做 AI 自动结论（DP-5）。
 */
export default async function LearningCenterPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, canEvaluate, error } = await listRecentMaterialDecisions(200);
  const mode = knowledgeLayerMode();

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">🧠 学习中心 · 物料决策</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            记录每次关键 Override（改单耗 / 换料 / 删料）的原因、证据与结果 —— Knowledge Layer K1。只读 + 人工结果评估。
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-indigo-600 hover:underline whitespace-nowrap">← 返回</Link>
      </div>

      {mode === 'off' && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700 mb-4">
          当前捕获开关处于关闭状态（<code className="text-xs">KNOWLEDGE_LAYER_CAPTURE=off</code>）。开启后，业务改关键物料时的决策会记录到这里；表建好前列表为空属正常。
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-4">加载失败：{error}</div>
      )}

      <LearningClient initial={data} canEvaluate={canEvaluate} />
    </div>
  );
}
