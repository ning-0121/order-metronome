// ============================================================
// Overdue Attribution V1 —— 逾期归属与三桶语义(纯函数,零 DB / 零 auth / 零 IO)
//
// 起因(2026-08-17 生产实测,79 张在途单 / 237 个逾期节点):
//   · owner_role 只有 49% 是 merchandiser,**51% 属于别的部门**
//   · **88 个(37%)status 已经是 blocked**,系统自己标了阻塞却仍在催
//   · 督办总览那一行显示的是 `business.owner`(业务段负责人),
//     不管逾期节点归谁 → 列表点名 Winnie,而卡住的是 财务 PO确认 + 采购下单。
//     Winnie 的个人看板里那两个节点根本不出现 → 她只能回「已处理,但系统还显示逾期」。
//
// CEO 拍板的核心模型:**系统不能只有一个「逾期」**。
//
//   ACTIONABLE_OVERDUE  现在轮到这个人做,且已过应做时间  → 算当前节点责任人
//   BLOCKED             做不了,在等别人/客户/前置事实      → 算 blocker,不算被阻塞的人
//   DELIVERY_RISK       订单整体有交付风险                  → 订单级,不作为个人逾期
//
// 目标不是「把 237 变小」,而是让系统准确回答:
//   ① 现在谁能行动 ② 谁在阻塞 ③ 哪张单有交付风险 ④ 哪些只需知情不该计入绩效
//
// ⚠️ 本模块只做 **read-time attribution**:不改 status、不回填 done、不动 due_at。
// ⚠️ blocker **禁止猜**:证据不足一律 UNKNOWN。猜错人比不知道更伤人。
// ============================================================

import { unmetPrerequisites } from './milestoneDeps';

export type OverdueBucket =
  /** 当前责任人现在就能动,且已过期 —— 唯一可用于个人 KPI 的桶 */
  | 'ACTIONABLE_OVERDUE'
  /** 在等前置/别人/客户 —— 进独立「阻塞中」桶,不进个人逾期主数字 */
  | 'BLOCKED';

/** 归属解析链:owner_user_id → owner_role → UNASSIGNED。**禁止回落到订单业务负责人。** */
export type AttributionKind = 'user' | 'role' | 'unassigned';

export interface Attribution {
  kind: AttributionKind;
  userId: string | null;
  role: string | null;
  /** UI 直接可显示:「张三」/「财务(待分配到人)」/「未分配 —— 责任配置异常」 */
  label: string;
  /** kind==='unassigned' 时为 true —— 这是配置缺陷,要能被单独统计出来 */
  isOwnershipDefect: boolean;
}

/** blocker 证据强度:强 → 弱。够不到就是 UNKNOWN,不许编。 */
export type BlockerEvidence =
  /** 有未完成的前置节点,且该节点有明确责任人 */
  | 'PREREQUISITE_OWNER'
  /** 有未完成的前置节点,但只知道它属于哪个部门 */
  | 'PREREQUISITE_ROLE'
  /** 没有可解析的前置,只有人填的「卡住原因」文字 */
  | 'REASON_TEXT_ONLY'
  /** 什么证据都没有 */
  | 'UNKNOWN';

export interface BlockerInfo {
  evidence: BlockerEvidence;
  /** 等谁(能解析到人时) */
  blockedByUserId: string | null;
  /** 等哪个部门 */
  blockedByRole: string | null;
  /** 等哪个前置节点 */
  blockedByStepKey: string | null;
  blockedByStepName: string | null;
  /** 人填的卡住原因原文(notes 里 `卡住原因：` 之后的部分) */
  reason: string | null;
  /** UI 直接可显示:「等 财务 完成 PO确认」/「原因:客人未回复(待确认 blocker)」/「未识别」 */
  label: string;
}

export interface MilestoneLike {
  id?: string;
  step_key?: string | null;
  name?: string | null;
  status?: string | null;
  due_at?: string | null;
  owner_user_id?: string | null;
  owner_role?: string | null;
  notes?: string | null;
  sequence_number?: number | null;
}

