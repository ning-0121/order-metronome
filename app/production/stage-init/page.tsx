import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getProductionStageInit } from '@/app/actions/production-stage-init';
import { StageInitClient } from './StageInitClient';

/**
 * 生产主管一次性进度初始化入口。
 * 仅 生产主管 / 管理员;把每个在产订单手动归到正确的阶段档,归完由管理员关闭。
 */

export const dynamic = 'force-dynamic';

export default async function StageInitPage() {
  const { roles } = await requireProductionPage();
  // 页面级再收紧:只有生产主管/管理员能进这个初始化入口
  if (!roles.includes('admin') && !roles.includes('production_manager')) redirect('/production');

  const result = await getProductionStageInit();

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-gray-900">生产进度初始化</h1>
        <Link href="/production" className="text-sm text-indigo-600 hover:underline">← 返回生产中心</Link>
      </div>
      <p className="mb-5 max-w-3xl text-sm text-gray-500">
        一次性把每个在产订单归到当前真实的生产阶段档。设定档作为「下限」——系统之后只会把订单往前推,
        不会倒退回比你设的更早的档。全部归好后,由管理员点右上「关闭初始化入口」,本页转为只读,日常进度仍走生产节点。
      </p>

      {result.error ? (
        <div className="rounded-lg border border-gray-200 bg-white py-12 text-center text-gray-500">{result.error}</div>
      ) : (
        <StageInitClient rows={result.rows || []} open={result.open ?? true} isAdmin={!!result.isAdmin} />
      )}
    </div>
  );
}
