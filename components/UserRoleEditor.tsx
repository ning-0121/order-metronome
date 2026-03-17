'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

const ROLES = [
  { value: 'admin',       label: '管理员',     desc: '全权限' },
  { value: 'ceo',         label: 'CEO',        desc: '全览，不操作节点' },
  { value: 'sales',       label: '业务',        desc: '新建/管理订单' },
  { value: 'finance',     label: '财务',        desc: '审核+复盘+第三签' },
  { value: 'procurement', label: '采购',        desc: '采购下单+原辅料确认' },
  { value: 'production',  label: '生产',        desc: '排期开裁+产前会' },
  { value: 'qc',          label: '质检',        desc: '中查/尾查/放行' },
  { value: 'logistics',   label: '物流/仓库',   desc: '仓库工作台+出货第二签' },
];

const DEPARTMENTS = ['业务部', '财务部', '采购部', '生产部', '质检部', '仓储物流部', '管理层'];

interface Props {
  userId: string;
  currentRole?: string | null;
  currentDepartment?: string | null;
  isActive?: boolean;
  userName?: string;
}

export function UserRoleEditor({ userId, currentRole, currentDepartment, isActive = true, userName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(currentRole || '');
  const [dept, setDept] = useState(currentDepartment || '');
  const [active, setActive] = useState(isActive);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true); setError(''); setSaved(false);
    const supabase = createClient();
    const { error: err } = await supabase
      .from('profiles')
      .update({
        role: role || null,
        department: dept || null,
        is_active: active,
        last_role_changed_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (err) { setError(err.message); }
    else { setSaved(true); setTimeout(() => { setOpen(false); setSaved(false); router.refresh(); }, 800); }
    setSaving(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium"
      >
        {open ? '关闭' : '授权'}
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-4 w-72">
          <p className="text-sm font-semibold text-gray-900 mb-3">{userName} 的权限设置</p>

          {/* 角色选择 */}
          <div className="mb-3">
            <label className="text-xs font-medium text-gray-500 mb-1.5 block">角色</label>
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {ROLES.map(r => (
                <label key={r.value}
                  className={'flex items-center gap-2 p-2 rounded-lg cursor-pointer border ' +
                    (role === r.value ? 'border-indigo-400 bg-indigo-50' : 'border-transparent hover:bg-gray-50')}>
                  <input type="radio" name={'role_' + userId} value={r.value}
                    checked={role === r.value}
                    onChange={() => setRole(r.value)}
                    className="w-3.5 h-3.5 accent-indigo-600" />
                  <div>
                    <span className="text-xs font-medium text-gray-900">{r.label}</span>
                    <span className="text-xs text-gray-400 ml-1.5">{r.desc}</span>
                  </div>
                </label>
              ))}
              <label className={'flex items-center gap-2 p-2 rounded-lg cursor-pointer border ' +
                (!role ? 'border-red-300 bg-red-50' : 'border-transparent hover:bg-gray-50')}>
                <input type="radio" name={'role_' + userId} value=""
                  checked={!role}
                  onChange={() => setRole('')}
                  className="w-3.5 h-3.5 accent-red-500" />
                <span className="text-xs font-medium text-red-600">移除权限（无法登录使用）</span>
              </label>
            </div>
          </div>

          {/* 部门 */}
          <div className="mb-3">
            <label className="text-xs font-medium text-gray-500 mb-1 block">部门</label>
            <select value={dept} onChange={e => setDept(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs focus:outline-none">
              <option value="">未分配</option>
              {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          {/* 账号状态 */}
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">账号状态</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={active}
                onChange={e => setActive(e.target.checked)}
                className="w-4 h-4 accent-indigo-600" />
              <span className={'text-xs font-medium ' + (active ? 'text-green-600' : 'text-gray-400')}>
                {active ? '启用' : '已停用'}
              </span>
            </label>
          </div>

          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving}
              className={'flex-1 rounded-lg py-2 text-xs font-medium text-white ' +
                (saved ? 'bg-green-500' : 'bg-indigo-600 hover:bg-indigo-700') +
                ' disabled:opacity-50'}>
              {saving ? '保存中...' : saved ? '✓ 已保存' : '保存权限'}
            </button>
            <button onClick={() => setOpen(false)}
              className="px-3 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
