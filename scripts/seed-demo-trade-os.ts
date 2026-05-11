/**
 * seed-demo-trade-os.ts
 *
 * Demo 环境 Seed 脚本 — Trade Agent OS
 *
 * 用途：在独立 Demo Supabase project 中插入演示数据。
 * 绝对不能连接生产数据库。
 *
 * 使用方法（dry-run，默认）：
 *   DEMO_SUPABASE_URL=xxx DEMO_SUPABASE_SERVICE_ROLE_KEY=yyy npx tsx scripts/seed-demo-trade-os.ts
 *
 * 实际执行（需明确传入 --execute）：
 *   DEMO_SUPABASE_URL=xxx DEMO_SUPABASE_SERVICE_ROLE_KEY=yyy npx tsx scripts/seed-demo-trade-os.ts --execute
 *
 * 安全护栏：
 *   1. DEMO_SUPABASE_URL 不能含 production / qimoactivewear / scrtebexbx
 *   2. 必须设置 DEMO_SEED_CONFIRM=YES_I_AM_SEEDING_DEMO（或 NODE_ENV=test）
 *   3. 默认 dry-run，只打印将插入数据量，不写任何数据
 *   4. --execute 才实际写入
 *
 * 幂等性：每次执行先 delete where order_no like '[DEMO]%'，再 insert
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. 安全护栏（最先执行，任何违规直接 throw）
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_URL = process.env.DEMO_SUPABASE_URL
const DEMO_KEY = process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY
const DEMO_CONFIRM = process.env.DEMO_SEED_CONFIRM
const IS_TEST_ENV = process.env.NODE_ENV === 'test'
const DRY_RUN = !process.argv.includes('--execute')

// 1a. 必须提供 Demo 专用环境变量
if (!DEMO_URL || !DEMO_KEY) {
  throw new Error(
    '❌ 必须设置 DEMO_SUPABASE_URL 和 DEMO_SUPABASE_SERVICE_ROLE_KEY。\n' +
    '   这两个变量必须指向独立的 Demo Supabase project，绝对不能是生产数据库。'
  )
}

// 1b. 禁止连接生产环境
const PRODUCTION_IDENTIFIERS = [
  'production',
  'qimoactivewear',
  'scrtebexbxablybqpdla', // 当前生产 Supabase project ID
]
for (const id of PRODUCTION_IDENTIFIERS) {
  if (DEMO_URL.toLowerCase().includes(id)) {
    throw new Error(
      `❌ 安全拒绝：DEMO_SUPABASE_URL 包含生产标识符 "${id}"。\n` +
      '   请使用独立的 Demo Supabase project URL。'
    )
  }
}

// 1c. 必须明确确认（不是 dry-run 或测试环境时）
if (!DRY_RUN && !IS_TEST_ENV && DEMO_CONFIRM !== 'YES_I_AM_SEEDING_DEMO') {
  throw new Error(
    '❌ 执行 seed 前必须设置环境变量：\n' +
    '   DEMO_SEED_CONFIRM=YES_I_AM_SEEDING_DEMO\n' +
    '   或使用默认 dry-run 模式（不传 --execute）。'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 依赖（仅在通过安全检查后加载）
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// 3. 常量与工具函数
// ─────────────────────────────────────────────────────────────────────────────

/** 相对今天的日期偏移，返回 ISO 字符串（YYYY-MM-DD） */
function daysFromNow(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().split('T')[0]
}

/** 相对今天的完整时间戳 */
function tsFromNow(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString()
}

const DEMO_PREFIX = '[DEMO]'

// ─────────────────────────────────────────────────────────────────────────────
// 4. Demo 用户（Auth users 不在此脚本创建，仅记录规格）
// ─────────────────────────────────────────────────────────────────────────────
//
// TODO: 在 Demo Supabase project 中手动创建以下 Auth users，
//       然后将 user_id 填入下方 DEMO_USERS。
//
// 账号规格：
//   demo-ceo@demostore.com   | 角色: admin      | 密码: Demo2026!
//   demo-sales@demostore.com | 角色: sales      | 密码: Demo2026!
//   demo-prod@demostore.com  | 角色: production | 密码: Demo2026!
//
// 前提：Demo project Auth 设置中需要将 @demostore.com 加入允许域名
//       或关闭邮箱域名限制（仅 Demo project，不影响生产）。
//
// 创建方式：Supabase Dashboard → Authentication → Users → Invite user
//           或通过 supabase auth admin createuser （service role）
//
// ────────────────────────────────────────────────────────────────────────────

