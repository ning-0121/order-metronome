/**
 * Role Mapping Layer - 角色映射层
 * 单一真实来源：所有角色值必须通过此层映射到数据库枚举值
 * 
 * 职责：
 * 1. 将代码中的角色值（logistics, qc等）映射为数据库枚举值
 * 2. 将数据库枚举值映射回代码中的角色值
 * 3. 提供类型安全的角色验证
 */

// 数据库枚举值（以实际数据库为准）
// 基础值：sales, finance, procurement, production, quality, admin
// 扩展值（如果迁移成功）：logistics, qc
export type DbUserRole = 'sales' | 'finance' | 'procurement' | 'production' | 'quality' | 'admin' | 'logistics' | 'qc';

// 代码中使用的角色值（业务层）
// 2026版组织:开发业务部(sales=业务开发) / 订单管理部(merchandiser=理单·订单执行 + order_manager=订单管理经理)
// / 采购部(procurement + procurement_manager=采购经理) / 生产(production=生产跟单)
export type AppRole = 'sales' | 'sales_manager' | 'merchandiser' | 'order_manager' | 'finance' | 'procurement' | 'procurement_manager' | 'production' | 'production_manager' | 'qc' | 'logistics' | 'admin' | 'admin_assistant';

/**
 * 角色映射表：代码角色 -> 数据库枚举值（优先值）
 * 如果数据库不支持，会回退到 FALLBACK_MAP
 */
export const ROLE_MAP_TO_DB: Record<AppRole, string> = {
  'sales': 'sales',
  'sales_manager': 'sales_manager',
  'merchandiser': 'merchandiser',
  'order_manager': 'order_manager',
  'finance': 'finance',
  'procurement': 'procurement',
  'procurement_manager': 'procurement_manager',
  'production': 'production',
  'qc': 'qc', // 优先尝试 qc，如果数据库没有则回退到 quality
  'logistics': 'logistics',
  'production_manager': 'production_manager',
  'admin_assistant': 'admin_assistant',
  'admin': 'admin',
};

/**
 * 回退映射：当数据库不支持扩展枚举值时的回退方案
 */
const ROLE_FALLBACK: Record<string, DbUserRole> = {
  'qc': 'quality', // 如果数据库没有 qc，使用 quality
  'logistics': 'admin', // 如果数据库没有 logistics，使用 admin
};

/**
 * 反向映射：数据库枚举值 -> 代码角色值
 */
export const ROLE_MAP_FROM_DB: Record<string, AppRole> = {
  'sales': 'sales',
  'sales_manager': 'sales_manager',
  'merchandiser': 'merchandiser',
  'order_manager': 'order_manager',
  'finance': 'finance',
  'procurement': 'procurement',
  'procurement_manager': 'procurement_manager',
  'production': 'production',
  'quality': 'qc', // 数据库是 quality，代码用 qc
  'qc': 'qc', // 如果数据库有 qc，直接使用
  'logistics': 'logistics',
  'production_manager': 'production_manager',
  'admin_assistant': 'admin_assistant',
  'admin': 'admin',
};

/**
 * 标准化角色值：将任意角色字符串映射为数据库枚举值
 * 
 * ⚠️ 核心函数：所有写入数据库的 owner_role 必须通过此函数
 * 
 * @param input - 输入的角色值（可能是代码中的值或数据库值）
 * @param useFallback - 是否使用回退映射（默认 true，如果数据库不支持扩展值则回退）
 * @returns 数据库枚举值
 */
