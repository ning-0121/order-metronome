import { requireProductionPage } from '@/lib/utils/production-page-guard';
import { getProductionCenter } from '@/app/actions/production-center';
import { ProductionCenterClient } from './ProductionCenterClient';
import { ReconcileExportButton } from './ReconcileExportButton';

/**
 * 生产中心(Production Center)Phase 1 —— 跨订单生产执行分析 HUB。
 * 生命周期四段(新订单待采购 → 物料在途 → 开生产待排单 → 生产中)+ 风险单,卡可点开筛选。
 * 门禁:生产/生产经理/理单/管理员;生产(非经理)只看分配到自己的单。
 * **不显示售价/毛利/成本**(生产角色红线)。状态纯派生,不猜。
 */

export const dynamic = 'force-dynamic';

export default async function ProductionCenterPage() {
  await requireProductionPage();
  const result = await getProductionCenter();

  if (result.error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <h1 className="mb-2 text-xl font-bold text-gray-900">生产中心</h1>
        <p>{result.error}</p>
      </div>
    );
  }

  const rows = result.data || [];
  const summary = result.summary || { total: 0, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 0, in_production: 0, risk: 0 };

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
        <ReconcileExportButton />
      </div>

      <ProductionCenterClient rows={rows} summary={summary} />

      <p className="mt-4 text-xs text-gray-400">
        阶段口径:新订单待采购=有料未下单/未起料 · 物料在途=已下单未到齐 · 开生产待排单=料齐未开裁 · 生产中=已开裁未完工。风险单=开裁/工厂完成节点逾期且未处置(可在订单里申请改期)。
      </p>
    </div>
  );
}
