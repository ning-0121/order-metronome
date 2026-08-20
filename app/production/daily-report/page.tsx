import Link from 'next/link';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { DailyReportClient } from './DailyReportClient';
import { PROCESS_VOCAB } from '@/lib/production/dailyReport';

export const dynamic = 'force-dynamic';

export default async function ProductionDailyReportPage() {
  await requireProductionPage();   // 生产/理单/QC/主管/admin 可进(与生产中心同门禁)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4">
        <Link href="/production" className="text-sm text-indigo-600 hover:underline">← 返回生产中心</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">📋 生产日报录入</h1>
        <p className="text-sm text-gray-500 mt-1">
          把群里的日报整段粘进来 → 系统按订单号归位 → 你核对一眼 → 落到每张订单的「生产动态」。
          你们照旧自由写,系统只负责对号入座。
        </p>
      </div>

      {/* 格式说明 */}
      <details className="mb-5 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm">
        <summary className="cursor-pointer font-medium text-gray-800">📝 日报格式(点开看)</summary>
        <div className="mt-3 space-y-2 text-gray-600">
          <p>每件事一行:<code className="bg-white px-1.5 py-0.5 rounded border">【订单号】工序 / 状态 / 日期：说明</code></p>
          <ul className="list-disc pl-5 space-y-1">
            <li><b>【订单号】</b>唯一硬要求:填系统里的订单号(如 <code>603</code> / <code>1022934</code> / <code>601B</code>),
              <b>不带 RAG 前缀、不放款号</b>(L23/J95 这种写进说明)。</li>
            <li><b>工序</b>:{PROCESS_VOCAB.join(' / ')}</li>
            <li><b>状态</b>:完成 / 进行中 / 受阻 / 待跟进</li>
            <li><b>日期</b>可省;<b>：说明</b>后面随便写,越详细越好。</li>
          </ul>
          <p className="text-gray-500">例:<code className="bg-white px-1.5 py-0.5 rounded border">【588】船样 / 完成 / 周五：J95已给;黑色在包装,咖色缝制中,20号四针六线结束</code></p>
        </div>
      </details>

      <DailyReportClient />
    </div>
  );
}
