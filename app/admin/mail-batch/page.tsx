'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function MailBatchPage() {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [stats, setStats] = useState({ totalFetched: 0, totalInserted: 0, totalSkipped: 0, batches: 0 });
  const [days, setDays] = useState(180);
  const [batchSize, setBatchSize] = useState(20);
  const [maxBatches, setMaxBatches] = useState(20);

  function log(msg: string) {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  async function startBatch() {
    setRunning(true);
    setLogs([]);
    setStats({ totalFetched: 0, totalInserted: 0, totalSkipped: 0, batches: 0 });

    let skip = 0;
    let totalFetched = 0;
    let totalInserted = 0;
    let totalSkipped = 0;
    let batchNum = 0;

    log(`开始批量导入：每次${batchSize}封，最多${maxBatches}批，共${maxBatches * batchSize}封`);

    while (batchNum < maxBatches) {
      batchNum++;
      log(`第 ${batchNum} 批：skip=${skip}`);

      try {
        const res = await fetch(`/api/mail-import?days=${days}&max=${batchSize}&skip=${skip}`);
        const data = await res.json();

        if (data.error) {
          log(`❌ 错误：${data.error}`);
          break;
        }

        totalFetched += data.fetched || 0;
        totalInserted += data.inserted || 0;
        totalSkipped += data.skipped || 0;

        setStats({ totalFetched, totalInserted, totalSkipped, batches: batchNum });

        log(`✅ 第${batchNum}批完成：拉取${data.fetched}封，入库${data.inserted}封，跳过${data.skipped}封`);

        if (data.fetched < batchSize) {
          log(`已到末尾或没有更多邮件`);
          break;
        }

        skip += batchSize;

        // 每批之间停1秒，避免过载
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err: any) {
        log(`❌ 异常：${err.message}`);
        break;
      }
    }

    log(`🎉 全部完成！总计：拉取${totalFetched}，入库${totalInserted}，跳过${totalSkipped}`);

    // 自动触发重新处理
    log(`正在触发客户识别+订单匹配...`);
    try {
      const res = await fetch('/api/mail-reprocess');
      const data = await res.json();
      log(`✅ 处理完成：识别${data.identified}封客户，匹配${data.matched}个订单`);
    } catch (err: any) {
      log(`❌ 处理失败：${err.message}`);
    }

    setRunning(false);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📧 历史邮件批量导入</h1>
          <p className="text-sm text-gray-500 mt-1">从已配置的 IMAP 邮箱（{process.env.NEXT_PUBLIC_IMAP_USER || 'alex@'}）批量拉取历史邮件</p>
        </div>
        <Link href="/admin" className="text-sm text-gray-400 hover:text-gray-600">← 返回</Link>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">回溯天数</label>
            <select value={days} onChange={e => setDays(parseInt(e.target.value))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" disabled={running}>
              <option value={30}>30 天</option>
              <option value={60}>60 天</option>
              <option value={90}>90 天</option>
              <option value={180}>180 天</option>
              <option value={365}>365 天</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">每批数量</label>
            <select value={batchSize} onChange={e => setBatchSize(parseInt(e.target.value))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" disabled={running}>
              <option value={10}>10 封</option>
              <option value={20}>20 封</option>
              <option value={30}>30 封</option>
              <option value={50}>50 封</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">最多批数</label>
            <select value={maxBatches} onChange={e => setMaxBatches(parseInt(e.target.value))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" disabled={running}>
              <option value={5}>5 批</option>
              <option value={10}>10 批</option>
              <option value={20}>20 批</option>
              <option value={50}>50 批</option>
              <option value={100}>100 批</option>
            </select>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          预计总计 <span className="font-semibold text-indigo-600">{batchSize * maxBatches}</span> 封，
          每批间隔 1 秒，自动调用重新处理
        </p>

        <button
          onClick={startBatch}
          disabled={running}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {running ? '正在导入...' : '开始批量导入'}
        </button>

        {/* 实时统计 */}
        {(running || stats.batches > 0) && (
          <div className="grid grid-cols-4 gap-2 pt-4 border-t border-gray-100">
            <div className="text-center">
              <div className="text-2xl font-bold text-indigo-600">{stats.batches}</div>
              <div className="text-xs text-gray-500">批次</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{stats.totalFetched}</div>
              <div className="text-xs text-gray-500">总拉取</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{stats.totalInserted}</div>
              <div className="text-xs text-gray-500">入库</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-400">{stats.totalSkipped}</div>
              <div className="text-xs text-gray-500">跳过</div>
            </div>
          </div>
        )}
      </div>

      {/* 实时日志 */}
      {logs.length > 0 && (
        <div className="mt-6 bg-gray-900 rounded-xl p-4 text-xs font-mono text-green-400 max-h-96 overflow-y-auto">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
