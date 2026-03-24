import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverActions: {
    bodySizeLimit: '20mb',  // 支持文件上传（默认仅 1MB）
  },
};

export default nextConfig;
