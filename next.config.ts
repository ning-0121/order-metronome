import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // ⚠️ 临时仍设 true，因为本仓库还有 ~101 个 TS 错（详见 docs/sprint-0-ts-debt.md）
    // Sprint 0/1 计划：分批清理 P0 错后切换为 false 强制类型校验
    // 切勿无理由改回 false — 会导致 Vercel 构建失败
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ['exceljs', 'imapflow'],
  // 生产任务单/QC 报告导出在运行时用 fs 读 public/templates/*.xlsx 母版。
  // Vercel 上 public/ 是 CDN 静态资源,默认不进 serverless function 文件系统 → fs 读不到 → 导出报"母版缺失"。
  // 用 outputFileTracingIncludes 强制把母版打进这些路由的函数包(生产任务单在订单详情/采购核料/生产中心页触发)。
  outputFileTracingIncludes: {
    '/orders/[id]': ['./public/templates/**'],
    '/procurement/verify/[orderId]': ['./public/templates/**'],
    '/production/order/[id]': ['./public/templates/**'],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
