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
export type AppRole = 'sales' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics' | 'admin';

/**
 * 角色映射表：代码角色 -> 数据库枚举值（优先值）
 * 如果数据库不支持，会回退到 FALLBACK_MAP
 */
export const ROLE_MAP_TO_DB: Record<AppRole, string> = {
  'sales': 'sales',
  'finance': 'finance',
  'procurement': 'procurement',
  'production': 'production',
  'qc': 'qc', // 优先尝试 qc，如果数据库没有则回退到 quality
  'logistics': 'logistics', // 优先尝试 logistics，如果数据库没有则回退到 admin
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
  'finance': 'finance',
  'procurement': 'procurement',
  'production': 'production',
  'quality': 'qc', // 数据库是 quality，代码用 qc
  'qc': 'qc', // 如果数据库有 qc，直接使用
  'logistics': 'logistics', // 如果数据库有 logistics，直接使用
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
  const knownDbRoles = ['sales', 'finance', 'procurement', 'production', 'quality', 'admin', 'logistics', 'qc'];
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
