'use client';

import { useState } from 'react';
import { updateUserRoles, adminResetPassword, checkUserDeletable, deleteUser, offboardUser, reactivateUser } from '@/app/actions/users';
import { useRouter } from 'next/navigation';

// 2026版组织角色（开发业务部 / 订单管理部 / 采购部 / 生产部）
const ALL_ROLES = [
  { value: 'admin', label: 'CEO/管理员', desc: '全公司审计与重大异常协调；从异常升级到关闭。可显式覆盖并须记录理由，不能静默绕过财务或职责分离。' },
  { value: 'sales', label: '业务开发', desc: '负责开发、报价打样、客户关系和 PO 商务确认；从线索到确认 PO。交接后保留客户商业变更职责，不操作普通执行节点。' },
  { value: 'sales_manager', label: '开发业务经理', desc: '管理开发团队及特殊价格、条款和客户承诺；从报价例外到商务确认。不替代业务执行经理，也无生产/采购/财务通用审批权。' },
  { value: 'merchandiser', label: '业务执行', desc: 'PO 确认后作为订单总负责人，从建单、资料、采购协同、客户确认一直协调到最终出货和关闭；不能最终决定工厂、排产或付款。' },
  { value: 'order_manager', label: '业务执行经理', desc: '分配并监督订单总负责人、SLA 和跨部门异常；从 PO 交接到订单关闭。不替代普通节点执行，不越权财务或生产专属审批。' },
  { value: 'finance', label: '财务', desc: '负责人审、收付、成本利润、对账结算；按财务节点介入。不是订单执行负责人，AI 和其他部门不能代替其审批。' },
  { value: 'procurement', label: '采购', desc: '负责核料后询价、下单、催货、收货协调和缺料异常；从采购需求到到料。不改变订单商务真相或批准付款。' },
  { value: 'procurement_manager', label: '采购经理', desc: '负责供应商、采购成本、让步及采购异常；从供应商准入到采购例外关闭。不能批准财务付款或自动接受导入数据。' },
  { value: 'production', label: '生产跟单（含QC）', desc: '工厂和排期确认后接手现场，从物料、开裁、上线、首件/中查/尾查、整改、包装一直跟到出货；可建议但不能最终定厂排单。' },
  { value: 'production_manager', label: '生产主管', desc: '负责最终定厂、确认排产、产能风险及分配生产跟单/QC；从生产需求到制造异常关闭。定厂/改排必须留痕。' },
  { value: 'admin_assistant', label: '行政督办', desc: '仅负责进度可见、催办和升级；不成为业务 owner，不因督办获得价格、财务或跨部门审批权限。' },
  { value: 'logistics', label: '物流/仓库', desc: '负责成品入库、装箱、订舱、出库和物流凭证；从出货准备到交付跟踪。不能单独放行，也不替代订单总负责人。' },
];

function roleLabel(value: string) {
  return ALL_ROLES.find((ar) => ar.value === value)?.label || value;
}

interface UserProfile {
  user_id: string;
  email: string;
  name: string | null;
  role: string | null;
  roles: string[] | null;
  wechat_push_key: string | null;
  active?: boolean | null;
  departed_at?: string | null;
  handover_to?: string | null;
}

interface UserRoleManagerProps {
  users: UserProfile[];
}

