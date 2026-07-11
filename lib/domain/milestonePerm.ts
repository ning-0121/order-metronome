/**
 * 里程碑负责人角色匹配(单一真相,2026-07-11 审计 P2)。
 *
 * 背景:markMilestoneDone 用 merchGroup(production/qc/quality/merchandiser 互通)判定可操作,
 * 而 markMilestoneBlocked / transitionMilestoneStatus / updateMilestone 之前只窄判 owner_role==='qc'
 * → 生产/QC 能「完成」跟单节点却不能「申请延期/进行中/解阻」,权限不自洽。统一到本函数。
 *
 * 口径(与 done 一致):
 *  - 角色 == owner_role;
 *  - sales ↔ merchandiser 互通;
 *  - merchGroup(merchandiser/production/qc/quality)内部互通;
 *  - admin_assistant 可操作 sales 的双签节点(评审会等)。
 *  注意:不含 production_manager(与原 merchGroup 一致,避免扩权)。
 */
const MERCH_GROUP = ['merchandiser', 'production', 'qc', 'quality'];

export function milestoneOwnerRoleMatches(userRoles: string[] | null | undefined, ownerRole: string | null | undefined): boolean {
  if (!ownerRole) return false;
  const or = String(ownerRole).toLowerCase();
  return (userRoles || []).some((r) => {
    const nr = String(r).toLowerCase();
    if (nr === or) return true;
    if ((or === 'sales' && nr === 'merchandiser') || (or === 'merchandiser' && nr === 'sales')) return true;
    if (MERCH_GROUP.includes(or) && MERCH_GROUP.includes(nr)) return true;
    if (nr === 'admin_assistant' && or === 'sales') return true;
    return false;
  });
}