export interface AttributedMilestone {
  milestone: MilestoneLike;
  bucket: OverdueBucket;
  attribution: Attribution;
  /** 仅 BLOCKED 有值 */
  blocker: BlockerInfo | null;
  overdueDays: number;
}

const DONE = new Set(['done', '已完成', 'completed']);
export const isDoneStatus = (s: unknown): boolean => DONE.has(String(s ?? ''));

/** 部门中文名(仅用于展示;未知角色原样显示,不猜) */
const ROLE_LABEL: Record<string, string> = {
  sales: '业务', merchandiser: '跟单', finance: '财务', procurement: '采购',
  production: '生产', qc: '品控', quality: '品控', logistics: '物流',
  admin: '管理员', admin_assistant: '行政督办',
  production_manager: '生产主管', sales_manager: '业务主管',
  order_manager: '订单主管', procurement_manager: '采购主管',
};
export const roleLabel = (r?: string | null): string => {
  const k = String(r ?? '').trim();
  if (!k) return '';
  return ROLE_LABEL[k] || k;
};

const BLOCKED_PREFIX = '卡住原因：';

/** 从 notes 里取「卡住原因」原文(blocked_reason 列已废弃,统一存 notes)。 */
export function extractBlockedReason(notes?: string | null): string | null {
  const raw = String(notes ?? '');
  const i = raw.indexOf(BLOCKED_PREFIX);
  if (i < 0) return null;
  const rest = raw.slice(i + BLOCKED_PREFIX.length).split('\n')[0].trim();
  return rest || null;
}

/**
 * 归属解析。**唯一入口** —— 任何地方要问「这个逾期算谁的」,都必须走这里。
 *
 * 铁律:不许回落到订单业务负责人(business.owner)。
 * 那是「订单协调人」,不是「这个节点的责任人」。混用正是 Winnie 被点名的根因。
 */
export function resolveAttribution(
  m: MilestoneLike,
  nameByUserId?: Map<string, string> | null,
): Attribution {
  const userId = String(m.owner_user_id ?? '').trim() || null;
  if (userId) {
    const nm = nameByUserId?.get(userId);
    return {
      kind: 'user', userId, role: m.owner_role ?? null,
      label: nm || `用户 ${userId.slice(0, 8)}`,
      isOwnershipDefect: false,
    };
  }
  const role = String(m.owner_role ?? '').trim() || null;
  if (role) {
    return {
      kind: 'role', userId: null, role,
      label: `${roleLabel(role)}(待分配到人)`,
      isOwnershipDefect: false,
    };
  }
  return {
    kind: 'unassigned', userId: null, role: null,
    label: '未分配 —— 责任配置异常',
    isOwnershipDefect: true,
  };
}

/**
 * blocker 解析,按证据强度降级。**任何一级都不允许猜。**
 *
 * 强 → 弱:
 *   ① 有未完成前置节点 + 该节点有 owner_user_id  → PREREQUISITE_OWNER(等某人)
 *   ② 有未完成前置节点,只有 owner_role           → PREREQUISITE_ROLE(等某部门)
 *   ③ 无可解析前置,只有人填的文字原因            → REASON_TEXT_ONLY(显示原文,blocker 待确认)
 *   ④ 什么都没有                                  → UNKNOWN
 */
