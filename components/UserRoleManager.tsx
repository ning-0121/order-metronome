'use client';

import { useState } from 'react';
import { updateUserRoles } from '@/app/actions/users';
import { useRouter } from 'next/navigation';

const ALL_ROLES = [
  { value: 'admin', label: 'CEO/管理员', desc: '全览所有数据，审批延期，不操作节点' },
  { value: 'sales', label: '业务', desc: '客户对接、报价、合同' },
  { value: 'merchandiser', label: '跟单', desc: '生产单执行、工厂协调、中查尾查、验货放行' },
  { value: 'finance', label: '财务', desc: '订单审核、成本核算' },
  { value: 'procurement', label: '采购', desc: '面辅料采购、供应商跟进' },
  { value: 'production', label: '生产', desc: '外发任务、生产进度跟踪' },
  { value: 'qc', label: '质检', desc: 'QC检验、质量报告' },
  { value: 'logistics', label: '物流/仓库', desc: '出货签核、装箱、物流' },
];

interface UserProfile {
  user_id: string;
  email: string;
  name: string | null;
  role: string | null;
  roles: string[] | null;
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

  function startEdit(user: UserProfile) {
    setEditingUserId(user.user_id);
    setEditRoles(user.roles && user.roles.length > 0 ? [...user.roles] : user.role ? [user.role] : []);
    setEditName(user.name || '');
  }

  function toggleRole(role: string) {
    setEditRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  }

  async function handleSave(userId: string) {
    if (editRoles.length === 0) {
      alert('至少选择一个角色');
      return;
    }
    setSaving(true);
    const result = await updateUserRoles(userId, editRoles, editName);
    if (result.error) {
      alert(result.error);
    } else {
      setEditingUserId(null);
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <div className="space-y-4">
      {users.map((user) => {
        const isEditing = editingUserId === user.user_id;
        const userRoles = user.roles && user.roles.length > 0 ? user.roles : user.role ? [user.role] : [];

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
                        {ALL_ROLES.find((ar) => ar.value === r)?.label || r}
                      </span>
                    ))}
                    {userRoles.length === 0 && (
                      <span className="text-xs text-red-500 font-medium">未分配角色</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => startEdit(user)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition-all"
                >
                  编辑角色
                </button>
              </div>
            )}
          </div>
        );
      })}

      {users.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p>暂无用户。请先让员工注册登录系统。</p>
        </div>
      )}
    </div>
  );
}
