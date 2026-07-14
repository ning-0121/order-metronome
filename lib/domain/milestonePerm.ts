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
 *  - 生产主管(production_manager)可操作生产圈(merchGroup)+ 自己的节点。
 *  - 业务经理(order_manager 业务执行经理 / sales_manager)管整条业务链:可操作业务开发(sales)+
 *    业务执行(merchandiser)+ 自身的节点(2026-07-12,口径随 i18n 2026-07-10:sales=业务开发/
 *    merchandiser=业务执行)。修:产前样确认(owner=业务执行)业务执行经理点「完成」被拒。
 *
 * 角色审计修(2026-07-12):原不含 production_manager,但客户端 MilestoneActions.canModify 含它
 * → 生产部经理看到「完成/进行中/阻塞」按钮点了被服务端拒(UI 与服务端口径打架)。生产主管管生产,
 * 操作生产/QC 节点本在其职责内 → 服务端对齐授予(镜像客户端),而非砍掉 UI 功能。
 */
const MERCH_GROUP = ['merchandiser', 'production', 'qc', 'quality'];
const BIZ_STAFF = ['sales', 'merchandiser'];             // 业务开发 / 业务执行
const BIZ_MANAGERS = ['order_manager', 'sales_manager']; // 业务执行经理 / 业务经理:管整条业务链
const BIZ_CHAIN = [...BIZ_STAFF, ...BIZ_MANAGERS];

export function milestoneOwnerRoleMatches(userRoles: string[] | null | undefined, ownerRole: string | null | undefined): boolean {
  if (!ownerRole) return false;
  const or = String(ownerRole).toLowerCase();
  return (userRoles || []).some((r) => {
    const nr = String(r).toLowerCase();
    if (nr === or) return true;
    if ((or === 'sales' && nr === 'merchandiser') || (or === 'merchandiser' && nr === 'sales')) return true;
    if (MERCH_GROUP.includes(or) && MERCH_GROUP.includes(nr)) return true;
    // 业务经理管整条业务链(业务开发+业务执行+自身)
    if ((BIZ_MANAGERS.includes(nr) && BIZ_CHAIN.includes(or)) || (BIZ_MANAGERS.includes(or) && BIZ_CHAIN.includes(nr))) return true;
    if (nr === 'admin_assistant' && or === 'sales') return true;
    // 生产主管 ↔ 生产圈/生产主管(与客户端 canModify 对齐)
    if ((or === 'production_manager' && (MERCH_GROUP.includes(nr) || nr === 'production_manager'))
      || (nr === 'production_manager' && (MERCH_GROUP.includes(or) || or === 'production_manager'))) return true;
    return false;
  });
}
