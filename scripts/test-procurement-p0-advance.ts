/**
 * Procurement Generator P0 —— 自动推进契约测试(纯函数,不连库)
 *
 * 验的是 CEO 定的成功标准:
 *   点提交后系统一定自动进入**正确的下一状态** —— 要么生成采购需求,
 *   要么明确告诉跟单还缺哪个 BOM 事实。**绝不静默停住,绝不猜。**
 *
 * 运行:node --import tsx scripts/test-procurement-p0-advance.ts
 */
import {
  decideProcurementAdvance,
  checkExecutionLineInvariant,
  isTradeLine,
  TRADE_BULK_CATEGORY,
} from '../lib/procurement/advance';
import { effectiveLineStatus } from '../lib/services/procurement-execution';
import { isSystemActor, SYSTEM_ACTOR } from '../lib/procurement/systemActor';
import { NEEDS_BOM_CONFIRMATION } from '../lib/procurement/consumption-basis';

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✅ ${name}`); return; }
  failed++;
  console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
}

const BOM_OK = [
  { materialName: '75D 四面弹', consumptionBasis: 'PER_PIECE' },
  { materialName: '主标', consumptionBasis: 'PER_SET' },
];
const BOM_MISSING = [
  { materialName: '75D 四面弹', consumptionBasis: 'PER_PIECE' },
  { materialName: '主标', consumptionBasis: null },
  { materialName: '洗标', consumptionBasis: '' },
];

console.log('\n【1】非 Pilot 订单:行为零变化');
{
  const d = decideProcurementAdvance({ isPilot: false, bom: BOM_OK, requirementCount: 12 });
  check('kind = NOT_PILOT', d.kind === 'NOT_PILOT', d.kind);
  // 2026-08-18 CEO:非 Pilot 也归并 —— 采购手动点「归并」产出的项逐字段相同,
  // 人工门只是多一步。Pilot 独占的是**口径就绪门禁**(见【3】),不是归并本身。
  check('也归并(不再把人工门留给非 Pilot 单)', d.shouldConsolidate === true);
  check('下一步交采购', d.nextActor === 'procurement');
}

console.log('\n【2】Pilot + basis 齐全 → 自动归并(消灭隐藏人工门)');
{
  const d = decideProcurementAdvance({ isPilot: true, bom: BOM_OK, requirementCount: 12 });
  check('kind = READY_TO_CONSOLIDATE', d.kind === 'READY_TO_CONSOLIDATE', d.kind);
  check('shouldConsolidate = true', d.shouldConsolidate === true);
  check('下一步归采购', d.nextActor === 'procurement');
  check('无缺口', d.missingBasisMaterials.length === 0);
}

console.log('\n【3】failure case:basis 缺失 → 明确阻断,绝不猜');
{
  const d = decideProcurementAdvance({ isPilot: true, bom: BOM_MISSING, requirementCount: 12 });
  check('kind = NEEDS_BOM_CONFIRMATION', d.kind === NEEDS_BOM_CONFIRMATION, d.kind);
  check('不生成可确认采购', d.shouldConsolidate === false);
  check('回到跟单', d.nextActor === 'merchandiser');
  check('列出缺口物料(主标/洗标)',
    d.missingBasisMaterials.length === 2
    && d.missingBasisMaterials.includes('主标')
    && d.missingBasisMaterials.includes('洗标'),
    JSON.stringify(d.missingBasisMaterials));
  check('message 指名道姓,不是泛泛报错', d.message.includes('主标') && d.message.includes('洗标'));
}

console.log('\n【4】绝不静默:每条路径都有 kind + 说人话的 message');
{
  const cases = [
    { isPilot: false, bom: BOM_OK, requirementCount: 1 },
    { isPilot: true, bom: [], requirementCount: 0 },
    { isPilot: true, bom: BOM_MISSING, requirementCount: 1 },
    { isPilot: true, bom: BOM_OK, requirementCount: 0 },
    { isPilot: true, bom: BOM_OK, requirementCount: 5 },
  ];
  const kinds = new Set<string>();
  let allSpoken = true;
  for (const c of cases) {
    const d = decideProcurementAdvance(c);
    kinds.add(d.kind);
    if (!d.kind || !d.message || d.message.length < 8) allSpoken = false;
  }
  check('5 条路径产出 5 个不同状态', kinds.size === 5, [...kinds].join(','));
  check('无一条静默(都有 kind + 人话 message)', allSpoken);
}

console.log('\n【5】MRP 跑出 0 条需求 → 不静默生成空采购需求');
{
  const d = decideProcurementAdvance({ isPilot: true, bom: BOM_OK, requirementCount: 0 });
  check('kind = NO_REQUIREMENTS', d.kind === 'NO_REQUIREMENTS', d.kind);
  check('不归并', d.shouldConsolidate === false);
  check('指向系统侧排查', d.nextActor === 'system');
}

console.log('\n【6】Pilot 执行行不变量:生产行必须挂 procurement_item_id');
{
  const good = checkExecutionLineInvariant([
    { id: 'a', procurementItemId: 'pi-1', category: 'fabric' },
    { id: 'b', procurementItemId: 'pi-2', category: 'trim' },
  ]);
  check('全挂 item → ok', good.ok === true);

  const bad = checkExecutionLineInvariant([
    { id: 'a', procurementItemId: 'pi-1', category: 'fabric' },
    { id: 'orphan', procurementItemId: null, category: 'fabric' },
  ]);
  check('有孤儿行 → 不通过', bad.ok === false);
  check('点名孤儿行 id', bad.orphanLineIds.join(',') === 'orphan', bad.orphanLineIds.join(','));

  // CEO 裁定:Trade 是合法业务例外,不属于本不变量
  const trade = checkExecutionLineInvariant([
    { id: 't', procurementItemId: null, category: TRADE_BULK_CATEGORY },
  ]);
  check('贸易单成品大货 item_id=null 合法', trade.ok === true);
  check('isTradeLine 认得成品大货', isTradeLine({ category: TRADE_BULK_CATEGORY }) === true);
  check('普通面料不是 trade', isTradeLine({ category: 'fabric' }) === false);
}

console.log('\n【7】line_status 是唯一 canonical,status 只读兜底');
{
  check('新行读 line_status', effectiveLineStatus({ line_status: 'pending_order', status: null }) === 'pending_order');
  check('旧行兜底读 status', effectiveLineStatus({ line_status: null, status: 'complete' }) === 'complete');
  check('两列都有时 line_status 赢', effectiveLineStatus({ line_status: 'active', status: 'complete' }) === 'active');
  check('空串不算值', effectiveLineStatus({ line_status: '  ', status: 'complete' }) === 'complete');
  check('都没有 → null', effectiveLineStatus({ line_status: null, status: null }) === null);
}

console.log('\n【8】SYSTEM_ACTOR 不可被客户端伪造');
{
  check('Symbol 本体通过', isSystemActor(SYSTEM_ACTOR) === true);
  // Server Action 参数只能是可序列化值 —— 以下都是客户端**唯一能发出来**的形态
  for (const forged of [true, 'SYSTEM_ACTOR', 1, {}, null, undefined, 'Symbol(procurement.system-actor)']) {
    check(`伪造 ${JSON.stringify(forged)} 被拒`, isSystemActor(forged) === false);
  }
  check('同名 Symbol 也不认(不是 Symbol.for)', isSystemActor(Symbol('procurement.system-actor')) === false);
  check('JSON 往返后 Symbol 丢失', isSystemActor(JSON.parse(JSON.stringify({ v: SYSTEM_ACTOR as any })).v) === false);
}

console.log(
  failed === 0
    ? '\n✅ P0 自动推进契约全部通过\n'
    : `\n❌ ${failed} 项未通过\n`,
);
process.exit(failed === 0 ? 0 : 1);