export function normalizeRoleToDb(
  input: string | null | undefined,
  useFallback: boolean = true
): string {
  if (!input) {
    return 'sales'; // 默认值
  }
  
  const normalized = input.trim().toLowerCase();
  
  // 如果是已知的数据库枚举值，直接返回
  const knownDbRoles = ['sales', 'sales_manager', 'merchandiser', 'order_manager', 'finance', 'procurement', 'procurement_manager', 'production', 'production_manager', 'admin_assistant', 'quality', 'admin', 'logistics', 'qc'];
  if (knownDbRoles.includes(normalized)) {
    return normalized;
  }
  
  // 如果是代码中的角色值，映射到数据库值
  if (normalized in ROLE_MAP_TO_DB) {
    const mapped = ROLE_MAP_TO_DB[normalized as AppRole];
    
    // 如果映射值是 logistics 或 qc，且 useFallback=true，检查是否需要回退
    if (useFallback && (mapped === 'logistics' || mapped === 'qc')) {
      // 注意：这里无法在运行时检查数据库是否支持，所以先尝试使用
      // 如果数据库不支持，会在插入时报错，此时可以：
      // 1. 执行迁移脚本添加枚举值（推荐）
      // 2. 或者修改代码使用回退值
      return mapped;
    }
    
    return mapped;
  }
  
  // 未知值，返回默认值
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[Roles] Unknown role value: ${input}, defaulting to 'sales'`);
  }
  return 'sales';
}

/**
 * 标准化角色值：将数据库枚举值映射为代码角色值
 * 
 * @param dbRole - 数据库枚举值
 * @returns 代码角色值
 */
export function normalizeRoleFromDb(dbRole: string | null | undefined): AppRole {
  if (!dbRole) {
    return 'sales'; // 默认值
  }
  
  const normalized = dbRole.trim().toLowerCase();
  
  if (normalized in ROLE_MAP_FROM_DB) {
    return ROLE_MAP_FROM_DB[normalized as DbUserRole];
  }
  
  console.warn(`[Roles] Unknown DB role value: ${dbRole}, defaulting to 'sales'`);
  return 'sales';
}

/**
 * 验证角色值是否合法（数据库枚举值）
 */
export function isValidDbRole(role: string): role is DbUserRole {
  return role in ROLE_MAP_FROM_DB;
}

/**
 * 验证角色值是否合法（代码角色值）
 */
export function isValidAppRole(role: string): role is AppRole {
  return role in ROLE_MAP_TO_DB;
}

// ════════════════════════════════════════════════════════════════════
// 权限分组单一来源（Sprint 0 加固）
// ════════════════════════════════════════════════════════════════════
//
// ⚠️ 任何代码不得再硬编码 ['admin','finance',...] 这样的角色数组。
// 所有权限判断必须通过本表，便于审计、防止漂移。
//
// 命名约定：
// - ALL_*       — 包含某能力的全部角色
// - CAN_*       — 能做某动作的角色集合
// - MANAGEMENT  — 管理类（财务/行政/admin）
// - EXECUTION   — 执行类（跟单/生产/质检/品控/生产主管）
//
// 注意：与 lib/domain/scoring-constants.ts 中的 ROLE_GROUPS 不同。
//   - scoring-constants.ROLE_GROUPS：评分维度分组
//   - 本文件 ROLE_GROUPS：权限/可见性分组
//
// 维护规则：
// 1. 新加 group 必须在此文件统一命名
// 2. 修改任一组都要在 PR 描述里说明影响面
// 3. 不允许在业务代码中临时拼角色数组
// ════════════════════════════════════════════════════════════════════

export const ROLE_GROUPS = {
  /** 仅管理员，最高权限 */
  ALL_ADMIN: ['admin'] as const,

  /** 管理类角色：admin / 财务 / 行政督察 */
  MANAGEMENT: ['admin', 'finance', 'admin_assistant'] as const,

  /** 执行类角色：理单(订单执行) / 生产跟单 / 质检 / 品控 / 生产主管
   *  注：订单管理经理 / 采购经理 是【监督】角色 — 看所有订单 + 审批，但不操作执行节点，故不在内 */
  EXECUTION: ['merchandiser', 'production', 'qc', 'quality', 'production_manager'] as const,

  /** 可看所有订单（跨负责人）：管理类 + 生产主管 + 业务部经理 + 订单管理经理 + 采购经理。
   *  ⚠️ 2026-07 用户拍板:业务员(sales) 只看自己创建/负责的订单,不再全程可见全部(推翻 6-15 的 sales 全程可见设定)。 */
  CAN_SEE_ALL_ORDERS: ['admin', 'finance', 'admin_assistant', 'production_manager', 'sales_manager', 'order_manager', 'procurement_manager'] as const,

  /** 可看金额/利润等敏感财务数据：admin / finance / 业务开发 / 业务部经理 / 订单管理经理 */
  CAN_SEE_FINANCIALS: ['admin', 'finance', 'sales', 'sales_manager', 'order_manager'] as const,

  /** 可审批延期申请：admin + 订单管理经理（交期归订单管理部）+ 业务部经理（对客户交期负责） */
  CAN_APPROVE_DELAY: ['admin', 'order_manager', 'sales_manager'] as const,

  /** 可审批客户价格申请：admin + 业务部经理（客户价格归开发业务） */
  CAN_APPROVE_PRICE: ['admin', 'sales_manager'] as const,

  /** 可改派订单/节点负责人：admin + 生产主管 + 业务部经理 + 订单管理经理 */
  CAN_REASSIGN_OWNER: ['admin', 'production_manager', 'sales_manager', 'order_manager'] as const,

  /** 可绕过经营门禁（付款锁、确认链阻塞等）—— 仅 admin，避免越权放货 */
  CAN_OVERRIDE_BUSINESS_BLOCK: ['admin'] as const,

  /** 可执行里程碑（去处理/完成节点）—— 业务开发/订单管理经理/采购经理 均为监督角色，看得到但不操作节点 */
  CAN_OPERATE_MILESTONES: ['merchandiser', 'production', 'qc', 'quality', 'production_manager'] as const,

  /** 可见大货采购底价(unit_price)：采购/采购经理/财务/admin —— 业务只看采购建议价(price_baseline) */
  CAN_SEE_PROCUREMENT_FLOOR: ['admin', 'finance', 'procurement', 'procurement_manager'] as const,

  /** 可编辑供应商业务字段(名/址/电话/联系人/主营品类)：业务/采购/admin */
  CAN_EDIT_SUPPLIER_BASIC: ['admin', 'sales', 'sales_manager', 'merchandiser', 'procurement', 'procurement_manager'] as const,

  /** 可编辑供应商财务字段(付款方式/账期/银行/税号)：财务/admin */
  CAN_EDIT_SUPPLIER_FINANCE: ['admin', 'finance'] as const,

  /** 可审批采购单（采购视角:买得对，供应商/价/量）：admin + 采购经理 */
  CAN_APPROVE_PROCUREMENT: ['admin', 'procurement_manager'] as const,

  /** 可审批采购单（财务视角:付得起/账期/信用）：admin + 财务 */
  CAN_APPROVE_PROC_FINANCE: ['admin', 'finance'] as const,

  /** 可录领料/退料(发料出库):生产/物流/采购/admin —— 谁管发料谁录 */
  CAN_ISSUE_MATERIAL: ['admin', 'production', 'production_manager', 'logistics', 'procurement', 'procurement_manager'] as const,
} as const;

export type RoleGroupKey = keyof typeof ROLE_GROUPS;

/**
 * 检查 user 的任一角色是否落在指定 group 中
 *
 * @example
 *   if (hasRoleInGroup(currentRoles, 'CAN_SEE_ALL_ORDERS')) { ... }
 */
export function hasRoleInGroup(userRoles: string[] | null | undefined, group: RoleGroupKey): boolean {
  if (!userRoles || userRoles.length === 0) return false;
  const target = ROLE_GROUPS[group] as readonly string[];
  return userRoles.some(r => target.includes(r));
}

/**
 * 判定是否为管理员（admin role 包含在 roles 数组中）
 * 任何 admin 判断都应通过此函数，避免再写 .includes('admin')
 */
export function isAdminRole(userRoles: string[] | null | undefined): boolean {
  return hasRoleInGroup(userRoles, 'ALL_ADMIN');
}
