import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateDetailedTasks, buildProductionDashboard, filterDetailedTasks, PRODUCTION_QUICK_ENTRIES, STAGE_DEFINITIONS } from '../lib/production/dashboard';
import type { ProductionOrderRow, ProductionCenterSummary } from '../app/actions/production-center';

const row = (patch: Partial<ProductionOrderRow> = {}): ProductionOrderRow => ({
  order_id: 'o1', order_no: 'QM-1', internal_order_no: 'IN-1', po_number: 'PO-1', style_no: 'S-1',
  production_follow_up_id: null, production_follow_up_name: null, pending_delay: false,
  customer_name: '客户甲', factory_name: null, quantity: 100, factory_date: '2026-07-01', etd: '2026-07-10',
  stage: 'in_production', risk: true, has_mo: true, material: { total: 2, received: 1, in_transit: 0, pending: 1 },
  kickoff: { status: 'pending', due: '2026-07-01' }, completion: null, ...patch,
});
const rows = [row(), row({ order_id: 'o2', order_no: 'QM-2', internal_order_no: 'IN-2', pending_delay: true, risk: false, stage: 'ready_to_schedule' })];
const summary: ProductionCenterSummary = { total: 2, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 1, in_production: 1, ready_to_ship: 0, risk: 1, completed: 3 };

assert.deepEqual(PRODUCTION_QUICK_ENTRIES.map((item) => item.title), ['排单与派单工作台', '工厂排产看板', '生产进度录入', '风险订单攻克']);
assert.equal(PRODUCTION_QUICK_ENTRIES.every((item) => item.href.startsWith('/')), true);
assert.equal(STAGE_DEFINITIONS.length, 6);
const detailed = aggregateDetailedTasks(rows, 'supervisor');
const riskForO1 = detailed.filter((task) => task.orderId === 'o1' && task.key.endsWith(':risk'));
assert.equal(riskForO1.length, 1);
assert.deepEqual(riskForO1[0].badges.sort(), ['异常待处理', '已超期'].sort());
assert.equal(filterDetailedTasks(detailed, 'IN-1', 0, 25).items.every((task) => task.orderId === 'o1'), true);
assert.equal(filterDetailedTasks(detailed, '', 0, 1).items.length, 1);
assert.equal(filterDetailedTasks(detailed, '', 0, 1).hasMore, true);
const supervisor = buildProductionDashboard(rows, summary, 'supervisor');
const followUp = buildProductionDashboard(rows, summary, 'follow_up');
assert.equal(supervisor.approvals.some((item) => item.label === '延期申请审批'), true);
assert.equal(followUp.approvals.length, 0);
assert.equal(supervisor.today.length <= 5 && supervisor.risks.length <= 5, true);

const page = readFileSync('app/production/page.tsx', 'utf8');
const client = readFileSync('app/production/ProductionCenterClient.tsx', 'utf8');
const action = readFileSync('app/actions/production-center.ts', 'utf8');
assert.ok(page.indexOf('<header') < page.indexOf('<ProductionCenterClient'));
assert.match(client, /grid-cols-1.*sm:grid-cols-2.*lg:grid-cols-4/);
assert.match(client, /lg:grid-cols-6/);
assert.match(client, /lg:grid-cols-3/);
assert.match(client, /useState\(Boolean\(initialDetail \|\| initialStage\)\)/);
assert.match(client, /items\.slice\(0, 5\)/);
assert.doesNotMatch(client, /rows: ProductionOrderRow\[\]/);
assert.match(action, /getProductionDetailedTasks/);
assert.ok(action.indexOf('getProductionDetailedTasks') > action.indexOf('getProductionCenter'));
assert.match(action, /无权查看生产中心/);
assert.match(client, /当前没有需要处理的事项/);
assert.match(client, /overflow-x-auto/);
console.log('production dashboard: 24 assertions passed');
