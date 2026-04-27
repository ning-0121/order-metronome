/**
 * 默认负责人配置 — 角色到具体员工的固定映射
 *
 * CEO 拍板（2026-04-08）：
 *  - 财务节点 → 方圆
 *  - 采购节点 → Helen
 *
 * 之前的逻辑是"如果某个角色全公司只有一个人就自动分配"，
 * 现在改为"按 名字 / 邮箱前缀 主动匹配指定的人"。
 *
 * 如果未来要换人，只改这里的 nameMatches / emailContains 即可。
 */

export interface AssigneeMatcher {
  /** 显示名（仅用于日志） */
  displayName: string;
  /** profiles.name 包含任一字符串即匹配（不区分大小写） */
  nameMatches: string[];
  /** profiles.email 前缀包含任一字符串即匹配（小写比对） */
  emailContains?: string[];
}

/**
 * 角色 → 默认负责人 匹配规则
 *
 * 注意：
 *  - 这只是"自动分配"的默认值
 *  - admin 仍可手动改派
 *  - 如果匹配不到（比如方圆请假/离职），系统会回退到原有"全公司只有一个人就用谁"的逻辑
 */
export const DEFAULT_ASSIGNEES: Record<string, AssigneeMatcher> = {
  finance: {
    displayName: '方圆',
    nameMatches: ['方圆', '方园', '方園', 'fangyuan', 'Fangyuan', 'Fang Yuan'],
    emailContains: ['fangyuan', 'fangy', 'fang.yuan', 'fy@'],
  },
  procurement: {
    displayName: 'Helen',
    nameMatches: ['Helen', 'helen', '海莲', '海莉', '王海莲'],
    emailContains: ['helen@', 'helen.'],
  },
  production_manager: {
    displayName: '秦增富',
    nameMatches: ['秦增富', '增富', 'zengfu'],
    emailContains: ['qzf@', 'qzf'],
  },
};

/**
 * 固定由生产主管负责的里程碑 step_key
 * CEO 2026-04-09 拍板：工厂匹配确认 + 产前样准备完成 永远是生产主管的活
 * CEO 2026-04-27 补充：加工费确认 + 生产预评估 也是生产主管负责（修复模板错误）
 */
export const PRODUCTION_MANAGER_FIXED_STEPS: string[] = [
  'processing_fee_confirmed',    // 加工费确认（生产主管与工厂谈加工费）
  'bulk_materials_confirmed',    // 生产预评估
  'factory_confirmed',           // 工厂匹配确认
  'pre_production_sample_ready', // 产前样准备完成
];

interface ProfileLite {
  user_id: string;
  name?: string | null;
  email?: string | null;
}

/**
 * 在 profiles 列表中查找匹配 matcher 的用户
 * 返回 user_id 或 null
 */
export function findAssigneeUserId(
  profiles: ProfileLite[],
  matcher: AssigneeMatcher,
): string | null {
  if (!profiles || profiles.length === 0) return null;

  // 第一轮：name 精确包含匹配
  for (const p of profiles) {
    const name = (p.name || '').trim();
    if (!name) continue;
    if (matcher.nameMatches.some(m => name.toLowerCase().includes(m.toLowerCase()))) {
      return p.user_id;
    }
  }

  // 第二轮：email 前缀包含匹配
  if (matcher.emailContains && matcher.emailContains.length > 0) {
    for (const p of profiles) {
      const email = (p.email || '').toLowerCase();
      if (!email) continue;
      const localPart = email.split('@')[0];
      if (matcher.emailContains.some(m => localPart.includes(m.toLowerCase().replace('@', '')))) {
        return p.user_id;
      }
    }
  }

  return null;
}