export function resolveBlocker(
  m: MilestoneLike,
  orderMilestones: MilestoneLike[],
  nameByUserId?: Map<string, string> | null,
): BlockerInfo {
  const reason = extractBlockedReason(m.notes);
  const stepKey = String(m.step_key ?? '').trim();

  if (stepKey) {
    const unmet = unmetPrerequisites(
      stepKey,
      orderMilestones.map((x) => ({
        step_key: String(x.step_key ?? ''), status: String(x.status ?? ''), name: x.name ?? null,
      })),
      isDoneStatus,
    );
    if (unmet.length > 0) {
      // 多个未完成前置时取第一个(MILESTONE_PREREQUISITES 的顺序即业务顺序)
      const first = unmet[0];
      const prereq = orderMilestones.find((x) => String(x.step_key ?? '') === first.step_key);
      const pUser = String(prereq?.owner_user_id ?? '').trim() || null;
      const pRole = String(prereq?.owner_role ?? '').trim() || null;
      if (pUser) {
        const nm = nameByUserId?.get(pUser);
        return {
          evidence: 'PREREQUISITE_OWNER',
          blockedByUserId: pUser, blockedByRole: pRole,
          blockedByStepKey: first.step_key, blockedByStepName: first.name,
          reason,
          label: `等 ${nm || roleLabel(pRole) || '负责人'} 完成「${first.name}」`,
        };
      }
      if (pRole) {
        return {
          evidence: 'PREREQUISITE_ROLE',
          blockedByUserId: null, blockedByRole: pRole,
          blockedByStepKey: first.step_key, blockedByStepName: first.name,
          reason,
          label: `等 ${roleLabel(pRole)} 完成「${first.name}」`,
        };
      }
      // 前置存在但它自己也没有责任人 —— 仍然是有效信息,但 blocker 只到节点
      return {
        evidence: 'PREREQUISITE_ROLE',
        blockedByUserId: null, blockedByRole: null,
        blockedByStepKey: first.step_key, blockedByStepName: first.name,
        reason,
        label: `等「${first.name}」完成(该节点未分配责任人)`,
      };
    }
  }

  if (reason) {
    return {
      evidence: 'REASON_TEXT_ONLY',
      blockedByUserId: null, blockedByRole: null,
      blockedByStepKey: null, blockedByStepName: null,
      reason,
      label: `原因:${reason}(blocker 待确认)`,
    };
  }

  return {
    evidence: 'UNKNOWN',
    blockedByUserId: null, blockedByRole: null,
    blockedByStepKey: null, blockedByStepName: null,
    reason: null,
    label: '阻塞原因未识别 —— 需人工确认',
  };
}

/** 是否「已过应做时间且未完成」。DELIVERY_RISK 是订单级,不在这里判。 */
export function isOverdue(m: MilestoneLike, now: number): boolean {
  if (isDoneStatus(m.status)) return false;
  if (!m.due_at) return false;
  return new Date(m.due_at).getTime() < now;
}

export function overdueDaysOf(m: MilestoneLike, now: number): number {
  if (!m.due_at) return 0;
  return Math.max(0, Math.floor((now - new Date(m.due_at).getTime()) / 86400000));
}

/**
 * 单个逾期节点分桶。
 *
 * BLOCKED 的判定**不只看 status**:status='blocked' 固然是,
 * 但「有未完成前置节点」同样意味着这个人现在做不了 —— 催他没有意义。
 * (V3 部门线有硬前置;软前置见 MILESTONE_PREREQUISITES。)
 *
 * 这解决了 2026-05-18 那次回滚的担心:blocked **不消失**,只是不再压在
 * 被阻塞的人头上;它进独立桶,并且必须回答「等谁」。
 */
export function classifyOverdue(
  m: MilestoneLike,
  orderMilestones: MilestoneLike[],
  now: number,
  nameByUserId?: Map<string, string> | null,
): AttributedMilestone {
  const attribution = resolveAttribution(m, nameByUserId);
  const overdueDays = overdueDaysOf(m, now);

  const explicitlyBlocked = String(m.status ?? '') === 'blocked';
  const blocker = resolveBlocker(m, orderMilestones, nameByUserId);
  const hasPrereqBlock = blocker.evidence === 'PREREQUISITE_OWNER' || blocker.evidence === 'PREREQUISITE_ROLE';

  if (explicitlyBlocked || hasPrereqBlock) {
    return { milestone: m, bucket: 'BLOCKED', attribution, blocker, overdueDays };
  }
  return { milestone: m, bucket: 'ACTIONABLE_OVERDUE', attribution, blocker: null, overdueDays };
}

