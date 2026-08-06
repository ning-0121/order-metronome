'use client';

/**
 * 浏览器端测速:对各云区域发轻量请求计时,选迁移目标区用。
 *
 * 方法:每个目标先发 1 次冷请求(含 DNS+TLS 握手,最接近"第一次打开"的体感),
 * 再连发 4 次热请求取中位数(连接复用,最接近"页面内每次操作")。
 * AWS 各区域端点用 DynamoDB(直接回 400,无重定向)—— 第一版用的 S3 根路径会
 * 307 跳到 aws.amazon.com 营销页,把每行都多算一次亚马逊官网的耗时,数值全部虚高
 * (2026-08-06 CEO 觉得不对,是对的)。no-cors 拿不到响应体,但计时有效;8s 超时记失败。
 *
 * ⚠️ 结果解读:比的是**相对差距**,不是绝对值。哪个区中位数低、失败少,迁哪个。
 */

import { useEffect, useState } from 'react';

interface Target { key: string; label: string; url: string; note: string }

const TARGETS: Target[] = [
  { key: 'this-app', label: '本系统(Vercel 边缘)', url: '/manifest.json', note: '你到系统前门的距离(边缘缓存,不含函数)' },
  // 动态端点必过函数(美东 iad1),401 也照样执行 —— 这行 ≈ 每次点按钮/提交的真实来回。
  // 迁移后它应从 300-500ms 掉到边缘值+30ms 左右,是迁移成效的**精确前后对照**。
  { key: 'this-fn', label: '本系统·美东函数(每次操作的真实来回)', url: '/api/cron/reminders', note: '迁移要优化的就是这个数' },
  { key: 'db-now', label: '现数据库·美东弗吉尼亚', url: 'https://scrtebexbxablybqpdla.supabase.co/auth/v1/health', note: '现状 Supabase(走 Cloudflare)' },
  { key: 'aws-use1', label: 'AWS 美东弗吉尼亚', url: 'https://dynamodb.us-east-1.amazonaws.com/', note: '现库所在 AWS 区(裸区域对照)' },
  { key: 'aws-tokyo', label: 'AWS 东京', url: 'https://dynamodb.ap-northeast-1.amazonaws.com/', note: '候选区 ①' },
  { key: 'aws-sg', label: 'AWS 新加坡', url: 'https://dynamodb.ap-southeast-1.amazonaws.com/', note: '候选区 ②' },
  { key: 'aws-seoul', label: 'AWS 首尔', url: 'https://dynamodb.ap-northeast-2.amazonaws.com/', note: '候选区 ③' },
];

const ROUNDS = 4;
const TIMEOUT_MS = 8000;

interface Row { key: string; cold: number | null; warm: number[]; fails: number; running: boolean }

async function timeOne(url: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    // no-cors:跨域拿不到内容但连接/传输真实发生,计时成立;cache 必须禁掉
    await fetch(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now(), {
      mode: 'no-cors', cache: 'no-store', signal: ctrl.signal,
    });
    return performance.now() - t0;
  } catch {
    return null;   // 超时/被墙/丢包重传耗尽
  } finally {
    clearTimeout(timer);
  }
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export function NetTestClient() {
  const [rows, setRows] = useState<Row[]>(TARGETS.map((t) => ({ key: t.key, cold: null, warm: [], fails: 0, running: false })));
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');

  async function run() {
    setPhase('running');
    setRows(TARGETS.map((t) => ({ key: t.key, cold: null, warm: [], fails: 0, running: true })));
    // 逐目标串行测(互不干扰带宽);目标内先冷后热
    for (const t of TARGETS) {
      const cold = await timeOne(t.url);
      let fails = cold === null ? 1 : 0;
      const warm: number[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        const ms = await timeOne(t.url);
        if (ms === null) fails++; else warm.push(ms);
      }
      setRows((prev) => prev.map((r) => r.key === t.key ? { key: t.key, cold, warm, fails, running: false } : r));
    }
    setPhase('done');
  }

  useEffect(() => { run(); /* 打开即测 */ }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // 候选区里挑最优(只比 aws-* 候选)
  const candidates = rows.filter((r) => r.key.startsWith('aws-') && r.key !== 'aws-use1' && median(r.warm) !== null);
  const best = candidates.length
    ? candidates.reduce((a, b) => (median(a.warm)! + a.fails * 1000 <= median(b.warm)! + b.fails * 1000 ? a : b))
    : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-bold text-gray-900">🌐 办公网络 → 各云区域实测</h1>
      <p className="mt-1 text-sm text-gray-500">
        给服务器迁移选区用。<b>请在办公室、不开 VPN</b> 的电脑上打开本页,等自动测完后把整页截图发给管理员。
      </p>

      <table className="mt-5 w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="py-2">目标</th>
            <th className="py-2 text-right">首次连接</th>
            <th className="py-2 text-right">热请求中位</th>
            <th className="py-2 text-right">失败</th>
          </tr>
        </thead>
        <tbody>
          {TARGETS.map((t) => {
            const r = rows.find((x) => x.key === t.key)!;
            const m = median(r.warm);
            const bad = r.fails > 0 || (m !== null && m > 1000);
            return (
              <tr key={t.key} className="border-b border-gray-100">
                <td className="py-2.5">
                  <div className="font-medium text-gray-800">{t.label}{best?.key === t.key && phase === 'done' ? ' 🏆' : ''}</div>
                  <div className="text-xs text-gray-400">{t.note}</div>
                </td>
                <td className="py-2.5 text-right tabular-nums">{r.running ? '测试中…' : r.cold === null ? '—' : `${Math.round(r.cold)}ms`}</td>
                <td className={`py-2.5 text-right font-semibold tabular-nums ${bad ? 'text-red-600' : m !== null && m < 200 ? 'text-green-600' : 'text-gray-800'}`}>
                  {r.running ? '…' : m === null ? '全部失败' : `${Math.round(m)}ms`}
                </td>
                <td className={`py-2.5 text-right tabular-nums ${r.fails ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>{r.running ? '' : `${r.fails}/${ROUNDS + 1}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {phase === 'done' && (
        <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 text-sm text-indigo-900">
          {best
            ? <>本次测试中最优候选区:<b>{TARGETS.find((t) => t.key === best.key)?.label}</b>。不同时段链路质量会变,建议早/午/晚各测一次再定。</>
            : '候选区全部失败 —— 请确认没开代理/VPN,或换一台电脑再测。'}
        </div>
      )}

      <div className="mt-4 flex gap-3">
        <button onClick={run} disabled={phase === 'running'} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
          {phase === 'running' ? '测试中…' : '再测一次'}
        </button>
      </div>
      <p className="mt-3 text-xs text-gray-400">仅测连通耗时,不发送任何业务数据。失败多/数值红 = 该方向链路差。</p>
    </div>
  );
}
