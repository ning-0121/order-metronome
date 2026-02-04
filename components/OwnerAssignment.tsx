'use client';

import { useState, useEffect } from 'react';
import { updateMilestoneOwner } from '@/app/actions/milestones';
import { getAllUsers, type User } from '@/app/actions/users';
import { useRouter } from 'next/navigation';
import { getRoleLabel } from '@/lib/utils/i18n';

interface OwnerAssignmentProps {
  milestoneId: string;
  currentOwnerUserId: string | null;
  isAdmin: boolean;
}

export function OwnerAssignment({ milestoneId, currentOwnerUserId, isAdmin }: OwnerAssignmentProps) {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string>(currentOwnerUserId || '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin) {
      loadUsers();
    }
  }, [isAdmin]);

  async function loadUsers() {
    setLoading(true);
    const result = await getAllUsers();
    if (result.data) {
      setUsers(result.data);
    } else if (result.error) {
      setError(result.error);
    }
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    
    const userId = selectedUserId === '' ? null : selectedUserId;
    const result = await updateMilestoneOwner(milestoneId, userId);
    
    if (result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    
    setSaving(false);
  }

  if (!isAdmin) {
    return null;
  }

  return (
    <div className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg">
      <h4 className="font-semibold mb-2 text-gray-900">分配负责人</h4>
      
      {error && (
        <div className="mb-3 p-2 bg-red-100 border border-red-300 rounded text-red-700 text-sm">
          {error}
        </div>
      )}
      
      {loading ? (
        <p className="text-sm text-gray-600">加载用户列表...</p>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              选择负责人
            </label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
              disabled={saving}
            >
              <option value="">未分配</option>
              {users.map((user) => (
                <option key={user.user_id} value={user.user_id}>
                  {(user as any).full_name ?? user.email}
                  {user.role && ` (${getRoleLabel(user.role)})`}
                </option>
              ))}
            </select>
          </div>
          
          <button
            onClick={handleSave}
            disabled={saving || selectedUserId === (currentOwnerUserId || '')}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      )}
    </div>
  );
}
