/**
 * 打样费承担方常量(2026-07-27 P0 修)。
 * 原来 export 在 app/actions/sample-fee.ts('use server')里 —— server-actions 文件只能导出 async 函数,
 * 导出对象常量会在运行时报「A "use server" file can only export async functions, found object」,
 * 把整条 order 页 action chunk 打挂(所有订单标签页 action 失败)。挪到纯模块,server + client 都能 import。
 */
export const SAMPLE_FEE_BEARERS: Record<string, string> = {
  company: '公司承担', customer: '客户承担', fabric_customer: '面料客户+加工公司', tbd: '待确认',
};
