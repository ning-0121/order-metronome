import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateDetailedTasks, buildProductionDashboard, filterDetailedTasks, PRODUCTION_QUICK_ENTRIES, STAGE_DEFINITIONS } from '../lib/production/dashboard';
import type { ProductionOrderRow, ProductionCenterSummary } from '../app/actions/production-center';
import { resolveFactoryTruth } from '../lib/production/factory-truth';
import { effectiveMilestoneOwner } from '../lib/domain/milestone-owner';

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
const historicalFactory = resolveFactoryTruth({}, [{ factory_id: 'f1', factory_name: '盛涛', status: 'scheduled', created_at: '2026-07-17' }]);
assert.deepEqual(historicalFactory, { factory_id: 'f1', factory_name: '盛涛', source: 'dispatch' });
const assignedRow = row({ factory_name: historicalFactory.factory_name, production_follow_up_id: 'u1', production_follow_up_name: '骆淑娟' });
const assignedTasks = aggregateDetailedTasks([assignedRow], 'supervisor');
assert.equal(assignedTasks.some((task) => task.title === '待选工厂'), false);
assert.deepEqual(assignedTasks.filter((task) => ['待选工厂', '已分配待跟进'].includes(task.title)).map((task) => task.title), ['已分配待跟进']);
assert.equal(assignedTasks.find((task) => task.title === '已分配待跟进')?.href, '/production/order/o1');
const missingFactory = aggregateDetailedTasks([row({ risk: false })], 'supervisor').find((task) => task.title === '待选工厂');
assert.match(missingFactory?.href || '', /^\/production\/scheduling\?q=IN-1#order-o1$/);
const effective = effectiveMilestoneOwner({ step_key: 'packing_method_confirmed', owner_role: 'production', owner_user_id: 'luo' }, { owner_user_id: 'wang' });
assert.deepEqual({ role: effective.owner_role, user: effective.owner_user_id }, { role: 'merchandiser', user: 'wang' });

const page = readFileSync('app/production/page.tsx', 'utf8');
const client = readFileSync('app/production/ProductionCenterClient.tsx', 'utf8');
const action = readFileSync('app/actions/production-center.ts', 'utf8');
const shared = readFileSync('components/qimo-v2/QimoDashboard.tsx', 'utf8');
const schedulingPage = readFileSync('app/production/scheduling/page.tsx', 'utf8');
const factoryPage = readFileSync('app/production/factory-schedule/page.tsx', 'utf8');
const progressPage = readFileSync('app/production/progress/page.tsx', 'utf8');
assert.ok(page.indexOf('<header') < page.indexOf('<ProductionCenterClient'));
assert.match(shared, /grid-cols-1.*sm:grid-cols-2.*lg:grid-cols-4/);
assert.match(shared, /lg:grid-cols-6/);
assert.match(shared, /lg:grid-cols-3/);
assert.match(client, /useState\(Boolean\(initialDetail \|\| initialStage\)\)/);
assert.match(client, /items\.slice\(0, 5\)/);
assert.doesNotMatch(client, /rows: ProductionOrderRow\[\]/);
assert.match(action, /getProductionDetailedTasks/);
assert.ok(action.indexOf('getProductionDetailedTasks') > action.indexOf('getProductionCenter'));
assert.match(action, /无权查看生产中心/);
assert.match(client, /当前没有需要处理的事项/);
assert.match(client, /overflow-x-auto/);
// Exact CEO regression: no role may silently render the legacy expanded workbench.
assert.doesNotMatch(page, /RoleTaskWorkbench/);
assert.doesNotMatch(page, /生产主管今日任务/);
assert.ok(client.indexOf('<QimoQuickEntryRow') < client.indexOf('<QimoKpiGrid'));
assert.ok(client.indexOf('<QimoKpiGrid') < client.indexOf('生产进度总览'));
assert.ok(client.indexOf('生产进度总览') < client.indexOf('今日待办事项'));
assert.ok(client.indexOf('今日待办事项') < client.indexOf('生产主管详细任务'));
assert.match(client, /今日待办事项/);
assert.match(client, /协作 \/ 审批提示/);
assert.match(client, /风险干预预警/);
assert.doesNotMatch(page, /getProductionDetailedTasks\(/);
assert.match(client, /limit: 25/);
assert.match(page, /roles\.some\(\(item\) => \['qc', 'quality'\]\.includes\(item\)\) \? 'qc'/);
assert.match(page, /canManage \? 'supervisor' : 'follow_up'/);
// Final cleanup: homepage contains no embedded duplicate workbench navigation.
assert.doesNotMatch(page, /SchedulingBoard|FactoryScheduleBoard|ProductionProgressBoard|ProductionGanttChart|CollapsibleSection/);
assert.doesNotMatch(page, /workspace/);
assert.deepEqual(PRODUCTION_QUICK_ENTRIES.map((item) => item.href), [
  '/production/scheduling', '/production/factory-schedule', '/production/progress', '/production?detail=已超期#details',
]);
// The full Link surface is accessible by Enter natively and Space through explicit routing.
assert.match(shared, /<Link[\s\S]*href=\{entry\.href\}/);
assert.match(shared, /event\.key === ' '/);
assert.match(shared, /router\.push\(entry\.href\)/);
assert.match(shared, /focus-visible:ring-2/);
assert.match(shared, /h-14/);
assert.doesNotMatch(client, /entry\.subtitle|entry\.icon/);
// Extracted routes reuse existing operational components and retain page-level role gates.
assert.match(schedulingPage, /requireProductionPage/);
assert.match(schedulingPage, /SchedulingBoard/);
assert.match(schedulingPage, /production_manager/);
assert.match(factoryPage, /requireProductionPage/);
assert.match(factoryPage, /FactoryScheduleBoard/);
assert.match(factoryPage, /production_manager/);
assert.match(progressPage, /requireProductionPage/);
assert.match(progressPage, /ProductionProgressBoard/);
assert.match(progressPage, /'production', 'qc', 'quality'/);
console.log('production dashboard: 55 assertions passed');