/** 整单一次算完(前置解析要看同单其它节点,逐个调用会 O(n²) 且容易漏传上下文)。 */
export function attributeOrderOverdue(
  orderMilestones: MilestoneLike[],
  now: number,
  nameByUserId?: Map<string, string> | null,
): AttributedMilestone[] {
  const out: AttributedMilestone[] = [];
  for (const m of orderMilestones) {
    if (!isOverdue(m, now)) continue;
    out.push(classifyOverdue(m, orderMilestones, now, nameByUserId));
  }
  return out;
}

// ── 订单级交付风险(DELIVERY_RISK)────────────────────────────────
// 刻意与个人归属**完全解耦**:它衡量的是「这张单有没有交付风险」,
// 不回答「谁的错」。用于 CEO/督办视角与「我负责订单的其他风险」知情区。

export type DeliveryRiskLevel = 'none' | 'at_risk' | 'late';

/**
 * 出厂日已过天数。
 *
 * ⚠️ 口径必须与 `lib/services/stale-order-triage.ts` 和订单列表「出厂日已过」横幅
 * (`app/orders/page.tsx`)**逐字一致**:以出厂日当天 23:59:59 为界 + `Math.ceil`。
 * 那边的原话:两处口径不同会出现同一张单这边「已过 37 天」、那边「已过 38 天」,
 * 看的人会怀疑数据。`tests/overdue-attribution.test.ts` 里有测试把两者锁在一起。
 */
export function pastFactoryDaysOf(factoryDate: string | null, now: number): number | null {
  if (!factoryDate) return null;
  return Math.ceil((now - new Date(`${String(factoryDate).slice(0, 10)}T23:59:59`).getTime()) / 86400000);
}

export interface OrderDeliveryRisk {
  level: DeliveryRiskLevel;
  /** 出厂日已过天数(未过/缺失为 null) */
  pastFactoryDays: number | null;
  actionableCount: number;
  blockedCount: number;
  /** 说人话,可直接显示 */
  reason: string;
}

export function assessDeliveryRisk(input: {
  factoryDate: string | null;
  attributed: AttributedMilestone[];
  now: number;
}): OrderDeliveryRisk {
  const { factoryDate, attributed, now } = input;
  const actionableCount = attributed.filter((a) => a.bucket === 'ACTIONABLE_OVERDUE').length;
  const blockedCount = attributed.filter((a) => a.bucket === 'BLOCKED').length;

  const d = pastFactoryDaysOf(factoryDate, now);
  const pastFactoryDays = d != null && d > 0 ? d : null;

  if (pastFactoryDays != null) {
    return {
      level: 'late', pastFactoryDays, actionableCount, blockedCount,
      reason: `出厂日已过 ${pastFactoryDays} 天` +
        (actionableCount || blockedCount ? `,仍有 ${actionableCount} 项待办、${blockedCount} 项阻塞` : ''),
    };
  }
  if (actionableCount > 0 || blockedCount > 0) {
    return {
      level: 'at_risk', pastFactoryDays: null, actionableCount, blockedCount,
      reason: `出厂日未到,但已有 ${actionableCount} 项逾期待办、${blockedCount} 项阻塞`,
    };
  }
  return { level: 'none', pastFactoryDays: null, actionableCount: 0, blockedCount: 0, reason: '无逾期节点' };
}

// ── 个人三层视图 ────────────────────────────────────────────────
// 禁止把订单所有跨部门逾期塞回跟单个人待办 —— 那只是把
// 「看不见别人的问题」换成「所有人的问题都堆给跟单」。

