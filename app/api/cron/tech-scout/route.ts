/**
 * 技术侦察员 — 每周日凌晨搜索 GitHub 寻找可用的新能力
 *
 * 安全原则：只搜索和分析，不自动导入代码
 * 搜索 → AI分析相关性 → 生成推荐报告 → 通知CEO审核
 *
 * 搜索方向：
 *   1. 服装外贸 ERP / 订单管理的开源项目
 *   2. AI 质检 / 验货 / 面料识别
 *   3. 供应链管理 / 排期优化算法
 *   4. 贸易合规 / 关税计算
 *   5. 汇率 / 财务计算工具
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

// 搜索方向和关键词
const SEARCH_TOPICS = [
  { topic: 'garment-qc', keywords: 'garment quality inspection AI', description: '服装AI质检' },
  { topic: 'fabric-detection', keywords: 'fabric defect detection machine learning', description: '面料缺陷检测' },
  { topic: 'supply-chain', keywords: 'supply chain scheduling optimization textile', description: '供应链排期优化' },
  { topic: 'trade-compliance', keywords: 'trade compliance tariff calculator API', description: '贸易合规关税计算' },
  { topic: 'erp-garment', keywords: 'garment ERP open source order management', description: '服装ERP订单管理' },
  { topic: 'aql-calculator', keywords: 'AQL sampling calculator inspection', description: 'AQL抽样计算' },
  { topic: 'exchange-rate', keywords: 'exchange rate API real-time currency', description: '实时汇率API' },
  { topic: 'ocr-document', keywords: 'document OCR extraction invoice PO parser', description: '单据OCR识别' },
];

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  updated_at: string;
  language: string;
  topics: string[];
}

async function searchGitHub(query: string): Promise<GitHubRepo[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // GitHub Search API (无需token，但有速率限制：10次/分钟)
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'OrderMetronome-TechScout/1.0',
    };
    // 如果有 GitHub token 可以提高速率限制
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) headers['Authorization'] = `token ${ghToken}`;

    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map((item: any) => ({
      name: item.name,
      full_name: item.full_name,
      description: item.description || '',
      html_url: item.html_url,
      stargazers_count: item.stargazers_count,
      updated_at: item.updated_at,
      language: item.language || '',
      topics: item.topics || [],
    }));
  } catch {
    return [];
  }
}

async function analyzeRelevance(repos: GitHubRepo[], topic: string): Promise<{
  repo: string;
  url: string;
  stars: number;
  relevance: 'high' | 'medium' | 'low';
  recommendation: string;
}[]> {
  // 简单的规则引擎评分（不调用AI，节省成本）
  return repos
    .filter(r => r.stargazers_count >= 50) // 至少50星
    .filter(r => {
      // 最近1年有更新
      const lastUpdate = new Date(r.updated_at);
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      return lastUpdate > oneYearAgo;
    })
    .map(r => {
      let relevance: 'high' | 'medium' | 'low' = 'low';
      let recommendation = '';

      // 高相关性标准
      const desc = (r.description + ' ' + r.topics.join(' ')).toLowerCase();
      const isHighlyRelevant =
        desc.includes('garment') || desc.includes('textile') || desc.includes('apparel') ||
        desc.includes('quality inspection') || desc.includes('aql') ||
        desc.includes('supply chain') || desc.includes('erp');

      if (isHighlyRelevant && r.stargazers_count >= 500) {
        relevance = 'high';
        recommendation = `⭐ 高度相关（${r.stargazers_count}星），建议详细评估是否可借鉴其${topic}方面的能力`;
      } else if (isHighlyRelevant || r.stargazers_count >= 1000) {
        relevance = 'medium';
        recommendation = `可能有参考价值，${r.language}语言，${r.stargazers_count}星`;
      } else {
        relevance = 'low';
        recommendation = `一般参考`;
      }

      return {
        repo: r.full_name,
        url: r.html_url,
        stars: r.stargazers_count,
        relevance,
        recommendation,
      };
    })
    .filter(r => r.relevance !== 'low');
}

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const supabase = await createClient();
  if (!isCron) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const allFindings: any[] = [];

  // 搜索各个方向
  for (const topic of SEARCH_TOPICS) {
    try {
      const repos = await searchGitHub(topic.keywords);
      const relevant = await analyzeRelevance(repos, topic.description);

      if (relevant.length > 0) {
        allFindings.push({
          topic: topic.description,
          keywords: topic.keywords,
          results: relevant,
        });
      }

      // GitHub API 速率限制：稍等一下
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch {}
  }

  // 生成推荐报告
  const highPriority = allFindings.flatMap(f =>
    f.results.filter((r: any) => r.relevance === 'high').map((r: any) => ({
      ...r,
      topic: f.topic,
    }))
  );

  // 通知CEO
  if (highPriority.length > 0) {
    const { data: admins } = await (supabase.from('profiles') as any)
      .select('user_id')
      .contains('roles', ['admin']);

    const summary = `发现 ${highPriority.length} 个高相关开源项目：\n` +
      highPriority.slice(0, 5).map((r: any) =>
        `• ${r.topic}: ${r.repo}（${r.stars}⭐）\n  ${r.url}`
      ).join('\n');

    for (const admin of (admins || [])) {
      await (supabase.from('notifications') as any).insert({
        user_id: admin.user_id,
        type: 'tech_scout',
        title: `🔍 技术侦察：发现 ${highPriority.length} 个可能提升系统的开源项目`,
        message: summary.slice(0, 500),
        status: 'unread',
      });
    }
  }

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    topics_searched: SEARCH_TOPICS.length,
    findings: allFindings,
    high_priority: highPriority,
    message: highPriority.length > 0
      ? `发现 ${highPriority.length} 个高度相关的项目，已通知管理员`
      : '本周未发现新的高相关项目',
  });
}
