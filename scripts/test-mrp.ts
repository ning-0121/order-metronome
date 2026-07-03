/**
 * 单元测试 — Explainable + 时间分段 MRP 纯函数(lib/services/mrp.ts)
 * 运行:npx tsx scripts/test-mrp.ts
 */
import { computeMaterialRequirement, MATERIAL_TYPE_TO_CATEGORY, CATEGORY_TO_STAGE, DEFAULT_LEAD_DAYS } from '../lib/services/mrp';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; failures.push(label); console.log('  ❌', label); }
}

const today = '2026-06-01';
const anchors = {
  cutting: '2026-07-10', sewing: '2026-07-10', packing: '2026-07-25',
  shipment: '2026-08-01', sample: '2026-06-20', factory_date: '2026-07-20',
};

console.log('\n▶ Case 1 — 面料数量与阶段(PO 10000 × 单耗 0.265;损耗2%只作参考不进净需求)');
{
  const r = computeMaterialRequirement({
    material: { material_name: '主面料', material_type: 'fabric', unit: 'kg', qty_per_piece: 0.265, loss_rate: 2 },
    po_quantity: 10000, stageAnchors: anchors, inventoryQty: 0, reuseQty: 0, today,
  });
  ok(r.category === 'fabric', 'category=fabric');
  ok(r.required_stage === 'cutting', 'stage=cutting(面料影响开裁)');
  ok(r.gross_requirement === 2650, `gross=2650(实际 ${r.gross_requirement})`);
  ok(r.loss_qty === 53, `loss=53 参考值(实际 ${r.loss_qty})`);
  // 2026-07-03 用户实测「多算两匹布」:净需求=裸数(不再暗含损耗;损耗由采购核料「采购损耗%」明控)
  ok(r.net_purchase_qty === 2650, `net=2650 裸数(实际 ${r.net_purchase_qty})`);
  ok(r.supplier_lead_days === 15, 'fabric 默认交期=15 工作日');
  ok(r.lead_days_source === 'default', 'lead 来源=default');
  ok(r.required_date === '2026-07-10', `required_date=开裁日(实际 ${r.required_date})`);
  ok(!!r.order_by_date && r.order_by_date < r.required_date!, '最晚下单日 < 需到日');
  ok(['on_time', 'due_soon', 'late'].includes(r.timing_status), `timing_status 合法(${r.timing_status})`);
  ok(Array.isArray(r.explain_json.factors) && r.explain_json.factors.length === 4, 'explain 有 4 个因子');
  ok(r.explain_json.assumptions.some((a: string) => a.includes('默认值 15')), 'explain 标注默认交期 15');
}

console.log('\n▶ Case 2 — 缺单耗 → needs_input,不算量不阻断');
{
  const r = computeMaterialRequirement({
    material: { material_name: '某辅料', material_type: 'trim', unit: 'pcs', qty_per_piece: null, loss_rate: 2 },
    po_quantity: 10000, stageAnchors: anchors, today,
  });
  ok(r.status === 'needs_input', 'status=needs_input');
  ok(r.net_purchase_qty === null, 'net=null');
  ok(r.explain_json.assumptions.some((a: string) => a.includes('缺单耗')), 'explain 标注缺单耗');
  ok(r.explain_json.next_action === '业务补录单耗', 'next_action=业务补录单耗');
}

console.log('\n▶ Case 3 — 辅料 → 车缝阶段,默认交期 10');
{
  const r = computeMaterialRequirement({
    material: { material_name: '拉链', material_type: 'trim', unit: 'pcs', qty_per_piece: 1, loss_rate: 0 },
    po_quantity: 5000, stageAnchors: anchors, today,
  });
  ok(r.required_stage === 'sewing', 'trim → sewing');
  ok(r.supplier_lead_days === 10, 'trim 默认交期=10');
  ok(r.net_purchase_qty === 5000, `net=5000(实际 ${r.net_purchase_qty})`);
}

console.log('\n▶ Case 4 — 里料归类为面料(lining→fabric→开裁)');
{
  const r = computeMaterialRequirement({
    material: { material_name: '里布', material_type: 'lining', unit: 'm', qty_per_piece: 0.5, loss_rate: 3 },
    po_quantity: 1000, stageAnchors: anchors, today,
  });
  ok(r.category === 'fabric', 'lining→category fabric');
  ok(r.required_stage === 'cutting', 'lining→开裁');
}

console.log('\n▶ Case 5 — 印花:默认开裁 + explain 必须提示后印花需人工改阶段');
{
  const r = computeMaterialRequirement({
    material: { material_name: '前片印花', material_type: 'print', unit: 'pcs', qty_per_piece: 1, loss_rate: 0 },
    po_quantity: 2000, stageAnchors: anchors, today,
  });
  ok(r.category === 'print', 'category=print');
  ok(r.required_stage === 'cutting', 'print 默认 → 开裁');
  ok(r.explain_json.assumptions.some((a: string) => a.includes('后印花') || a.includes('人工改阶段')), 'explain 提示后印花需人工改阶段');
}

console.log('\n▶ Case 6 — 缺阶段日期 → timing_status=unknown,order_by_date=null');
{
  const r = computeMaterialRequirement({
    material: { material_name: '主面料', material_type: 'fabric', unit: 'kg', qty_per_piece: 0.2, loss_rate: 2 },
    po_quantity: 1000, stageAnchors: { factory_date: null }, today,
  });
  ok(r.required_date === null, 'required_date=null');
  ok(r.order_by_date === null, 'order_by_date=null');
  ok(r.timing_status === 'unknown', 'timing_status=unknown');
}

console.log('\n▶ Case 7 — 映射常量完整性');
{
  ok(DEFAULT_LEAD_DAYS.fabric === 15 && DEFAULT_LEAD_DAYS.trim === 10 && DEFAULT_LEAD_DAYS.packing === 7, '默认交期常量=拍板值(15/10/7)');
  ok(CATEGORY_TO_STAGE.packing === 'packing' && CATEGORY_TO_STAGE.washing === 'packing', 'washing/packing→包装');
  ok(MATERIAL_TYPE_TO_CATEGORY.label === 'trim', 'label→trim');
}

console.log('\n════════════════════════════════════════');
console.log(`✅ 通过: ${pass}`);
console.log(`❌ 失败: ${fail}`);
console.log('════════════════════════════════════════');
if (fail > 0) { console.log('\n失败项:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('\n🎉 MRP 测试全部通过');
