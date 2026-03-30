'use client';

import { useState, useTransition } from 'react';
import { runCollectionPipeline, searchKnowledge, addManualKnowledge, runAIAnalysis, getAIAnalysisResults, type AIAnalysisResult } from '@/app/actions/ai-knowledge';
import { KNOWLEDGE_TYPE_LABELS, KNOWLEDGE_SOURCE_LABELS } from '@/lib/domain/ai-knowledge';
import type { KnowledgeEntry, KnowledgeType, CollectionLog } from '@/lib/domain/ai-knowledge';

interface Props {
  recentEntries: KnowledgeEntry[];
  lastRuns: CollectionLog[];
}

export function AIKnowledgeClient({ recentEntries: initialEntries, lastRuns }: Props) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>(initialEntries);
  const [isPending, startTransition] = useTransition();
  const [collectResult, setCollectResult] = useState<any[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [filterType, setFilterType] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiResults, setAiResults] = useState<AIAnalysisResult[]>([]);
  const [aiLoaded, setAiLoaded] = useState(false);

  // 加载已有 AI 分析结果
  const loadAIResults = () => {
    if (aiLoaded) return;
    startTransition(async () => {
      const res = await getAIAnalysisResults();
      setAiResults(res.data);
      setAiLoaded(true);
    });
  };

  // 运行 AI 分析
  const handleAIAnalysis = () => {
    setAnalyzing(true);
    startTransition(async () => {
      const result = await runAIAnalysis();
      if (result.data) {
        setAiResults(result.data);
        setAiLoaded(true);
      } else {
        alert(result.error || 'AI 分析失败');
      }
      setAnalyzing(false);
    });
  };

  // 运行采集管道
  const handleCollect = () => {
    setCollecting(true);
    setCollectResult([]);
    startTransition(async () => {
      const result = await runCollectionPipeline();
      if (result.data) {
        setCollectResult(result.data);
        // 刷新列表
        const searchResult = await searchKnowledge({ limit: 20 });
        if (searchResult.data) setEntries(searchResult.data);
      } else {
        alert(result.error || '采集失败');
      }
      setCollecting(false);
    });
  };

  // 搜索/筛选
  const handleSearch = () => {
    startTransition(async () => {
      const result = await searchKnowledge({
        keyword: searchKeyword || undefined,
        knowledgeType: filterType || undefined,
        limit: 50,
      });
      if (result.data) setEntries(result.data);
    });
  };

  // 手动添加
  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await addManualKnowledge({
        knowledge_type: form.get('type') as KnowledgeType,
        category: form.get('category') as string,
        title: form.get('title') as string,
        content: form.get('content') as string,
        customer_name: (form.get('customer') as string) || undefined,
        factory_name: (form.get('factory') as string) || undefined,
        impact_level: form.get('impact') as string,
      });
      if (result.error) {
        alert(result.error);
      } else {
        setShowAddForm(false);
        const searchResult = await searchKnowledge({ limit: 20 });
        if (searchResult.data) setEntries(searchResult.data);
      }
    });
  };

  const impactColors: Record<string, string> = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-yellow-100 text-yellow-700',
    low: 'bg-gray-100 text-gray-600',
  };

  const typeIcons: Record<string, string> = {
    employee: '👤',
    customer: '🤝',
    factory: '🏭',
    process: '⚙️',
    industry: '🌍',
  };

  return (
    <div className="space-y-6">
      {/* 操作栏 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleCollect}
            disabled={collecting || isPending}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-all"
          >
            {collecting ? '⏳ 采集中...' : '🔄 运行数据采集管道'}
          </button>
          <button
            onClick={handleAIAnalysis}
            disabled={analyzing || isPending}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-all"
          >
            {analyzing ? '🧠 AI 分析中...' : '🧠 运行 AI 分析'}
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all"
          >
            ✏️ 手动录入知识
          </button>

          <div className="flex-1" />

          {/* 搜索 */}
          <div className="flex items-center gap-2">
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="h-9 rounded-lg border border-gray-300 text-sm px-2"
            >
              <option value="">全部类型</option>
              {Object.entries(KNOWLEDGE_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <input
              type="text"
              value={searchKeyword}
              onChange={e => setSearchKeyword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="搜索关键词..."
              className="h-9 rounded-lg border border-gray-300 text-sm px-3 w-40 md:w-56"
            />
            <button
              onClick={handleSearch}
              disabled={isPending}
              className="h-9 px-3 bg-gray-100 rounded-lg text-sm hover:bg-gray-200 transition-all"
            >
              搜索
            </button>
          </div>
        </div>

        {/* 采集结果 */}
        {collectResult.length > 0 && (
          <div className="mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
            <p className="text-sm font-medium text-green-800 mb-2">采集完成：</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
              {collectResult.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-gray-600">
                    {KNOWLEDGE_SOURCE_LABELS[r.source as keyof typeof KNOWLEDGE_SOURCE_LABELS] || r.source}:
                  </span>
                  <span className="font-medium text-green-700">+{r.ingested}</span>
                  <span className="text-gray-400">/ 扫描 {r.scanned}</span>
                  {r.error && <span className="text-red-500 text-xs">{r.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 手动录入表单 */}
      {showAddForm && (
        <form onSubmit={handleAdd} className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
          <h3 className="text-base font-semibold">✏️ 手动录入知识</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">知识类型</label>
              <select name="type" required className="w-full h-9 rounded-lg border border-gray-300 text-sm px-2">
                {Object.entries(KNOWLEDGE_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">类别</label>
              <input name="category" required placeholder="如：best_practice / quality_risk" className="w-full h-9 rounded-lg border border-gray-300 text-sm px-3" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">影响等级</label>
              <select name="impact" className="w-full h-9 rounded-lg border border-gray-300 text-sm px-2">
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="low">低</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">标题</label>
            <input name="title" required placeholder="一句话总结" className="w-full h-9 rounded-lg border border-gray-300 text-sm px-3" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">内容</label>
            <textarea name="content" required rows={3} placeholder="详细描述..." className="w-full rounded-lg border border-gray-300 text-sm p-3" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">关联客户（选填）</label>
              <input name="customer" placeholder="客户名" className="w-full h-9 rounded-lg border border-gray-300 text-sm px-3" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">关联工厂（选填）</label>
              <input name="factory" placeholder="工厂名" className="w-full h-9 rounded-lg border border-gray-300 text-sm px-3" />
            </div>
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={isPending} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              保存
            </button>
            <button type="button" onClick={() => setShowAddForm(false)} className="px-4 py-2 bg-gray-100 rounded-lg text-sm text-gray-700 hover:bg-gray-200">
              取消
            </button>
          </div>
        </form>
      )}

      {/* 最近采集日志 */}
      {lastRuns.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">🕐 采集日志</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 pr-4">时间</th>
                  <th className="pb-2 pr-4">来源</th>
                  <th className="pb-2 pr-4">扫描</th>
                  <th className="pb-2 pr-4">入库</th>
                  <th className="pb-2">跳过</th>
                </tr>
              </thead>
              <tbody>
                {lastRuns.map((run) => (
                  <tr key={run.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 text-gray-600">{new Date(run.run_at).toLocaleString('zh-CN')}</td>
                    <td className="py-2 pr-4">{KNOWLEDGE_SOURCE_LABELS[run.source_type as keyof typeof KNOWLEDGE_SOURCE_LABELS] || run.source_type}</td>
                    <td className="py-2 pr-4">{run.records_scanned}</td>
                    <td className="py-2 pr-4 font-medium text-green-700">+{run.records_ingested}</td>
                    <td className="py-2 text-gray-400">{run.records_skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AI 分析结果 */}
      <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-2xl border border-purple-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            🧠 AI 智能分析
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-600 font-medium">Claude</span>
          </h2>
          {!aiLoaded && (
            <button onClick={loadAIResults} className="text-xs text-purple-600 hover:text-purple-800 font-medium">
              加载历史分析 →
            </button>
          )}
        </div>

        {aiResults.length === 0 && aiLoaded && (
          <p className="text-sm text-gray-500 py-4 text-center">暂无 AI 分析结果。点击"运行 AI 分析"开始（需要先运行数据采集）</p>
        )}

        {aiResults.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {aiResults.map((r, i) => {
              const dimIcons = { customer: '🤝', factory: '🏭', process: '⚙️' };
              const dimLabels = { customer: '客户画像', factory: '工厂评估', process: '流程分析' };
              const riskColors = { high: 'border-red-300 bg-red-50', medium: 'border-amber-300 bg-amber-50', low: 'border-green-300 bg-green-50' };
              return (
                <div key={i} className={`rounded-xl border p-4 ${riskColors[r.riskRating] || 'border-gray-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{dimIcons[r.dimension] || '📊'}</span>
                    <span className="text-xs text-gray-500">{dimLabels[r.dimension] || r.dimension}</span>
                    <span className="text-sm font-bold text-gray-900">{r.subject}</span>
                  </div>
                  <p className="text-sm text-gray-700 mb-2">{r.summary}</p>
                  {r.keyFindings?.length > 0 && (
                    <ul className="text-xs text-gray-600 space-y-0.5 mb-2">
                      {r.keyFindings.map((f, j) => <li key={j}>· {f}</li>)}
                    </ul>
                  )}
                  {r.recommendations?.length > 0 && (
                    <div className="text-xs text-indigo-700 bg-indigo-50 rounded-md px-2 py-1.5">
                      建议：{r.recommendations.join('；')}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 mt-2">分析时间：{r.analyzedAt ? new Date(r.analyzedAt).toLocaleDateString('zh-CN') : '-'}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 知识条目列表 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          📚 知识条目 <span className="text-sm font-normal text-gray-400">（最近 {entries.length} 条）</span>
        </h2>
        {entries.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-4xl mb-2">🧠</p>
            <p>知识库为空，点击"运行数据采集管道"开始</p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <div key={entry.id} className="border border-gray-100 rounded-xl p-4 hover:border-gray-200 transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-lg">{typeIcons[entry.knowledge_type] || '📄'}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">
                        {KNOWLEDGE_TYPE_LABELS[entry.knowledge_type as keyof typeof KNOWLEDGE_TYPE_LABELS] || entry.knowledge_type}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                        {entry.category}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${impactColors[entry.impact_level] || impactColors.medium}`}>
                        {entry.impact_level === 'high' ? '高影响' : entry.impact_level === 'low' ? '低影响' : '中影响'}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-gray-900 truncate">{entry.title}</p>
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2">{entry.content}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                      {entry.customer_name && <span>🤝 {entry.customer_name}</span>}
                      {entry.factory_name && <span>🏭 {entry.factory_name}</span>}
                      <span>
                        {KNOWLEDGE_SOURCE_LABELS[entry.source_type as keyof typeof KNOWLEDGE_SOURCE_LABELS] || entry.source_type}
                      </span>
                      <span>{new Date(entry.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-xs text-gray-400">
                      🏷️ {INDUSTRY_OPTIONS_MAP[entry.industry_tag] || entry.industry_tag} / {entry.scale_tag}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const INDUSTRY_OPTIONS_MAP: Record<string, string> = {
  apparel: '服装',
  textile: '纺织',
  accessories: '配件',
  footwear: '鞋业',
  home_textile: '家纺',
  other: '其他',
};
