import Link from 'next/link';
import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getProductionCenter } from '@/app/actions/production-center';
import { isStageInitOpen } from '@/app/actions/production-stage-init';
import { ProductionCenterClient } from './ProductionCenterClient';
import { ReconcileExportButton } from './ReconcileExportButton';
import { SchedulingBoard } from '@/components/production/SchedulingBoard';
import { FactoryScheduleBoard } from '@/components/production/FactoryScheduleBoard';
import { ProductionProgressBoard } from '@/components/production/ProductionProgressBoard';
import { ProductionGanttChart } from '@/components/production/ProductionGanttChart';

/**
 * 生产中心(Production Center)Phase 1 —— 跨订单生产执行分析 HUB。
 * 生命周期四段(新订单待采购 → 物料在途 → 开生产待排单 → 生产中)+ 风险单,卡可点开筛选。
 * 门禁:生产/生产经理/理单/管理员;生产(非经理)只看分配到自己的单。
 * **不显示售价/毛利/成本**(生产角色红线)。状态纯派生,不猜。
 */

export const dynamic = 'force-dynamic';

export default async function ProductionCenterPage() {
  const { roles } = await requireProductionPage();
  const result = await getProductionCenter();
  // 一次性进度初始化入口:仅生产主管/管理员、且入口未关闭时显示
  const canInit = roles.includes('admin') || roles.includes('production_manager');
  // 生产进度录入:生产/跟单/QC/主管/管理员都能录(P4)
  const canLogProgress = canInit || roles.includes('production');
  const showInit = canInit && (await isStageInitOpen());

  if (result.error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <h1 className="mb-2 text-xl font-bold text-gray-900">生产中心</h1>
        <p>{result.error}</p>
      </div>
    );
  }

  const rows = result.data || [];
  const summary = result.summary || { total: 0, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 0, in_production: 0, ready_to_ship: 0, risk: 0 };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-gray-900">生产中心</h1>
        <span className="text-xs text-gray-400">卡风险,不走流程 · 生产视角</span>
      </div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <p className="text-sm text-gray-500">
          客户下单即进本中心,按物料就绪与生产节点自动落到对应阶段。点卡片筛选;数量/物料/工厂可见,售价与成本不在此视图。
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {showInit && (
            <Link href="/production/stage-init"
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
              初始化各单进度
            </Link>
          )}
          <ReconcileExportButton />
        </div>
      </div>

      <ProductionCenterClient rows={rows} summary={summary} />

      {/* 排产甘特图(生产进度可视化):每厂一行,派工按窗口画时间条+完成进度+超交期红 */}
      {canLogProgress && (
        <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4">
          <ProductionGanttChart />
        </div>
      )}

      {/* 排产工作台(生产主管/管理员):把待排产的款派给工厂 */}
      {canInit && (
        <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50/40 p-4">
          <SchedulingBoard />
        </div>
      )}

      {/* 工厂排产看板(P3):按工厂看负荷 + 名下派工(跨订单)+ 导派工单 */}
      {canInit && (
        <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50/40 p-4">
          <FactoryScheduleBoard />
        </div>
      )}

      {/* 生产进度录入(P4):跟单/QC 每天录实际产出,对照派工计划看进度 */}
      {canLogProgress && (
        <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50/40 p-4">
          <ProductionProgressBoard canManage={canInit} />
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">
        阶段口径:新订单待采购=有料未下单/未起料 · 物料在途=已下单未到齐 · 开生产待排单=料齐未开裁 · 生产中=已开裁未完工 · 待发货=尾查/工厂完成、未出运。出运后离开本中心。风险单=开裁/工厂完成节点逾期且未处置(可在订单里申请改期)。
      </p>
    </div>
  );
}
