'use client';

import { useState } from 'react';
import { updateUserRoles } from '@/app/actions/users';
import { useRouter } from 'next/navigation';

const ALL_ROLES = [
  { value: 'admin', label: '管理员' },
  { value: 'sales', label: '业务/理单' },
  { value: 'finance', label: '财务' },
  { value: 'procurement', label: '采购' },
  { value: 'production', label: '生产' },
  { value: 'qc', label: '质检' },
  { value: 'logistics', label: '物流/仓库' },
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

  function getRolesDisplay(user: UserProfile): string {
    const roles = user.roles && user.roles.length > 0 ? user.roles : user.role ? [user.role] : [];
    if (roles.length === 0) return '未分配';
    return roles.map((r) => ALL_ROLES.find((ar) => ar.value === r)?.label || r).join(' / ');
  }

  return (
    <div className="space-y-3">
      {users.map((user) => {
        const isEditing = editingUserId === user.user_id;

        return (
          <div
            key={user.user_id}
            className="section p-5"
          >
            {isEditing ? (
              <div className="space-y-4">
                {/* 编辑姓名 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">姓名</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    placeholder="输入员工姓名"
                  />
                </div>

                {/* 邮箱（只读） */}
                <div className="text-sm text-gray-500">
                  {user.email}
                </div>

                {/* 角色多选 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">角色（可多选）</label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_ROLES.map((role) => {
                      const isSelected = editRoles.includes(role.value);
                      return (
                        <button
                          key={role.value}
                          type="button"
                          onClick={() => toggleRole(role.value)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                            isSelected
                              ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                              : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                          }`}
                        >
                          {isSelected && <span className="mr-1">✓</span>}
                          {role.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSave(user.user_id)}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                  <button
                    onClick={() => setEditingUserId(null)}
                    className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-900">
                    {user.name || user.email}
                  </div>
                  <div className="text-sm text-gray-500 mt-0.5">
                    {user.email}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(user.roles && user.roles.length > 0 ? user.roles : user.role ? [user.role] : []).map((r) => (
                      <span
                        key={r}
                        className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200"
                      >
                        {ALL_ROLES.find((ar) => ar.value === r)?.label || r}
                      </span>
                    ))}
                    {(!user.roles || user.roles.length === 0) && !user.role && (
                      <span className="text-xs text-gray-400">未分配角色</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => startEdit(user)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium text-indigo-600 hover:bg-indigo-50 border border-indigo-200 transition-all"
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
