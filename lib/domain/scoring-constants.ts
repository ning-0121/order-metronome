/**
 * 评分标准 — 单一真实来源
 *
 * ⚠️ 此文件锁定提成工资计算的核心标准
 * 修改前必须经过 CEO 确认，因为这直接影响员工实际工资发放
 */

export const SCORING_CONFIG = {
  /** 节拍准时（最高40分） */
  ontime: {
    max: 40,
    /** 每个超期节点扣分（legacy·聚合估算用，analytics.ts） */
    perOverduePenalty: 8,
    /** 每个超期【关键】节点扣分（2026-07-25 CEO 批：关键/非关键分权重） */
    criticalPenalty: 8,
    /** 每个超期【非关键】节点扣分 */
    nonCriticalPenalty: 3,
    /** 逾期若经审批归为这些（非本人可控）原因 → 不扣准时分（归责豁免打通，2026-07-25 CEO 批） */
    exemptCategories: ['customer', 'supplier', 'force_majeure'] as const,
  },

  /** 零阻塞（最高20分） */
  noBlock: {
    max: 20,
    /** 每个阻塞节点扣分 */
    perBlockPenalty: 10,
  },

  /** 延期控制（最高15分） */
  noDelay: {
    max: 15,
    /** 每个延期申请扣分 */
    perDelayPenalty: 5,
  },

  /** 质量（最高15分，共享） */
  quality: {
    max: 15,
    midBlockedPenalty: 5,
    finalBlockedPenalty: 10,
  },

  /** 交付（最高10分，共享） */
  delivery: {
    max: 10,
    /** 0天逾期 = 满分 */
    onTimeScore: 10,
    /** 1-3天逾期 */
    minorDelayScore: 5,
    /** 4-7天逾期 */
    moderateDelayScore: 0,
    /** 8天+逾期 */
    severeDelayScore: -5,
  },

  /** 总分上限 */
  totalMax: 110,

  /** 等级阈值 */
  grades: {
    S: 100,
    A: 90,
    B: 80,
    C: 70,
    D: 0,
  },
} as const;

/**
 * 角色映射 — 哪些角色归到哪个评分组
 */
export const ROLE_GROUPS = {
  /** 业务评分 */
  sales: ['sales'] as const,
  /** 跟单评分（含生产/QC/质量） */
  merchandiser: ['merchandiser', 'production', 'qc', 'quality'] as const,
  /** 采购评分 */
  procurement: ['procurement'] as const,
  /** 财务评分 */
  finance: ['finance'] as const,
  /** 物流评分 */
  logistics: ['logistics'] as const,
} as const;

/**
 * 计算等级
 */
export function calcGrade(total: number): 'S' | 'A' | 'B' | 'C' | 'D' {
  if (total >= SCORING_CONFIG.grades.S) return 'S';
  if (total >= SCORING_CONFIG.grades.A) return 'A';
  if (total >= SCORING_CONFIG.grades.B) return 'B';
  if (total >= SCORING_CONFIG.grades.C) return 'C';
  return 'D';
}

/**
 * 准时分扣分（2026-07-25 CEO 批的评分尺度）。纯函数,便于单测。
 *   - 关键节点逾期重扣、非关键轻扣;
 *   - exempt=true(该逾期经审批归为客户/供应商/不可抗力)→ 不扣。
 * nodes: 逾期节点 [{ isCritical, exempt }]。
 */
export function ontimeDeduction(nodes: Array<{ isCritical: boolean; exempt: boolean }>): number {
  const { criticalPenalty, nonCriticalPenalty } = SCORING_CONFIG.ontime;
  return nodes.reduce((s, n) => (n.exempt ? s : s + (n.isCritical ? criticalPenalty : nonCriticalPenalty)), 0);
}
export function ontimeScoreFrom(nodes: Array<{ isCritical: boolean; exempt: boolean }>): number {
  return Math.max(0, SCORING_CONFIG.ontime.max - ontimeDeduction(nodes));
}

/**
 * 考评生效日切换(CEO 批 2026-07-25):只考评【生效日当天及以后·按建单日】新建的订单;
 * 之前建的(本周新建/在途/历史)不计入考评 —— 免扣分、照常按标准率发佣金,只打"不计入考评"标记。
 * 生效日:优先读 env SCORING_EFFECTIVE_DATE('YYYY-MM-DD'),否则用下方代码默认值。
 * 2026-07-27 = CEO 拍板的执行日(下周一);此日前建的单不计入考评。要改:改这里或在 Vercel 设 env(env 优先)。
 */
export const SCORING_EFFECTIVE_DATE = process.env.SCORING_EFFECTIVE_DATE || '2026-07-27';
/** 该订单是否计入考评。createdAtIso=建单日;effectiveDate 缺省取 env。纯函数便于单测。 */
export function isOrderAssessed(createdAtIso: string | null | undefined, effectiveDate: string = SCORING_EFFECTIVE_DATE): boolean {
  if (!effectiveDate) return true;                 // 未设生效日 → 全部计入
  if (!createdAtIso) return true;                  // 无建单日(异常)→ 保守计入
  const ref = new Date(createdAtIso).getTime();
  const eff = new Date(effectiveDate + 'T00:00:00+08:00').getTime();   // 北京时区当天 0 点
  if (isNaN(ref) || isNaN(eff)) return true;
  return ref >= eff;                               // 生效日当天及以后建的 → 计入
}
