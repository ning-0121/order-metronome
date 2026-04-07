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
    /** 每个超期节点扣分 */
    perOverduePenalty: 8,
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
