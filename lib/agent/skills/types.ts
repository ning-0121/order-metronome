/**
 * AI Skills 共享类型定义
 *
 * 7 个 Skill 都实现 SkillModule 接口，由 runner 统一调度。
 */

export type SkillName =
  | 'risk_assessment'
  | 'missing_info'
  | 'quote_review'
  | 'delay_prediction'
  | 'customer_confirmation'
  | 'outsource_risk'
  | 'milestone_generation';

export type SkillSeverity = 'high' | 'medium' | 'low';
export type SkillSource = 'rules' | 'rules+ai' | 'cached' | 'manual';
export type SkillStatus = 'success' | 'failed' | 'timeout' | 'shadow';

/**
 * Skill 输入快照 — 每个 Skill 自定义结构，但必须能 JSON 序列化
 */
export interface SkillInput {
  orderId?: string;
  customerId?: string;
  /** 任意业务上下文 — 由各 Skill 自定义 */
  [key: string]: any;
}

/**
 * Skill 通用输出结构
 */
export interface SkillFinding {
  category: string;
  severity: SkillSeverity;
  label: string;
  detail?: string;
  /** 哪个里程碑会被卡住（缺失资料 Skill 用） */
  blocksStep?: string;
  blocksStepName?: string;
  /** 距离卡死还有多少天 */
  daysToBlocker?: number;
  /** 谁应该处理 */
  whoShouldFix?: 'sales' | 'merchandiser' | 'finance' | 'procurement' | 'admin';
}

export interface SkillSuggestion {
  action: string;
  reason: string;
  /** 哪个角色应该执行 */
  targetRole?: string;
  /** 是否需要 admin 审批后才能采纳 */
  needsApproval?: boolean;
}

export interface SkillResult {
  /** 总体严重度 */
  severity: SkillSeverity;
  /** 总体得分（0-100，越高越严重） */
  score?: number;
  /** 简短总结，给 UI 卡片标题用 */
  summary: string;
  /** 详细发现列表 */
  findings: SkillFinding[];
  /** 建议动作列表 */
  suggestions: SkillSuggestion[];
  /** 置信度 0-100 */
  confidence: number;
  /** 数据来源（rules / rules+ai / cached） */
  source: SkillSource;
  /** Skill 内部数据，便于调试 */
  meta?: Record<string, any>;
}

/**
 * Skill 模块接口 — 每个 Skill 必须实现
 */
export interface SkillModule {
  /** Skill 名称（与 SKILL_FLAGS / DB skill_name 一致） */
  name: SkillName;
  /** 显示标题 */
  displayName: string;
  /** Cache TTL（毫秒），undefined = 不缓存 */
  cacheTtlMs?: number;
  /** 是否强制 shadow（即使全局 shadow_mode 关了也保持） */
  forceShadow?: boolean;
  /** 计算输入 hash 用于缓存命中判断 */
  hashInput: (input: SkillInput) => string;
  /** 实际运行函数 */
  run: (input: SkillInput, context: SkillContext) => Promise<SkillResult>;
}

/**
 * Skill 运行上下文 — 由 runner 注入
 */
export interface SkillContext {
  supabase: any;
  userId?: string;
  /** 当前是否 shadow 模式 */
  isShadow: boolean;
  /** 触发来源 */
  triggeredBy: 'user' | 'cron' | 'event' | 'manual';
}

/**
 * Skill runner 返回结构
 */
export interface SkillRunOutput {
  /** Shadow 模式下为 null（不展示给用户） */
  displayResult: SkillResult | null;
  /** 内部完整结果（始终有值） */
  internalResult: SkillResult | null;
  /** ai_skill_runs.id */
  runId?: string;
  /** 是否缓存命中 */
  cacheHit: boolean;
  /** 是否被熔断器拦截 */
  circuitBroken: boolean;
}
