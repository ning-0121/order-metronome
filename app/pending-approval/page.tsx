import { signOut } from '@/app/actions/auth';

/**
 * 待审批页 —— 已登录(@qimoclothing.com)但管理员尚未分配角色的用户落在这里。
 * 安全:middleware 把「无角色 + 非白名单」用户全部重定向到此页,阻断进入系统。
 * 此前漏洞:注册后 role=null 也能强刷进系统并被当成 sales(2026-07-03 修复)。
 */
export default function PendingApprovalPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">账号待管理员授权</h1>
        <p className="text-sm text-gray-600 leading-relaxed">
          你的账号已注册成功,但<b>管理员还没有给你分配角色</b>。
          分配角色后才能进入系统。管理员已收到通知,请稍候或直接联系管理员。
        </p>
        <div className="mt-6 rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-700 text-left">
          管理员操作:系统门户 → 用户管理 → 找到你的账号 → 分配角色(业务/跟单/采购/财务/生产/品控/物流等)。
        </div>
        <form action={signOut} className="mt-6">
          <button type="submit"
            className="w-full py-2.5 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-gray-800">
            退出登录
          </button>
        </form>
      </div>
    </div>
  );
}
