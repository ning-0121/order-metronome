import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { UserRoleEditor } from '@/components/UserRoleEditor';

export default async function UserManagementPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { role, isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  // 获取所有用户资料
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, email, full_name, name, role, department, is_active, created_at')
    .order('created_at', { ascending: false });

  const ROLE_LABELS: Record<string, string> = {
    admin: '管理员', ceo: 'CEO', sales: '业务', finance: '财务',
    procurement: '采购', production: '生产', qc: '质检',
    logistics: '物流/仓库', quality: '品控',
  };

  const ROLE_COLORS: Record<string, string> = {
    admin: 'bg-purple-100 text-purple-700',
    ceo: 'bg-indigo-100 text-indigo-700',
    sales: 'bg-blue-100 text-blue-700',
    finance: 'bg-amber-100 text-amber-700',
    procurement: 'bg-teal-100 text-teal-700',
    production: 'bg-red-100 text-red-700',
    qc: 'bg-pink-100 text-pink-700',
    logistics: 'bg-green-100 text-green-700',
    quality: 'bg-orange-100 text-orange-700',
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">用户管理 & 权限授权</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              共 {profiles?.length || 0} 个账号 · 只有 Admin 可以修改角色
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* 角色说明卡片 */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { role: 'admin', desc: '全权限，可授权其他用户' },
            { role: 'sales', desc: '新建/管理自己订单，业务签核' },
            { role: 'finance', desc: '财务审核，成本复盘，出货第三签' },
            { role: 'procurement', desc: '采购节点，原辅料确认' },
            { role: 'production', desc: '生产节点，排期开裁，产前会' },
            { role: 'qc', desc: '中查/尾查，验货放行' },
            { role: 'logistics', desc: '仓库工作台，出货签核第二签' },
          ].map(({ role: r, desc }) => (
            <div key={r} className="bg-white rounded-xl border border-gray-200 p-3 flex items-start gap-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${ROLE_COLORS[r] || 'bg-gray-100 text-gray-600'}`}>
                {ROLE_LABELS[r] || r}
              </span>
              <span className="text-xs text-gray-500">{desc}</span>
            </div>
          ))}
        </div>

        {/* 用户列表 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
            <h2 className="text-sm font-medium text-gray-700">所有用户</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {!profiles?.length ? (
              <div className="text-center py-12 text-gray-400">暂无用户</div>
            ) : (
              (profiles as any[]).map((profile: any) => (
                <div key={profile.user_id} className="flex items-center justify-between px-5 py-4 hover:bg-gray-50">
                  <div className="flex items-center gap-4">
                    {/* 头像 */}
                    <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-semibold text-indigo-700 flex-shrink-0">
                      {(profile.full_name || profile.name || profile.email || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {profile.full_name || profile.name || '（未设置姓名）'}
                      </p>
                      <p className="text-xs text-gray-400">{profile.email}</p>
                      {profile.department && (
                        <p className="text-xs text-gray-400">{profile.department}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* 状态 */}
                    {profile.is_active === false && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">已停用</span>
                    )}
                    {/* 当前角色 */}
                    {profile.role ? (
                      <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${ROLE_COLORS[profile.role] || 'bg-gray-100 text-gray-600'}`}>
                        {ROLE_LABELS[profile.role] || profile.role}
                      </span>
                    ) : (
                      <span className="text-xs px-2.5 py-1 rounded-full bg-red-50 text-red-600 font-medium">未授权</span>
                    )}
                    {/* 编辑按钮 */}
                    <UserRoleEditor
                      userId={profile.user_id}
                      currentRole={profile.role}
                      currentDepartment={profile.department}
                      isActive={profile.is_active !== false}
                      userName={profile.full_name || profile.name || profile.email}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
