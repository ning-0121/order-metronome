import type { MetadataRoute } from 'next';

// 内部系统：禁止所有搜索引擎爬取/收录。
// 配合 layout.tsx 的 robots: { index:false } 双保险，防止公司外的人搜到本站。
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  };
}
