import { redirect } from 'next/navigation';

/**
 * 仓库工作台 —— 已下线,永久重定向到 /dashboard。
 *
 * V1 收敛时决定隐藏此页,做法是在函数第一行 redirect,把原来 130 行页面体留在下面
 * 并注释「以下代码保留但不再可达」。那 130 行从此既不会执行、也不会被维护,
 * 却仍然参与构建、仍然出现在搜索结果里,读代码的人还得先判断它是不是活的。
 * 2026-08-01 全面审计:删掉死代码,只留重定向本身
 * (保留路由是为了老书签/老链接不 404)。
 *
 * 如果将来真要恢复仓库工作台,从 git 历史取回比留着一段没人维护的代码更靠谱。
 */
export default function WarehousePage() {
  redirect('/dashboard');
}
