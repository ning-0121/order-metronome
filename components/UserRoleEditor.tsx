'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateUserRoles } from '@/app/actions/users';

const ROLES = [
  { value: 'admin',       label: 'CEO/管理员',  desc: '全览数据，审批延期，指定人员' },
  { value: 'sales',       label: '业务/理单',    desc: '客户对接、PO确认、生产单、订舱报关' },
  { value: 'merchandiser', label: '跟单',       desc: '工厂协调、生产跟进、中查尾查、验货放行' },
  { value: 'finance',     label: '财务',        desc: '订单审核、加工费确认、收款' },
  { value: 'procurement', label: '采购',        desc: '面辅料采购、供应商跟进' },
  { value: 'logistics',   label: '物流/仓库',   desc: '出货签核、装箱、物流' },
];

const DEPARTMENTS = ['业务部', '财务部', '采购部', '跟单部', '仓储物流部', '管理层'];

interface Props {
  userId: string;
  currentRole?: string | null;
  currentRoles?: string[];
  currentDepartment?: string | null;
  isActive?: boolean;
  userName?: string;
}

export function UserRoleEditor({ userId, currentRole, currentRoles, currentDepartment, isActive = true, userName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // V2: 多角色选择
  const initialRoles = currentRoles && currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
  const [selectedRoles, setSelectedRoles] = useState<string[]>(initialRoles);
  const [dept, setDept] = useState(currentDepartment || '');
  const [active, setActive] = useState(isActive);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const toggleRole = (value: string) => {
    setSelectedRoles(prev =>
      prev.includes(value) ? prev.filter(r => r !== value) : [...prev, value]
    );
  };

  const handleSave = async () => {
    setSaving(true); setError(''); setSaved(false);
    const result = await updateUserRoles(userId, selectedRoles);

    if (result.error) { setError(result.error); }
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
        <div className="absolute right-0 top-8 z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-4 w-80">
          <p className="text-sm font-semibold text-gray-900 mb-3">{userName} 的权限设置</p>

          {/* 多角色选择 */}
          <div className="mb-3">
            <label className="text-xs font-medium text-gray-500 mb-1.5 block">
              角色（可多选）
              {selectedRoles.length > 0 && (
                <span className="ml-2 text-indigo-600">已选 {selectedRoles.length} 个</span>
              )}
            </label>
            <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
              {ROLES.map(r => {
                const isSelected = selectedRoles.includes(r.value);
                return (
                  <label key={r.value}
                    className={'flex items-center gap-2 p-2 rounded-lg cursor-pointer border ' +
                      (isSelected ? 'border-indigo-400 bg-indigo-50' : 'border-transparent hover:bg-gray-50')}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRole(r.value)}
                      className="w-3.5 h-3.5 accent-indigo-600 rounded"
                    />
                    <div>
                      <span className="text-xs font-medium text-gray-900">{r.label}</span>
                      <span className="text-xs text-gray-400 ml-1.5">{r.desc}</span>
                    </div>
                  </label>
                );
              })}
            </div>
            {selectedRoles.length === 0 && (
              <p className="text-xs text-red-500 mt-1">未选择角色 = 无法使用系统</p>
            )}
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