export interface PersonalView {
  /** ① 我的待处理:owner 是我且 actionable —— **唯一可计入个人 KPI 的** */
  mine: AttributedMilestone[];
  /** ② 正在卡我的:别人没做完,导致我下一步开不了 */
  blockingMe: AttributedMilestone[];
  /** ③ 我负责订单的其他风险:只读知情,**不计入个人 overdue/KPI** */
  awareness: AttributedMilestone[];
}

/**
 * 切个人三层视图。
 *
 * @param myUserId        当前用户
 * @param ownedOrderIds   我作为订单负责人/协调人的订单(用于 ③ 知情区)
 * @param byOrder         订单 → 该单全部逾期归属结果
 * @param myMinSeqByOrder 我在该单最早未完成节点的 sequence_number(判「卡在我前面」)
 */
export function buildPersonalView(input: {
  myUserId: string;
  ownedOrderIds: Set<string>;
  byOrder: Map<string, AttributedMilestone[]>;
  myMinSeqByOrder: Map<string, number>;
}): PersonalView {
  const { myUserId, ownedOrderIds, byOrder, myMinSeqByOrder } = input;
  const mine: AttributedMilestone[] = [];
  const blockingMe: AttributedMilestone[] = [];
  const awareness: AttributedMilestone[] = [];

  for (const [orderId, list] of byOrder) {
    const myMinSeq = myMinSeqByOrder.get(orderId);
    for (const a of list) {
      const isMine = a.attribution.kind === 'user' && a.attribution.userId === myUserId;
      if (isMine) {
        // 我的节点但被前置卡住 → 不算「我的待处理」(催我没用),进「正在卡我的」
        if (a.bucket === 'ACTIONABLE_OVERDUE') mine.push(a);
        else blockingMe.push(a);
        continue;
      }
      // 别人的节点:排在我最早未完成节点**之前** → 正在卡我
      const seq = Number(a.milestone.sequence_number);
      if (myMinSeq != null && Number.isFinite(seq) && seq <= myMinSeq) {
        blockingMe.push(a);
        continue;
      }
      // 其余:我负责的订单才给知情;不是我的单就不该出现在我的页面上
      if (ownedOrderIds.has(orderId)) awareness.push(a);
    }
  }
  return { mine, blockingMe, awareness };
}

// ── 汇总(督办/CEO 视角)──────────────────────────────────────────

export interface AttributionSummary {
  totalOverdue: number;
  actionable: number;
  blocked: number;
  /** 责任配置异常(既无 owner_user_id 也无 owner_role) */
  unassigned: number;
  /** actionable 按责任部门 */
  actionableByRole: Record<string, number>;
  /** blocked 按 blocker 部门(UNKNOWN 单列) */
  blockedByBlockerRole: Record<string, number>;
  /** blocked 按证据强度 —— 用来看「有多少是真说得清等谁」 */
  blockedByEvidence: Record<BlockerEvidence, number>;
}

export function summarize(all: AttributedMilestone[]): AttributionSummary {
  const s: AttributionSummary = {
    totalOverdue: all.length, actionable: 0, blocked: 0, unassigned: 0,
    actionableByRole: {}, blockedByBlockerRole: {},
    blockedByEvidence: { PREREQUISITE_OWNER: 0, PREREQUISITE_ROLE: 0, REASON_TEXT_ONLY: 0, UNKNOWN: 0 },
  };
  for (const a of all) {
    if (a.attribution.isOwnershipDefect) s.unassigned++;
    if (a.bucket === 'ACTIONABLE_OVERDUE') {
      s.actionable++;
      const r = a.attribution.role || '(无角色)';
      s.actionableByRole[r] = (s.actionableByRole[r] || 0) + 1;
    } else {
      s.blocked++;
      const br = a.blocker?.blockedByRole || (a.blocker?.evidence === 'UNKNOWN' ? '(未识别)' : '(待确认)');
      s.blockedByBlockerRole[br] = (s.blockedByBlockerRole[br] || 0) + 1;
      if (a.blocker) s.blockedByEvidence[a.blocker.evidence]++;
    }
  }
  return s;
}