export function UserRoleManager({ users }: UserRoleManagerProps) {
  const router = useRouter();
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [editWechatKey, setEditWechatKey] = useState('');
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  // 离职交接状态
  const [offboardUserId, setOffboardUserId] = useState<string | null>(null);
  const [handoverToId, setHandoverToId] = useState('');
  const [offboardConfirmName, setOffboardConfirmName] = useState('');
  const [offboarding, setOffboarding] = useState(false);

  // 恢复在职
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

  // 彻底删除状态（极端场景，admin only）
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [deleteChecking, setDeleteChecking] = useState(false);
  const [deleteCheck, setDeleteCheck] = useState<{
    canDelete?: boolean;
    activeMilestones?: { id: string; name: string; order_no: string; status: string }[];
    ownedOrders?: { id: string; order_no: string; customer_name: string }[];
    error?: string;
  } | null>(null);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);

  const activeUsers = users.filter((u) => u.active !== false);
  const inactiveUsers = users.filter((u) => u.active === false);
  const nameOf = (userId: string | null | undefined) => {
    if (!userId) return null;
    const u = users.find((x) => x.user_id === userId);
    return u ? (u.name || u.email) : null;
  };

  function startOffboard(user: UserProfile) {
    setOffboardUserId(user.user_id);
    setHandoverToId('');
    setOffboardConfirmName('');
    // 关闭其它面板
    setDeleteUserId(null);
    setResetUserId(null);
    setEditingUserId(null);
  }

  async function handleOffboard(user: UserProfile) {
    const expected = (user.name || user.email || '').trim();
    if (!handoverToId) {
      alert('请选择接手人');
      return;
    }
    if (offboardConfirmName.trim() !== expected) {
      alert(`请输入离职员工姓名「${expected}」以确认`);
      return;
    }
    if (!confirm(`确认为 ${expected} 办理离职？\n将：转派其全部未完成工作给接手人 + 封锁其登录 + 移出在职名单（可恢复）。`)) return;
    setOffboarding(true);
    const result = await offboardUser(user.user_id, handoverToId, offboardConfirmName.trim());
    if (result.error) {
      alert(result.error);
      setOffboarding(false);
      return;
    }
    alert(`✅ 离职办理完成：转派节点 ${result.reassignedMilestones ?? 0} 个 / 订单 ${result.reassignedOrders ?? 0} 个给接手人；登录已封锁。`);
    setOffboardUserId(null);
    setHandoverToId('');
    setOffboardConfirmName('');
    setOffboarding(false);
    router.refresh();
  }

  async function handleReactivate(user: UserProfile) {
    if (!confirm(`恢复 ${user.name || user.email} 为在职？\n将解封其登录账号并重新列入在职名单（不会自动收回已转派的工作）。`)) return;
    setReactivatingId(user.user_id);
    const result = await reactivateUser(user.user_id);
    if (result.error) {
      alert(result.error);
      setReactivatingId(null);
      return;
    }
    setReactivatingId(null);
    router.refresh();
  }

  async function startDelete(user: UserProfile) {
    setDeleteUserId(user.user_id);
    setDeleteConfirmEmail('');
    setDeleteCheck(null);
    setOffboardUserId(null);
    setDeleteChecking(true);
    const result = await checkUserDeletable(user.user_id);
    setDeleteCheck(result);
    setDeleteChecking(false);
  }

  async function handleDelete(user: UserProfile) {
    if (!deleteCheck?.canDelete) return;
    if (deleteConfirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      alert('输入的邮箱与该员工不一致');
      return;
    }
    if (!confirm(`确认彻底删除员工 ${user.name || user.email}？此操作不可恢复！`)) return;
    setDeleting(true);
    const result = await deleteUser(user.user_id, deleteConfirmEmail);
    if (result.error) {
      alert(result.error);
      setDeleting(false);
      return;
    }
    alert('员工已删除');
    setDeleteUserId(null);
    setDeleteCheck(null);
    setDeleteConfirmEmail('');
    setDeleting(false);
    router.refresh();
  }

  function startEdit(user: UserProfile) {
    setEditingUserId(user.user_id);
    setEditRoles(user.roles && user.roles.length > 0 ? [...user.roles] : user.role ? [user.role] : []);
    setEditName(user.name || '');
    setEditWechatKey(user.wechat_push_key || '');
  }

  function toggleRole(role: string) {
    setEditRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  }

  async function handleResetPassword(userId: string) {
    if (!resetPassword || resetPassword.length < 6) {
      alert('密码至少 6 位');
      return;
    }
    setResetting(true);
    const result = await adminResetPassword(userId, resetPassword);
    if (result.error) {
      alert(result.error);
    } else {
      alert('密码已重置，请通知员工使用新密码登录');
      setResetUserId(null);
      setResetPassword('');
    }
    setResetting(false);
  }

  async function handleSave(userId: string) {
    if (editRoles.length === 0) {
      alert('至少选择一个角色');
      return;
    }
    setSaving(true);
    const result = await updateUserRoles(userId, editRoles, editName, editWechatKey || undefined);
    if (result.error) {
      alert(result.error);
    } else {
      setEditingUserId(null);
      router.refresh();
    }
    setSaving(false);
  }

  function renderActiveCard(user: UserProfile) {
    const isEditing = editingUserId === user.user_id;
    const userRoles = user.roles && user.roles.length > 0 ? user.roles : user.role ? [user.role] : [];
    // 接手人候选：其他在职用户
    const handoverCandidates = activeUsers.filter((u) => u.user_id !== user.user_id);

    return (
      <div key={user.user_id} className="rounded-xl border border-gray-200 bg-white p-5">
        {isEditing ? (
          <div className="space-y-5">
            {/* 姓名 + 邮箱 */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">姓名</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="输入员工姓名"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
                <div className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 rounded-lg border border-gray-200">
                  {user.email}
                </div>
              </div>
            </div>

            {/* 微信通知 SendKey */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">微信通知 SendKey</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={editWechatKey}
                  onChange={(e) => setEditWechatKey(e.target.value)}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="从 sct.ftqq.com 获取 SendKey"
                />
                {editWechatKey && <span className="flex items-center text-green-600 text-xs">✓ 已配置</span>}
              </div>
              <p className="text-xs text-gray-400 mt-1">配置后系统通知将同步推送到个人微信。<a href="https://sct.ftqq.com/" target="_blank" rel="noopener noreferrer" className="text-indigo-500 hover:underline">获取 SendKey →</a></p>
            </div>

            {/* 角色多选 — 大面积展示 */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-medium text-gray-700">
                  角色（可多选）
                </label>
                <span className="text-sm text-indigo-600 font-medium">
                  已选 {editRoles.length} 个
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {ALL_ROLES.map((role) => {
                  const isSelected = editRoles.includes(role.value);
                  return (
                    <button
                      key={role.value}
                      type="button"
                      onClick={() => toggleRole(role.value)}
                      className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                        isSelected
                          ? 'bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200'
                          : 'bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <div className={`flex h-5 w-5 items-center justify-center rounded border mt-0.5 flex-shrink-0 ${
                        isSelected
                          ? 'bg-indigo-600 border-indigo-600'
                          : 'border-gray-300 bg-white'
                      }`}>
                        {isSelected && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${isSelected ? 'text-indigo-900' : 'text-gray-900'}`}>
                          {role.label}
                        </div>
                        <div className={`text-xs mt-0.5 ${isSelected ? 'text-indigo-600' : 'text-gray-500'}`}>
                          {role.desc}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 确认按钮 — 醒目 */}
            <div className="flex gap-3 pt-2 border-t border-gray-100">
              <button
                onClick={() => handleSave(user.user_id)}
                disabled={saving || editRoles.length === 0}
                className="flex-1 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-all"
              >
                {saving ? '保存中...' : '确认保存'}
              </button>
              <button
                onClick={() => setEditingUserId(null)}
                className="px-6 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-all"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-base font-medium text-gray-900">
                {user.name || user.email}
              </div>
              <div className="text-sm text-gray-500 mt-0.5">
                {user.email}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {userRoles.map((r) => (
                  <span
                    key={r}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200"
                  >
                    {roleLabel(r)}
                  </span>
                ))}
                {userRoles.length === 0 && (
                  <span className="text-xs text-red-500 font-medium">未分配角色</span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setResetUserId(user.user_id); setResetPassword(''); }}
                className="px-3 py-2 rounded-xl text-sm font-medium text-amber-600 hover:bg-amber-50 border border-amber-200 transition-all"
              >
                重置密码
              </button>
              <button
                onClick={() => startEdit(user)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition-all"
              >
                编辑角色
              </button>
              <button
                onClick={() => startOffboard(user)}
                className="px-3 py-2 rounded-xl text-sm font-medium text-orange-600 hover:bg-orange-50 border border-orange-200 transition-all"
                title="办理离职：转派工作 + 封锁登录 + 移出在职名单"
              >
                离职交接
              </button>
            </div>
          </div>
        )}

        {/* 离职交接面板 */}
        {offboardUserId === user.user_id && (
          <div className="mt-4 pt-4 border-t border-orange-200 bg-orange-50 -mx-5 -mb-5 px-5 pb-5 rounded-b-xl">
            <p className="text-sm font-semibold text-orange-800 mb-1">
              📤 办理离职：{user.name || user.email}
            </p>
            <p className="text-xs text-orange-700 mb-3">
              将一次性完成：<strong>转派该员工全部未完成节点 + 活跃订单给接手人</strong>、<strong>封锁其登录</strong>、<strong>移出在职名单</strong>。已完成的历史保留其姓名。此操作可「恢复」。
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-orange-800 mb-1">接手人（承接其全部未完成工作）</label>
                <select
                  value={handoverToId}
                  onChange={(e) => setHandoverToId(e.target.value)}
                  className="w-full rounded-lg border border-orange-300 px-3 py-2 text-sm bg-white text-gray-900 focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                >
                  <option value="">— 请选择接手人 —</option>
                  {handoverCandidates.map((c) => (
                    <option key={c.user_id} value={c.user_id}>
                      {(c.name || c.email)}
                      {c.roles && c.roles.length > 0 ? ` (${c.roles.map(roleLabel).join('、')})` : c.role ? ` (${roleLabel(c.role)})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-orange-800 mb-1">
                  二次确认：请输入离职员工姓名 <code className="bg-white px-1.5 py-0.5 rounded border border-orange-200 font-mono">{user.name || user.email}</code>
                </label>
                <input
                  type="text"
                  value={offboardConfirmName}
                  onChange={(e) => setOffboardConfirmName(e.target.value)}
                  placeholder="输入姓名以确认"
                  className="w-full rounded-lg border border-orange-300 px-3 py-2 text-sm bg-white focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => handleOffboard(user)}
                  disabled={
                    offboarding ||
                    !handoverToId ||
                    offboardConfirmName.trim() !== (user.name || user.email || '').trim()
                  }
                  className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:bg-orange-700 disabled:opacity-50 transition-all"
                >
                  {offboarding ? '办理中...' : '确认办理离职'}
                </button>
                <button
                  onClick={() => { setOffboardUserId(null); setHandoverToId(''); setOffboardConfirmName(''); }}
                  className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-white transition-all"
                >
                  取消
                </button>
                <button
                  onClick={() => startDelete(user)}
                  className="ml-auto px-3 py-2 rounded-lg text-xs font-medium text-red-500 hover:bg-red-50 border border-red-200 transition-all"
                  title="极端场景才用：彻底删除登录账号与档案，不可恢复"
                >
                  彻底删除（极端场景）
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 彻底删除面板（极端场景） */}
        {deleteUserId === user.user_id && (
          <div className="mt-4 pt-4 border-t border-red-200 bg-red-50 -mx-5 -mb-5 px-5 pb-5 rounded-b-xl">
            <p className="text-sm font-semibold text-red-800 mb-1">
              ⚠️ 彻底删除 {user.name || user.email}
            </p>
            <p className="text-xs text-red-700 mb-3">
              这是不可恢复的硬删除（清除登录账号 + 档案），仅用于误建账号等极端场景。<strong>常规离职请用「离职交接」</strong>（可保留历史、可恢复）。
            </p>

            {deleteChecking && (
              <p className="text-xs text-red-600">正在检查该员工是否有进行中的工作...</p>
            )}

            {!deleteChecking && deleteCheck?.error && (
              <p className="text-xs text-red-700">{deleteCheck.error}</p>
            )}

            {!deleteChecking && deleteCheck && !deleteCheck.error && !deleteCheck.canDelete && (
              <div className="space-y-2">
                <p className="text-xs text-red-700 font-medium">
                  ❌ 无法删除：该员工仍有未完成的工作，请改用「离职交接」自动转派
                </p>
                {(deleteCheck.activeMilestones?.length || 0) > 0 && (
                  <div className="bg-white rounded-lg border border-red-200 p-3">
                    <p className="text-xs font-medium text-red-700 mb-1">
                      进行中的节点（{deleteCheck.activeMilestones!.length}）：
                    </p>
                    <ul className="text-xs text-gray-700 space-y-0.5 max-h-32 overflow-auto">
                      {deleteCheck.activeMilestones!.slice(0, 10).map((m) => (
                        <li key={m.id}>• {m.order_no} · {m.name}</li>
                      ))}
                      {deleteCheck.activeMilestones!.length > 10 && (
                        <li className="text-gray-400">…还有 {deleteCheck.activeMilestones!.length - 10} 项</li>
                      )}
                    </ul>
                  </div>
                )}
                {(deleteCheck.ownedOrders?.length || 0) > 0 && (
                  <div className="bg-white rounded-lg border border-red-200 p-3">
                    <p className="text-xs font-medium text-red-700 mb-1">
                      负责/创建的活动订单（{deleteCheck.ownedOrders!.length}）：
                    </p>
                    <ul className="text-xs text-gray-700 space-y-0.5 max-h-32 overflow-auto">
                      {deleteCheck.ownedOrders!.slice(0, 10).map((o) => (
                        <li key={o.id}>• {o.order_no} · {o.customer_name}</li>
                      ))}
                      {deleteCheck.ownedOrders!.length > 10 && (
                        <li className="text-gray-400">…还有 {deleteCheck.ownedOrders!.length - 10} 项</li>
                      )}
                    </ul>
                  </div>
                )}
                <button
                  onClick={() => { setDeleteUserId(null); setDeleteCheck(null); }}
                  className="mt-2 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 text-xs hover:bg-white transition-all"
                >
                  关闭
                </button>
              </div>
            )}

            {!deleteChecking && deleteCheck?.canDelete && (
              <div className="space-y-3">
                <p className="text-xs text-red-700">
                  请输入该员工邮箱 <code className="bg-white px-1.5 py-0.5 rounded border border-red-200 font-mono">{user.email}</code> 以确认彻底删除：
                </p>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={deleteConfirmEmail}
                    onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                    placeholder="输入员工邮箱"
                    className="flex-1 rounded-lg border border-red-300 px-3 py-2 text-sm bg-white focus:border-red-500 focus:ring-1 focus:ring-red-500"
                  />
                  <button
                    onClick={() => handleDelete(user)}
                    disabled={
                      deleting ||
                      deleteConfirmEmail.trim().toLowerCase() !== user.email.toLowerCase()
                    }
                    className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-all"
                  >
                    {deleting ? '删除中...' : '确认彻底删除'}
                  </button>
                  <button
                    onClick={() => { setDeleteUserId(null); setDeleteCheck(null); setDeleteConfirmEmail(''); }}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-white transition-all"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 重置密码面板 */}
        {resetUserId === user.user_id && (
          <div className="mt-4 pt-4 border-t border-amber-200 bg-amber-50 -mx-5 -mb-5 px-5 pb-5 rounded-b-xl">
            <p className="text-sm font-medium text-amber-800 mb-3">
              为 {user.name || user.email} 设置新密码
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="输入新密码（至少6位）"
                className="flex-1 rounded-lg border border-amber-300 px-3 py-2 text-sm bg-white focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
              />
              <button
                onClick={() => handleResetPassword(user.user_id)}
                disabled={resetting || resetPassword.length < 6}
                className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-all"
              >
                {resetting ? '重置中...' : '确认重置'}
              </button>
              <button
                onClick={() => setResetUserId(null)}
                className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-white transition-all"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 在职 */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-700">在职员工</h2>
          <span className="text-xs text-gray-400">{activeUsers.length} 人</span>
        </div>
        {activeUsers.map(renderActiveCard)}
        {activeUsers.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p>暂无在职用户。请先让员工注册登录系统。</p>
          </div>
        )}
      </div>

      {/* 已离职 */}
      {inactiveUsers.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-500">已离职</h2>
            <span className="text-xs text-gray-400">{inactiveUsers.length} 人 · 已封锁登录</span>
          </div>
          {inactiveUsers.map((user) => {
            const userRoles = user.roles && user.roles.length > 0 ? user.roles : user.role ? [user.role] : [];
            const handoverName = nameOf(user.handover_to);
            return (
              <div key={user.user_id} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-500 line-through decoration-gray-300">
                      {user.name || user.email}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{user.email}</div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      {userRoles.map((r) => (
                        <span key={r} className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-500">
                          {roleLabel(r)}
                        </span>
                      ))}
                      {user.departed_at && (
                        <span className="text-xs text-gray-400">· 离职 {user.departed_at.slice(0, 10)}</span>
                      )}
                      {handoverName && (
                        <span className="text-xs text-gray-400">· 工作交接给 {handoverName}</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleReactivate(user)}
                    disabled={reactivatingId === user.user_id}
                    className="px-3 py-2 rounded-xl text-sm font-medium text-emerald-700 hover:bg-emerald-50 border border-emerald-200 disabled:opacity-50 transition-all"
                    title="解封登录并恢复在职"
                  >
                    {reactivatingId === user.user_id ? '恢复中...' : '恢复在职'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
