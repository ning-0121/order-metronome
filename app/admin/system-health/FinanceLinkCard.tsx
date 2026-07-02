'use client';

/**
 * 财务系统联调卡 —— 两个一键诊断(复用现有 admin-only 诊断端点):
 * ① 连通测试:GET /api/integration/test-finance-health(ENV 指纹 + 对方 health)
 * ② 签名 ping:POST /api/integration/test-finance-sync(真发一次 test.ping,验证 API Key + 签名配对)
 * 给非技术管理员用,免开浏览器控制台。
 */

import { useState } from 'react';

export function FinanceLinkCard() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [kind, setKind] = useState<'health' | 'ping' | null>(null);

  async function run(which: 'health' | 'ping') {
    setBusy(which); setResult(null); setKind(which);
    try {
      const res = await fetch(
        which === 'health' ? '/api/integration/test-finance-health' : '/api/integration/test-finance-sync',
        { method: which === 'health' ? 'GET' : 'POST' },
      );
      const json = await res.json().catch(() => ({ error: `HTTP ${res.status}(非 JSON 响应)` }));
      setResult(json);
    } catch (e: any) {
      setResult({ error: e?.message || '请求失败' });
    } finally { setBusy(null); }
  }

  // 简易判定,给非技术用户一句话结论
  const verdict = (() => {
    if (!result) return null;
    if (kind === 'health') {
      const envOk = result.env && !Object.values(result.env).some((v: any) => String(v).startsWith('✗'));
      if (!envOk) return { ok: false, text: '❌ 环境变量缺失 —— 看下方 env 哪项是 ✗,去 Vercel 补配后 Redeploy' };
      if (result.health_check?.passed) return { ok: true, text: '✅ 配置齐全,财务系统连通正常' };
      return { ok: false, text: '❌ 配置齐全但连不上财务系统 —— ' + (result.health_check?.error || '看下方详情') };
    }
    if (result.ok === true || result.response?.status === 200) return { ok: true, text: '✅ 签名 ping 成功 —— 两边密钥配对正确,数据管道全通' };
    if (result.response?.status === 401 || result.response?.status === 403) return { ok: false, text: '❌ 财务系统拒绝(401/403)—— 两边的 API Key 或 Webhook Secret 不一致,需对齐后各自 Redeploy' };
    return { ok: false, text: '⚠️ 未完全通过 —— 看下方详情(stage/error 字段)' };
  })();

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 mb-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">🔗 财务系统联调</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            目标:{'{FINANCE_SYSTEM_URL}'} · ① 先测连通;② 再发签名 ping 验证两边密钥配对(发 test.ping,不产生业务数据)
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run('health')} disabled={!!busy}
            className="text-xs px-3 py-2 rounded-lg bg-white text-gray-700 border border-gray-300 font-medium hover:bg-gray-50 disabled:opacity-50">
            {busy === 'health' ? '测试中…' : '① 连通测试'}
          </button>
          <button onClick={() => run('ping')} disabled={!!busy}
            className="text-xs px-3 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy === 'ping' ? '发送中…' : '② 发签名 Ping(验密钥配对)'}
          </button>
        </div>
      </div>

      {verdict && (
        <div className={`mt-3 text-sm font-medium ${verdict.ok ? 'text-emerald-700' : 'text-red-600'}`}>{verdict.text}</div>
      )}
      {result && (
        <pre className="mt-2 text-[11px] leading-relaxed bg-gray-50 border border-gray-100 rounded-lg p-3 overflow-x-auto max-h-72 overflow-y-auto text-gray-700">
{JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
