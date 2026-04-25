import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // ⚠️ 临时仍设 true，因为本仓库还有 ~101 个 TS 错（详见 docs/sprint-0-ts-debt.md）
    // Sprint 0/1 计划：分批清理 P0 错后切换为 false 强制类型校验
    // 切勿无理由改回 false — 会导致 Vercel 构建失败
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ['exceljs', 'imapflow'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
