import { NetTestClient } from './NetTestClient';

/**
 * /net-test —— 办公室网络到各云区域的实测(2026-08-06)。
 *
 * 【为什么要有这个页】员工反馈「翻墙到美国就很快」→ 慢的不是服务器,
 * 是普通跨境链路的质量。迁库要选区(东京/新加坡/首尔),哪个区从义乌
 * 办公室走得最干净只能实测 —— 在员工的浏览器里直接对各区域发请求计时,
 * 这才是真实用户路径(选区拍脑袋 = 迁完可能白迁)。
 *
 * 测的是连通耗时对比,不传任何业务数据。登录用户可见(走全局 auth 中间件)。
 */
export const dynamic = 'force-dynamic';

export default function NetTestPage() {
  return <NetTestClient />;
}
