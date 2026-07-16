/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildOrderCenterDashboard, ORDER_STAGE_DEFINITIONS } from '../lib/orders/order-center-dashboard';

const makeMilestone = (step_key: string, status: string, due_at?: string | null) => ({
  id: `${step_key}-${status}`,
  name: step_key,
  step_key,
  status,
  due_at: due_at ?? null,
  actual_at: status === 'done' ? '2026-07-01T00:00:00Z' : null,
  owner_role: null,
  owner_user_id: null,
  sequence_number: 1,
});

const sampleOrders = [
  {
    id: 'o-1',
    order_no: 'QM-1001',
    internal_order_no: 'IN-1001',
    po_number: 'PO-1001',
    customer_name: '客户甲',
    factory_name: '工厂甲',
    incoterm: 'FOB',
    etd: '2026-07-28',
    warehouse_due_date: '2026-07-25',
    lifecycle_status: 'active',
    order_type: 'bulk',
    packaging_type: null,
    notes: null,
    created_at: '2026-07-01T00:00:00Z',
    style_no: 'ST-1',
    quantity: 120,
    cancel_date: null,
    order_date: '2026-07-01',
    factory_date: '2026-07-20',
    special_tags: [],
    owner_user_id: 'u-1',
    created_by: 'u-1',
    milestones: [
      makeMilestone('po_confirmed', 'done'),
      makeMilestone('order_kickoff_meeting', 'pending'),
      makeMilestone('production_order_upload', 'pending'),
      makeMilestone('booking_done', 'pending', '2026-07-10'),
    ],
    delay_requests: [{ id: 'd-1', status: 'pending', proposed_new_anchor_date: null, created_at: '2026-07-12T00:00:00Z' }],
  },
  {
    id: 'o-2',
    order_no: 'QM-1002',
    internal_order_no: 'IN-1002',
    po_number: 'PO-1002',
    customer_name: '客户乙',
    factory_name: '工厂乙',
    incoterm: 'FOB',
    etd: '2026-07-30',
    warehouse_due_date: '2026-07-27',
    lifecycle_status: 'completed',
    order_type: 'bulk',
    packaging_type: null,
    notes: null,
    created_at: '2026-06-20T00:00:00Z',
    style_no: 'ST-2',
    quantity: 80,
    cancel_date: null,
    order_date: '2026-06-20',
    factory_date: '2026-07-15',
    special_tags: [],
    owner_user_id: 'u-2',
    created_by: 'u-2',
    milestones: [
      makeMilestone('po_confirmed', 'done'),
      makeMilestone('order_kickoff_meeting', 'done'),
      makeMilestone('production_order_upload', 'done'),
      makeMilestone('booking_done', 'done'),
      makeMilestone('payment_received', 'done'),
    ],
    delay_requests: [],
  },
  {
    id: 'o-3',
    order_no: 'QM-1003',
    internal_order_no: 'IN-1003',
    po_number: 'PO-1003',
    customer_name: '客户丙',
    factory_name: '工厂丙',
    incoterm: 'FOB',
    etd: '2026-07-18',
    warehouse_due_date: '2026-07-16',
    lifecycle_status: 'active',
    order_type: 'repeat',
    packaging_type: null,
    notes: null,
    created_at: '2026-06-25T00:00:00Z',
    style_no: 'ST-3',
    quantity: 60,
    cancel_date: null,
    order_date: '2026-06-25',
    factory_date: '2026-07-15',
    special_tags: [],
    owner_user_id: 'u-3',
    created_by: 'u-3',
    milestones: [
      makeMilestone('po_confirmed', 'done'),
      makeMilestone('order_kickoff_meeting', 'done'),
      makeMilestone('production_order_upload', 'done'),
      makeMilestone('procurement_order_placed', 'done'),
      makeMilestone('factory_completion', 'pending', '2026-07-01'),
    ],
    delay_requests: [],
  },
] as const;

async function main() {
  const dashboard = buildOrderCenterDashboard({
    orders: sampleOrders as any,
    todayTasks: [
      { id: 't-1', task_type: 'missing_info', priority: 1, title: '补齐客户资料', description: '补齐缺失文件', action_url: '/my-today', action_label: '去处理', related_order_id: 'o-1' } as any,
      { id: 't-2', task_type: 'milestone_due_today', priority: 2, title: '推进订单节拍', description: '今日到期节点', action_url: '/orders?detail=1', action_label: '查看' } as any,
    ],
    approvals: [
      { id: 'a-1', category: 'delay', title: 'QM-1001 申请延期 2 天', subtitle: '等待审批', sourceUrl: '/admin/pending-approvals', createdAt: '2026-07-12T00:00:00Z', ageDays: 4, actionable: true } as any,
    ],
    generatedAt: '2026-07-16T20:00:00Z',
  });

  assert.equal(dashboard.kpis.length, 6);
  assert.equal(dashboard.stages.length, ORDER_STAGE_DEFINITIONS.length + 1);
  assert.equal(dashboard.todayTasks.length, 2);
  assert.equal(dashboard.approvals.length, 1);
  assert.equal(dashboard.risks.length >= 1, true);
  assert.equal(dashboard.detailedOrderCount, 3);
  assert.deepEqual(
    dashboard.kpis.map((item) => item.label),
    ['待确认 PO', '待建单', '执行中', '待出货', '已逾期', '风险订单'],
  );
  assert.equal(dashboard.kpis.find((item) => item.key === 'risk')?.count, 1);
  assert.equal(dashboard.kpis.find((item) => item.key === 'overdue')?.count, 1);
  assert.equal(dashboard.stages.find((item) => item.key === 'completed')?.count, 1);
  assert.equal(dashboard.todayTasks[0]?.href, '/my-today');
  assert.equal(dashboard.approvals[0]?.href, '/admin/pending-approvals');
  assert.equal(dashboard.risks[0]?.href.startsWith('/orders/'), true);

  const shell = await readFile('app/orders/OrderCenterDashboardShell.tsx', 'utf8');
  assert.ok(shell.includes('订单中心'));
  assert.ok(shell.includes('快捷入口'));
  assert.ok(shell.includes('订单 KPI'));
  assert.ok(shell.includes('订单执行阶段概览'));
  assert.ok(shell.includes('今日待办事项'));
  assert.ok(shell.includes('协作 / 审批提示'));
  assert.ok(shell.includes('风险干预预警'));
  assert.ok(shell.includes('详细订单列表'));
  assert.match(shell, /href: '\/orders\?detail=1'/);
  assert.match(shell, /href: '\/orders\/new'/);
  assert.match(shell, /href: '\/my-today'/);
  assert.match(shell, /href: '\/risk-orders\/overdue'/);

  const page = await readFile('app/orders/page.tsx', 'utf8');
  assert.ok(page.includes('showDetailWorkbench'));
  assert.ok(page.includes('loadOrderCenterDashboard'));
  assert.ok(page.includes('OrderCenterDashboardShell'));
  assert.ok(page.indexOf('if (!showDetailWorkbench)') < page.indexOf('const { data: allOrders, error } = await getOrders();'));
  assert.ok(page.includes('visibleOrders'));
  assert.ok(page.includes('phaseFilter'));

  console.log('✅ Order Center dashboard checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