// 用占位符 UUID，运行前需替换为真实的 Auth user ID
const DEMO_USERS = {
  ceo: {
    id: '00000000-0000-0000-0000-000000000001', // TODO: 替换为真实 user_id
    email: 'demo-ceo@demostore.com',
    name: '[DEMO] Alex Chen',
    role: 'admin' as const,
  },
  sales: {
    id: '00000000-0000-0000-0000-000000000002', // TODO: 替换为真实 user_id
    email: 'demo-sales@demostore.com',
    name: '[DEMO] Sarah Liu',
    role: 'sales' as const,
  },
  production: {
    id: '00000000-0000-0000-0000-000000000003', // TODO: 替换为真实 user_id
    email: 'demo-prod@demostore.com',
    name: '[DEMO] Tom Zhang',
    role: 'production' as const,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Demo Profiles（对应 public.profiles 表）
// ─────────────────────────────────────────────────────────────────────────────

function buildProfiles() {
  return Object.values(DEMO_USERS).map((u) => ({
    user_id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    roles: [u.role],
    is_active: true,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Demo Orders（5个）
// ─────────────────────────────────────────────────────────────────────────────
//
// 叙事：5个订单构成完整演示世界
//
// ORD-001  [DEMO] Mountain Sports  — 交付危机主角（置信度 ~32%）
//   中期验货逾期8天，利润跌至8.2%，延期申请 pending，factory_date = 今天+4天
//
// ORD-002  [DEMO] Berlin Basics    — 健康对比（置信度 ~78%）
//   产前样确认阶段，进展正常
//
// ORD-003  [DEMO] Sydney Active    — 延期申请待审批（置信度 ~55%）
//   已提交延期申请，等待审批
//
// ORD-004  [DEMO] Tokyo Fleece     — 早期安全（置信度 ~91%）
//   财务审批刚通过，时间充裕
//
// ORD-005  [DEMO] NYC Denim        — 已完成待复盘
//   lifecycle_status = '已完成'，展示复盘功能

const DEMO_ORDER_IDS = {
  ord001: 'dddddddd-0001-0000-0000-000000000001',
  ord002: 'dddddddd-0002-0000-0000-000000000002',
  ord003: 'dddddddd-0003-0000-0000-000000000003',
  ord004: 'dddddddd-0004-0000-0000-000000000004',
  ord005: 'dddddddd-0005-0000-0000-000000000005',
}

function buildOrders() {
  return [
    // ORD-001 — 危险订单（主角）
    {
      id: DEMO_ORDER_IDS.ord001,
      order_no: `${DEMO_PREFIX}-ORD-001`,
      internal_order_no: 'DEMO-2026-001',
      customer_name: `${DEMO_PREFIX} Mountain Sports`,
      factory_name: `${DEMO_PREFIX} Jinhua Factory`,
      incoterm: 'FOB',
      delivery_type: 'export',
      lifecycle_status: '生产中',
      order_type: 'bulk',
      quantity: 2400,
      quantity_unit: 'pcs',
      factory_date: daysFromNow(4),     // 火烧眉毛：4天后出厂
      etd: daysFromNow(10),
      eta: daysFromNow(42),
      order_date: daysFromNow(-62),
      special_tags: ['交期紧急'],
      notes: `${DEMO_PREFIX} 演示订单：交付危机场景`,
      owner_user_id: DEMO_USERS.sales.id,
      created_by: DEMO_USERS.ceo.id,
      skip_pre_production_sample: false,
    },
    // ORD-002 — 健康订单（对比）
    {
      id: DEMO_ORDER_IDS.ord002,
      order_no: `${DEMO_PREFIX}-ORD-002`,
      internal_order_no: 'DEMO-2026-002',
      customer_name: `${DEMO_PREFIX} Berlin Basics`,
      factory_name: `${DEMO_PREFIX} Guangzhou Textile`,
      incoterm: 'FOB',
      delivery_type: 'export',
      lifecycle_status: '生产准备',
      order_type: 'bulk',
      quantity: 1800,
      quantity_unit: 'pcs',
      factory_date: daysFromNow(38),
      etd: daysFromNow(45),
      eta: daysFromNow(75),
      order_date: daysFromNow(-30),
      special_tags: [],
      notes: `${DEMO_PREFIX} 演示订单：正常进度对比`,
      owner_user_id: DEMO_USERS.sales.id,
      created_by: DEMO_USERS.ceo.id,
      skip_pre_production_sample: false,
    },
    // ORD-003 — 延期申请待审批
    {
      id: DEMO_ORDER_IDS.ord003,
      order_no: `${DEMO_PREFIX}-ORD-003`,
      internal_order_no: 'DEMO-2026-003',
      customer_name: `${DEMO_PREFIX} Sydney Active`,
      factory_name: `${DEMO_PREFIX} Jinhua Factory`,
      incoterm: 'DDP',
      delivery_type: 'export',
      lifecycle_status: '生产中',
      order_type: 'bulk',
      quantity: 3200,
      quantity_unit: 'pcs',
      factory_date: daysFromNow(18),
      etd: daysFromNow(25),
      eta: daysFromNow(55),
      order_date: daysFromNow(-45),
      special_tags: [],
      notes: `${DEMO_PREFIX} 演示订单：延期审批场景`,
      owner_user_id: DEMO_USERS.sales.id,
      created_by: DEMO_USERS.ceo.id,
      skip_pre_production_sample: false,
    },
    // ORD-004 — 早期安全
    {
      id: DEMO_ORDER_IDS.ord004,
      order_no: `${DEMO_PREFIX}-ORD-004`,
      internal_order_no: 'DEMO-2026-004',
      customer_name: `${DEMO_PREFIX} Tokyo Fleece`,
      factory_name: `${DEMO_PREFIX} Hangzhou Knit`,
      incoterm: 'FOB',
      delivery_type: 'export',
      lifecycle_status: '待启动',
      order_type: 'new',
      quantity: 960,
      quantity_unit: 'pcs',
      factory_date: daysFromNow(75),
      etd: daysFromNow(82),
      eta: daysFromNow(110),
      order_date: daysFromNow(-10),
      special_tags: [],
      notes: `${DEMO_PREFIX} 演示订单：早期健康状态`,
      owner_user_id: DEMO_USERS.sales.id,
      created_by: DEMO_USERS.ceo.id,
      skip_pre_production_sample: true,
    },
    // ORD-005 — 已完成待复盘
    {
      id: DEMO_ORDER_IDS.ord005,
      order_no: `${DEMO_PREFIX}-ORD-005`,
      internal_order_no: 'DEMO-2026-005',
      customer_name: `${DEMO_PREFIX} NYC Denim`,
      factory_name: `${DEMO_PREFIX} Guangzhou Textile`,
      incoterm: 'FOB',
      delivery_type: 'export',
      lifecycle_status: '已完成',
      order_type: 'repeat',
      quantity: 5600,
      quantity_unit: 'pcs',
      factory_date: daysFromNow(-30),
      etd: daysFromNow(-22),
      eta: daysFromNow(-5),
      order_date: daysFromNow(-120),
      special_tags: [],
      notes: `${DEMO_PREFIX} 演示订单：已完成待复盘`,
      owner_user_id: DEMO_USERS.sales.id,
      created_by: DEMO_USERS.ceo.id,
      skip_pre_production_sample: false,
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Demo Milestones
// ─────────────────────────────────────────────────────────────────────────────
//
// 只为 ORD-001 和 ORD-005 生成完整里程碑（演示核心场景）。
// ORD-002/003/004 生成关键里程碑即可（保持演示数据精简）。

type MilestoneStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'overdue'

interface MilestoneSeed {
  order_id: string
  step_key: string
  name: string
  owner_role: string
  planned_at: string
  actual_at?: string
  status: MilestoneStatus
  is_critical: boolean
  notes?: string
}

function buildMilestones(): MilestoneSeed[] {
  const milestones: MilestoneSeed[] = []

  // ──────────────────────────────────────────────────────
  // ORD-001: Mountain Sports — 危险订单完整里程碑
  // Phase A（全部完成）, Phase B（全部完成）, Phase C（中期验货逾期8天）
  // ──────────────────────────────────────────────────────
  const o1 = DEMO_ORDER_IDS.ord001

  // Phase A — 全部完成（按时）
  milestones.push(
    { order_id: o1, step_key: 'po_confirmed',       name: 'PO确认',    owner_role: 'sales',       planned_at: daysFromNow(-60), actual_at: daysFromNow(-60), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'finance_approval',   name: '财务审批',   owner_role: 'finance',     planned_at: daysFromNow(-58), actual_at: daysFromNow(-57), status: 'done', is_critical: true  },
    { order_id: o1, step_key: 'order_info_complete', name: '订单资料',  owner_role: 'merchandiser',planned_at: daysFromNow(-56), actual_at: daysFromNow(-55), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'purchase_order',     name: '采购单',    owner_role: 'procurement',  planned_at: daysFromNow(-54), actual_at: daysFromNow(-53), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'purchase_approval',  name: '采购审批',   owner_role: 'finance',     planned_at: daysFromNow(-52), actual_at: daysFromNow(-51), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'purchase_placed',    name: '采购下单',   owner_role: 'procurement', planned_at: daysFromNow(-50), actual_at: daysFromNow(-49), status: 'done', is_critical: true  },
    { order_id: o1, step_key: 'material_inspection',name: '原料检验',   owner_role: 'qc',          planned_at: daysFromNow(-44), actual_at: daysFromNow(-43), status: 'done', is_critical: false },
  )

  // Phase B — 全部完成
  milestones.push(
    { order_id: o1, step_key: 'pre_production_sample_ready',   name: '产前样完成',   owner_role: 'production', planned_at: daysFromNow(-38), actual_at: daysFromNow(-37), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'pre_production_sample_sent',    name: '产前样寄出',   owner_role: 'logistics',  planned_at: daysFromNow(-36), actual_at: daysFromNow(-35), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'pre_production_sample_confirm', name: '产前样确认',   owner_role: 'sales',      planned_at: daysFromNow(-30), actual_at: daysFromNow(-28), status: 'done', is_critical: false },
    { order_id: o1, step_key: 'production_kickoff',            name: '大货启动',     owner_role: 'production', planned_at: daysFromNow(-26), actual_at: daysFromNow(-25), status: 'done', is_critical: true  },
  )

  // Phase C — 中期验货逾期 8 天（核心风险点）
  milestones.push(
    {
      order_id: o1,
      step_key: 'mid_qc_check',
      name: '中期验货',
      owner_role: 'qc',
      planned_at: daysFromNow(-8),  // 计划 8 天前完成
      status: 'overdue',            // 逾期！
      is_critical: true,
      notes: `${DEMO_PREFIX} 工厂反馈：面料染色批差问题，需重新排产局部批次`,
    },
    { order_id: o1, step_key: 'mid_qc_sales_check', name: '中期验货-业务确认', owner_role: 'sales',      planned_at: daysFromNow(-6),  status: 'pending', is_critical: false },
    { order_id: o1, step_key: 'final_qc_check',     name: '尾期验货',          owner_role: 'qc',         planned_at: daysFromNow(1),   status: 'pending', is_critical: true  },
    { order_id: o1, step_key: 'packaging_ready',    name: '包装到位',          owner_role: 'production', planned_at: daysFromNow(2),   status: 'pending', is_critical: false },
    { order_id: o1, step_key: 'qc_booked',          name: 'QC预约',            owner_role: 'qc',         planned_at: daysFromNow(2),   status: 'pending', is_critical: false },
    { order_id: o1, step_key: 'qc_done',            name: 'QC完成',            owner_role: 'qc',         planned_at: daysFromNow(3),   status: 'pending', is_critical: true  },
  )

  // Phase D
  milestones.push(
    { order_id: o1, step_key: 'booking_done',     name: '订舱完成', owner_role: 'logistics', planned_at: daysFromNow(3),  status: 'pending', is_critical: true  },
    { order_id: o1, step_key: 'shipment_done',    name: '出运完成', owner_role: 'logistics', planned_at: daysFromNow(4),  status: 'pending', is_critical: true  },
  )

  // ──────────────────────────────────────────────────────
  // ORD-002: Berlin Basics — 健康对比（产前样阶段）
  // ──────────────────────────────────────────────────────
  const o2 = DEMO_ORDER_IDS.ord002
  milestones.push(
    { order_id: o2, step_key: 'po_confirmed',                  name: 'PO确认',       owner_role: 'sales',       planned_at: daysFromNow(-28), actual_at: daysFromNow(-28), status: 'done',       is_critical: false },
    { order_id: o2, step_key: 'finance_approval',              name: '财务审批',      owner_role: 'finance',     planned_at: daysFromNow(-26), actual_at: daysFromNow(-25), status: 'done',       is_critical: true  },
    { order_id: o2, step_key: 'purchase_placed',               name: '采购下单',      owner_role: 'procurement', planned_at: daysFromNow(-22), actual_at: daysFromNow(-21), status: 'done',       is_critical: true  },
    { order_id: o2, step_key: 'production_kickoff',            name: '大货启动',      owner_role: 'production',  planned_at: daysFromNow(-8),  actual_at: daysFromNow(-7),  status: 'done',       is_critical: true  },
    { order_id: o2, step_key: 'mid_qc_check',                  name: '中期验货',      owner_role: 'qc',          planned_at: daysFromNow(12),  status: 'pending',            is_critical: true  },
    { order_id: o2, step_key: 'factory_completion',            name: '工厂完成',      owner_role: 'production',  planned_at: daysFromNow(35),  status: 'pending',            is_critical: true  },
    { order_id: o2, step_key: 'booking_done',                  name: '订舱完成',      owner_role: 'logistics',   planned_at: daysFromNow(36),  status: 'pending',            is_critical: true  },
  )

  // ──────────────────────────────────────────────────────
  // ORD-003: Sydney Active — 延期申请待审批
  // ──────────────────────────────────────────────────────
  const o3 = DEMO_ORDER_IDS.ord003
  milestones.push(
    { order_id: o3, step_key: 'po_confirmed',       name: 'PO确认',    owner_role: 'sales',       planned_at: daysFromNow(-43), actual_at: daysFromNow(-43), status: 'done', is_critical: false },
    { order_id: o3, step_key: 'finance_approval',   name: '财务审批',   owner_role: 'finance',     planned_at: daysFromNow(-41), actual_at: daysFromNow(-40), status: 'done', is_critical: true  },
    { order_id: o3, step_key: 'purchase_placed',    name: '采购下单',   owner_role: 'procurement', planned_at: daysFromNow(-36), actual_at: daysFromNow(-35), status: 'done', is_critical: true  },
    { order_id: o3, step_key: 'production_kickoff', name: '大货启动',   owner_role: 'production',  planned_at: daysFromNow(-18), actual_at: daysFromNow(-17), status: 'done', is_critical: true  },
    {
      order_id: o3,
      step_key: 'mid_qc_check',
      name: '中期验货',
      owner_role: 'qc',
      planned_at: daysFromNow(-3),
      status: 'blocked',
      is_critical: true,
      notes: `${DEMO_PREFIX} 工厂申请延期14天，延期申请已提交等待审批`,
    },
    { order_id: o3, step_key: 'booking_done',   name: '订舱完成', owner_role: 'logistics', planned_at: daysFromNow(16), status: 'pending', is_critical: true },
  )

  // ──────────────────────────────────────────────────────
  // ORD-004: Tokyo Fleece — 早期安全（财务刚批）
  // ──────────────────────────────────────────────────────
  const o4 = DEMO_ORDER_IDS.ord004
  milestones.push(
    { order_id: o4, step_key: 'po_confirmed',       name: 'PO确认',   owner_role: 'sales',       planned_at: daysFromNow(-9),  actual_at: daysFromNow(-9),  status: 'done', is_critical: false },
    { order_id: o4, step_key: 'finance_approval',   name: '财务审批',  owner_role: 'finance',     planned_at: daysFromNow(-7),  actual_at: daysFromNow(-7),  status: 'done', is_critical: true  },
    { order_id: o4, step_key: 'purchase_placed',    name: '采购下单',  owner_role: 'procurement', planned_at: daysFromNow(3),   status: 'pending',            is_critical: true  },
    { order_id: o4, step_key: 'production_kickoff', name: '大货启动',  owner_role: 'production',  planned_at: daysFromNow(30),  status: 'pending',            is_critical: true  },
    { order_id: o4, step_key: 'booking_done',       name: '订舱完成',  owner_role: 'logistics',   planned_at: daysFromNow(73),  status: 'pending',            is_critical: true  },
  )

  // ──────────────────────────────────────────────────────
  // ORD-005: NYC Denim — 全部完成（待复盘）
  // ──────────────────────────────────────────────────────
  const o5 = DEMO_ORDER_IDS.ord005
  milestones.push(
    { order_id: o5, step_key: 'po_confirmed',       name: 'PO确认',   owner_role: 'sales',       planned_at: daysFromNow(-118), actual_at: daysFromNow(-118), status: 'done', is_critical: false },
    { order_id: o5, step_key: 'finance_approval',   name: '财务审批',  owner_role: 'finance',     planned_at: daysFromNow(-116), actual_at: daysFromNow(-115), status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'purchase_placed',    name: '采购下单',  owner_role: 'procurement', planned_at: daysFromNow(-110), actual_at: daysFromNow(-109), status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'production_kickoff', name: '大货启动',  owner_role: 'production',  planned_at: daysFromNow(-80),  actual_at: daysFromNow(-79),  status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'mid_qc_check',       name: '中期验货',  owner_role: 'qc',          planned_at: daysFromNow(-50),  actual_at: daysFromNow(-49),  status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'final_qc_check',     name: '尾期验货',  owner_role: 'qc',          planned_at: daysFromNow(-35),  actual_at: daysFromNow(-34),  status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'factory_completion', name: '工厂完成',  owner_role: 'production',  planned_at: daysFromNow(-32),  actual_at: daysFromNow(-31),  status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'booking_done',       name: '订舱完成',  owner_role: 'logistics',   planned_at: daysFromNow(-30),  actual_at: daysFromNow(-30),  status: 'done', is_critical: true  },
    { order_id: o5, step_key: 'shipment_done',      name: '出运完成',  owner_role: 'logistics',   planned_at: daysFromNow(-22),  actual_at: daysFromNow(-22),  status: 'done', is_critical: true  },
  )

  return milestones
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Demo Delay Requests（延期申请）
// ─────────────────────────────────────────────────────────────────────────────

function buildDelayRequests() {
  return [
    // ORD-001 — 中期验货延期申请（工厂侧）
    {
      order_id: DEMO_ORDER_IDS.ord001,
      order_no: `${DEMO_PREFIX}-ORD-001`,
      requested_by: DEMO_USERS.production.id,
      milestone_step_key: 'mid_qc_check',
      original_date: daysFromNow(-8),
      requested_date: daysFromNow(6),   // 申请延期14天
      delay_days: 14,
      reason: `${DEMO_PREFIX} 染色批差：面料供应商交付延误，局部批次需重新染色处理，预计延误14天。`,
      status: 'pending',
      created_at: tsFromNow(-2),
    },
    // ORD-003 — 生产进度延期申请
    {
      order_id: DEMO_ORDER_IDS.ord003,
      order_no: `${DEMO_PREFIX}-ORD-003`,
      requested_by: DEMO_USERS.production.id,
      milestone_step_key: 'mid_qc_check',
      original_date: daysFromNow(-3),
      requested_date: daysFromNow(11),  // 申请延期14天
      delay_days: 14,
      reason: `${DEMO_PREFIX} 工厂产能排期冲突，因另一批订单质量返工，导致本订单排期延后。`,
      status: 'pending',
      created_at: tsFromNow(-1),
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Demo Profit Snapshots（利润快照）
// ─────────────────────────────────────────────────────────────────────────────

function buildProfitSnapshots() {
  return [
    // ORD-001 — 利润预警（live 快照，因延期导致额外成本）
    {
      order_id: DEMO_ORDER_IDS.ord001,
      snapshot_type: 'live',
      revenue_cny: 168000,
      cost_cny: 154224,       // 高成本 → 利润只剩 8.2%
      margin_pct: 8.2,
      margin_status: 'warning',
      cost_breakdown: {
        material: 88000,
        labor: 42000,
        shipping: 12000,
        qc_rework: 8000,      // 返工成本（染色批差导致）
        other: 4224,
      },
      notes: `${DEMO_PREFIX} 染色返工增加约 8000 CNY 额外成本`,
      created_at: tsFromNow(-1),
    },
    // ORD-002 — 健康利润（forecast）
    {
      order_id: DEMO_ORDER_IDS.ord002,
      snapshot_type: 'forecast',
      revenue_cny: 126000,
      cost_cny: 96390,        // 利润 23.5%
      margin_pct: 23.5,
      margin_status: 'healthy',
      cost_breakdown: {
        material: 58000,
        labor: 28000,
        shipping: 8000,
        other: 2390,
      },
      notes: `${DEMO_PREFIX} 正常利润预测`,
      created_at: tsFromNow(-5),
    },
    // ORD-005 — 已完成 final 快照
    {
      order_id: DEMO_ORDER_IDS.ord005,
      snapshot_type: 'final',
      revenue_cny: 392000,
      cost_cny: 305760,       // 利润 22.0%
      margin_pct: 22.0,
      margin_status: 'healthy',
      cost_breakdown: {
        material: 195000,
        labor: 72000,
        shipping: 28000,
        other: 10760,
      },
      notes: `${DEMO_PREFIX} 最终结算利润`,
      created_at: tsFromNow(-25),
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Demo Customer Rhythm（客户画像）
// ─────────────────────────────────────────────────────────────────────────────

function buildCustomerRhythms() {
  return [
    {
      customer_name: `${DEMO_PREFIX} Mountain Sports`,
      tier: 'A',
      followup_status: 'at_risk',
      risk_score: 72,
      total_order_count: 4,
      total_order_value_usd: 180000,
      avg_order_value_usd: 45000,
      active_order_count: 1,
      last_order_at: tsFromNow(-62),
      last_contact_at: tsFromNow(-5),
      next_followup_at: tsFromNow(2),
      followup_interval_days: 7,
      risk_factors: ['交期风险', '中期验货延误', '利润低于阈值'],
      notes: `${DEMO_PREFIX} 重点客户，本次订单有延期风险，需密切跟进`,
      // P&L materializer 字段（Step 2c）
      avg_margin_pct: 12.4,
      total_revenue_cny: 680000,
      margin_trend: 'down',
      on_time_delivery_rate: 75,
      avg_deposit_delay_days: 3,
      overdue_payments: 0,
      behavior_tags: ['A类客户', '高利润客户', '长期客户'],
      profile_updated_at: tsFromNow(-1),
    },
    {
      customer_name: `${DEMO_PREFIX} Berlin Basics`,
      tier: 'B',
      followup_status: 'normal',
      risk_score: 18,
      total_order_count: 2,
      total_order_value_usd: 85000,
      avg_order_value_usd: 42500,
      active_order_count: 1,
      last_order_at: tsFromNow(-30),
      last_contact_at: tsFromNow(-8),
      next_followup_at: tsFromNow(6),
      followup_interval_days: 14,
      risk_factors: [],
      notes: `${DEMO_PREFIX} 新兴优质客户`,
      avg_margin_pct: 23.5,
      total_revenue_cny: 280000,
      margin_trend: 'up',
      on_time_delivery_rate: 100,
      avg_deposit_delay_days: 0,
      overdue_payments: 0,
      behavior_tags: ['按时付款', '高利润客户'],
      profile_updated_at: tsFromNow(-1),
    },
    {
      customer_name: `${DEMO_PREFIX} Sydney Active`,
      tier: 'B',
      followup_status: 'due',
      risk_score: 45,
      total_order_count: 3,
      total_order_value_usd: 120000,
      avg_order_value_usd: 40000,
      active_order_count: 1,
      last_order_at: tsFromNow(-45),
      last_contact_at: tsFromNow(-12),
      next_followup_at: tsFromNow(0),
      followup_interval_days: 14,
      risk_factors: ['延期申请待审批'],
      notes: `${DEMO_PREFIX} 需跟进延期处理结果`,
      avg_margin_pct: 18.2,
      total_revenue_cny: 340000,
      margin_trend: 'flat',
      on_time_delivery_rate: 67,
      avg_deposit_delay_days: 5,
      overdue_payments: 0,
      behavior_tags: ['付款慢'],
      profile_updated_at: tsFromNow(-1),
    },
    {
      customer_name: `${DEMO_PREFIX} Tokyo Fleece`,
      tier: 'C',
      followup_status: 'normal',
      risk_score: 5,
      total_order_count: 1,
      total_order_value_usd: 28000,
      avg_order_value_usd: 28000,
      active_order_count: 1,
      last_order_at: tsFromNow(-10),
      last_contact_at: tsFromNow(-10),
      next_followup_at: tsFromNow(4),
      followup_interval_days: 14,
      risk_factors: [],
      notes: `${DEMO_PREFIX} 新客户首单`,
      avg_margin_pct: 0,           // 尚无历史数据
      total_revenue_cny: 0,
      margin_trend: 'unknown',
      on_time_delivery_rate: 100,
      avg_deposit_delay_days: 0,
      overdue_payments: 0,
      behavior_tags: ['新客户'],
      profile_updated_at: tsFromNow(-1),
    },
    {
      customer_name: `${DEMO_PREFIX} NYC Denim`,
      tier: 'A',
      followup_status: 'normal',
      risk_score: 10,
      total_order_count: 6,
      total_order_value_usd: 420000,
      avg_order_value_usd: 70000,
      active_order_count: 0,
      last_order_at: tsFromNow(-120),
      last_contact_at: tsFromNow(-6),
      next_followup_at: tsFromNow(8),
      followup_interval_days: 14,
      risk_factors: [],
      notes: `${DEMO_PREFIX} 老牌战略客户，最新一单已完成待复盘`,
      avg_margin_pct: 21.8,
      total_revenue_cny: 1540000,
      margin_trend: 'flat',
      on_time_delivery_rate: 83,
      avg_deposit_delay_days: 2,
      overdue_payments: 0,
      behavior_tags: ['A类客户', '长期客户', '按时付款', '高利润客户'],
      profile_updated_at: tsFromNow(-1),
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Demo Daily Tasks（今日任务）
// ─────────────────────────────────────────────────────────────────────────────

function buildDailyTasks() {
  const today = daysFromNow(0)
  return [
    // CEO / admin 任务
    {
      assigned_to: DEMO_USERS.ceo.id,
      task_date: today,
      task_type: 'milestone_overdue',
      source_type: 'milestone',
      source_id: `${DEMO_ORDER_IDS.ord001}:mid_qc_check`,
      priority: 1,
      title: `【逾期8天】中期验货 — ${DEMO_PREFIX}-ORD-001`,
      description: `客户：${DEMO_PREFIX} Mountain Sports，计划日期：${daysFromNow(-8)}，出厂日仅剩4天`,
      action_url: `/orders/${DEMO_ORDER_IDS.ord001}`,
      related_order_id: DEMO_ORDER_IDS.ord001,
      related_customer: `${DEMO_PREFIX} Mountain Sports`,
      escalate_count: 2,
      status: 'pending',
    },
    {
      assigned_to: DEMO_USERS.ceo.id,
      task_date: today,
      task_type: 'delay_approval',
      source_type: 'delay_request',
      source_id: `delay:${DEMO_ORDER_IDS.ord001}`,
      priority: 1,
      title: `待审批延期：${DEMO_PREFIX}-ORD-001（等待2天）`,
      description: `工厂申请延期14天，染色批差问题，出厂日剩余4天`,
      action_url: `/orders/${DEMO_ORDER_IDS.ord001}`,
      related_order_id: DEMO_ORDER_IDS.ord001,
      related_customer: `${DEMO_PREFIX} Mountain Sports`,
      escalate_count: 0,
      status: 'pending',
    },
    {
      assigned_to: DEMO_USERS.ceo.id,
      task_date: today,
      task_type: 'profit_warning',
      source_type: 'profit_snapshot',
      source_id: DEMO_ORDER_IDS.ord001,
      priority: 1,
      title: `利润预警：${DEMO_PREFIX}-ORD-001 利润率仅 8.2%`,
      description: `低于阈值 12%，染色返工导致额外成本 8000 CNY`,
      action_url: `/orders/${DEMO_ORDER_IDS.ord001}`,
      related_order_id: DEMO_ORDER_IDS.ord001,
      related_customer: `${DEMO_PREFIX} Mountain Sports`,
      escalate_count: 0,
      status: 'pending',
    },
    // Sales 任务
    {
      assigned_to: DEMO_USERS.sales.id,
      task_date: today,
      task_type: 'customer_followup',
      source_type: 'customer_rhythm',
      source_id: `${DEMO_PREFIX} Mountain Sports`,
      priority: 1,
      title: `客户跟进到期：${DEMO_PREFIX} Mountain Sports（at_risk）`,
      description: `跟进状态：高风险，上次联系：5天前，建议今日沟通延期情况`,
      action_url: `/customers`,
      related_customer: `${DEMO_PREFIX} Mountain Sports`,
      escalate_count: 0,
      status: 'pending',
    },
    {
      assigned_to: DEMO_USERS.sales.id,
      task_date: today,
      task_type: 'customer_followup',
      source_type: 'customer_rhythm',
      source_id: `${DEMO_PREFIX} Sydney Active`,
      priority: 2,
      title: `客户跟进到期：${DEMO_PREFIX} Sydney Active`,
      description: `跟进状态：due，延期申请待处理，需告知客户最新进展`,
      action_url: `/customers`,
      related_customer: `${DEMO_PREFIX} Sydney Active`,
      escalate_count: 0,
      status: 'pending',
    },
    // Production 任务
    {
      assigned_to: DEMO_USERS.production.id,
      task_date: today,
      task_type: 'milestone_overdue',
      source_type: 'milestone',
      source_id: `${DEMO_ORDER_IDS.ord001}:mid_qc_check`,
      priority: 1,
      title: `【逾期8天】中期验货 — ${DEMO_PREFIX}-ORD-001`,
      description: `需立即安排重检或提交延期申请，出厂日仅剩4天`,
      action_url: `/orders/${DEMO_ORDER_IDS.ord001}`,
      related_order_id: DEMO_ORDER_IDS.ord001,
      related_customer: `${DEMO_PREFIX} Mountain Sports`,
      escalate_count: 2,
      status: 'pending',
    },
    // 复盘任务（ORD-005 完成后未复盘）
    {
      assigned_to: DEMO_USERS.sales.id,
      task_date: today,
      task_type: 'decision_required',
      source_type: 'order',
      source_id: DEMO_ORDER_IDS.ord005,
      priority: 2,
      title: `${DEMO_PREFIX}-ORD-005 待复盘（完成 30 天）`,
      description: `客户：${DEMO_PREFIX} NYC Denim，建议本周完成复盘`,
      action_url: `/orders/${DEMO_ORDER_IDS.ord005}/retrospective`,
      related_order_id: DEMO_ORDER_IDS.ord005,
      related_customer: `${DEMO_PREFIX} NYC Denim`,
      escalate_count: 1,
      status: 'pending',
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Demo Runtime Orders（交付置信度）
// ─────────────────────────────────────────────────────────────────────────────

function buildRuntimeOrders() {
  return [
    {
      order_id: DEMO_ORDER_IDS.ord001,
      delivery_confidence: 32,
      risk_level: 'red',
      explain_json: {
        headline: '🔴 交付风险高（32%）',
        reasons: [
          { type: 'milestone_overdue', label: '关键节点【中期验货】已超期 8 天(-25)', delta: -25 },
          { type: 'factory_date_passed', label: '出厂日仅剩4天，货物尚未验货(-28)', delta: -28 },
          { type: 'profit_warning', label: '利润率跌至 8.2%，低于阈值(-15)', delta: -15 },
        ],
        next_blocker: 'mid_qc_check',
        next_action: '生产部门立即推进【中期验货】，或提交延期申请并告知客户，业务需今日联系客户',
        computed_at: tsFromNow(-1),
      },
      version: 3,
      updated_at: tsFromNow(-1),
    },
    {
      order_id: DEMO_ORDER_IDS.ord002,
      delivery_confidence: 78,
      risk_level: 'yellow',
      explain_json: {
        headline: '🟡 按计划推进（78%）',
        reasons: [
          { type: 'schedule_tight', label: '距出厂日38天，中期验货尚未开始(-22)', delta: -22 },
        ],
        next_blocker: 'mid_qc_check',
        next_action: '品控按计划安排中期验货，关注排期',
        computed_at: tsFromNow(-1),
      },
      version: 1,
      updated_at: tsFromNow(-1),
    },
    {
      order_id: DEMO_ORDER_IDS.ord003,
      delivery_confidence: 55,
      risk_level: 'orange',
      explain_json: {
        headline: '🟠 存在风险（55%）',
        reasons: [
          { type: 'critical_blocked_no_resolution', label: '关键节点【中期验货】已 blocked，延期申请待审批(-30)', delta: -30 },
          { type: 'delay_request_pending', label: '延期申请等待2天未处理(-15)', delta: -15 },
        ],
        next_blocker: 'mid_qc_check',
        next_action: 'CEO/admin 尽快审批延期申请，明确新出厂日期',
        computed_at: tsFromNow(-1),
      },
      version: 2,
      updated_at: tsFromNow(-1),
    },
    {
      order_id: DEMO_ORDER_IDS.ord004,
      delivery_confidence: 91,
      risk_level: 'green',
      explain_json: {
        headline: '🟢 准时交付（91%）',
        reasons: [
          { type: 'minor_admin_delay', label: '采购下单还未开始（计划3天后）(-9)', delta: -9 },
        ],
        next_blocker: 'purchase_placed',
        next_action: '采购部门按计划3天内完成采购下单',
        computed_at: tsFromNow(-1),
      },
      version: 1,
      updated_at: tsFromNow(-1),
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Seed 执行器（幂等：先清除 [DEMO] 数据，再插入）
// ─────────────────────────────────────────────────────────────────────────────

async function cleanupDemoData(supabase: ReturnType<typeof createClient>) {
  console.log('\n🧹 清理旧 Demo 数据...')

  // 清除顺序：先子表，后主表（避免外键约束冲突）
  const cleanupSteps = [
    { table: 'runtime_orders',        filter: { col: 'order_id', in: Object.values(DEMO_ORDER_IDS) } },
    { table: 'daily_tasks',           filter: { col: 'related_order_id', in: Object.values(DEMO_ORDER_IDS) } },
    { table: 'profit_snapshots',      filter: { col: 'order_id', in: Object.values(DEMO_ORDER_IDS) } },
    { table: 'delay_requests',        filter: { col: 'order_id', in: Object.values(DEMO_ORDER_IDS) } },
    { table: 'milestones',            filter: { col: 'order_id', in: Object.values(DEMO_ORDER_IDS) } },
    { table: 'customer_rhythm',       filter: { col: 'customer_name', like: `${DEMO_PREFIX}%` } },
    { table: 'orders',                filter: { col: 'order_no', like: `${DEMO_PREFIX}%` } },
    { table: 'profiles',              filter: { col: 'user_id', in: Object.values(DEMO_USERS).map(u => u.id) } },
  ]

  for (const step of cleanupSteps) {
    let query = (supabase.from(step.table) as any).delete()
    if ('in' in step.filter) {
      query = query.in(step.filter.col, step.filter.in)
    } else if ('like' in step.filter) {
      query = query.like(step.filter.col, step.filter.like)
    }
    const { error } = await query
    if (error) {
      console.warn(`  ⚠️  清理 ${step.table} 时出现警告（可忽略首次运行）: ${error.message}`)
    } else {
      console.log(`  ✅ 清理 ${step.table}`)
    }
  }
}

async function insertDemoData(supabase: ReturnType<typeof createClient>) {
  console.log('\n📦 插入 Demo 数据...\n')

  const profiles    = buildProfiles()
  const orders      = buildOrders()
  const milestones  = buildMilestones()
  const delays      = buildDelayRequests()
  const snapshots   = buildProfitSnapshots()
  const rhythms     = buildCustomerRhythms()
  const tasks       = buildDailyTasks()
  const runtimes    = buildRuntimeOrders()

  const steps = [
    { name: 'profiles',        data: profiles,   table: 'profiles' },
    { name: 'orders',          data: orders,     table: 'orders' },
    { name: 'milestones',      data: milestones, table: 'milestones' },
    { name: 'delay_requests',  data: delays,     table: 'delay_requests' },
    { name: 'profit_snapshots',data: snapshots,  table: 'profit_snapshots' },
    { name: 'customer_rhythm', data: rhythms,    table: 'customer_rhythm' },
    { name: 'daily_tasks',     data: tasks,      table: 'daily_tasks' },
    { name: 'runtime_orders',  data: runtimes,   table: 'runtime_orders' },
  ]

  for (const step of steps) {
    const { error } = await (supabase.from(step.table) as any).insert(step.data)
    if (error) {
      throw new Error(`❌ 插入 ${step.name} 失败: ${error.message}`)
    }
    console.log(`  ✅ ${step.name}: 插入 ${step.data.length} 条`)
  }
}

function printDryRunSummary() {
  const profiles    = buildProfiles()
  const orders      = buildOrders()
  const milestones  = buildMilestones()
  const delays      = buildDelayRequests()
  const snapshots   = buildProfitSnapshots()
  const rhythms     = buildCustomerRhythms()
  const tasks       = buildDailyTasks()
  const runtimes    = buildRuntimeOrders()

  console.log('\n📊 Dry-run 模式 — 将插入的数据概览：\n')
  console.log(`  profiles:         ${profiles.length} 条`)
  console.log(`  orders:           ${orders.length} 条`)
  console.log(`  milestones:       ${milestones.length} 条`)
  console.log(`  delay_requests:   ${delays.length} 条`)
  console.log(`  profit_snapshots: ${snapshots.length} 条`)
  console.log(`  customer_rhythm:  ${rhythms.length} 条`)
  console.log(`  daily_tasks:      ${tasks.length} 条`)
  console.log(`  runtime_orders:   ${runtimes.length} 条`)
  console.log(`\n  合计: ${profiles.length + orders.length + milestones.length + delays.length + snapshots.length + rhythms.length + tasks.length + runtimes.length} 条\n`)

  console.log('📋 Orders 预览：')
  buildOrders().forEach(o => {
    console.log(`  ${o.order_no} | ${o.customer_name} | lifecycle=${o.lifecycle_status} | factory_date=${o.factory_date}`)
  })

  console.log('\n📋 Tasks 预览（按优先级）：')
  buildDailyTasks()
    .sort((a, b) => a.priority - b.priority)
    .forEach(t => {
      console.log(`  [P${t.priority}] ${t.task_type.padEnd(20)} | ${t.title.substring(0, 60)}`)
    })

  console.log('\n💡 实际执行请加 --execute 参数（同时确保 DEMO_SEED_CONFIRM=YES_I_AM_SEEDING_DEMO）')
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. 入口
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Trade Agent OS — Demo Seed Script')
  console.log(`   URL: ${DEMO_URL!.replace(/^(https:\/\/[a-z]{8}).*/, '$1****')}`)
  console.log(`   Mode: ${DRY_RUN ? '🔍 DRY RUN（只打印，不写入）' : '⚡ EXECUTE（实际写入）'}`)
  console.log(`   Today: ${daysFromNow(0)}\n`)

  if (DRY_RUN) {
    printDryRunSummary()
    return
  }

  // 实际执行模式
  const supabase = createClient(DEMO_URL!, DEMO_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  await cleanupDemoData(supabase)
  await insertDemoData(supabase)

  console.log('\n🎉 Demo seed 完成！')
  console.log('\n后续步骤：')
  console.log('  1. 在 Demo project 手动创建 Auth users（见脚本顶部 TODO）')
  console.log('  2. 将真实 user_id 填入 DEMO_USERS 常量后重新运行')
  console.log('  3. 访问 Demo 系统验证 3 条演示流程：')
  console.log('     • CEO 巡检：Dashboard → ORD-001 红色风险卡（2分钟）')
  console.log('     • 业务处理：我的今日 → 任务 → 延期申请（3分钟）')
  console.log('     • 生产协调：我的今日 → 里程碑更新 → 置信度回升（2分钟）')
}

main().catch((err) => {
  console.error('\n💥 Seed 脚本异常退出：', err.message)
  process.exit(1)
})
