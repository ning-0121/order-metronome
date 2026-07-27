'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { getMailDigest, markMailHandled, bindMailToOrder, searchOrdersForMailBind, type MailDigestView, type DigestRow } from '@/app/actions/mail-digest';

const CAT_STYLE: Record<string, string> = {
  投诉: 'bg-red-100 text-red-700 border-red-200',
  交期: 'bg-orange-100 text-orange-700 border-orange-200',
  样品: 'bg-violet-100 text-violet-700 border-violet-200',
  PO: 'bg-blue-100 text-blue-700 border-blue-200',
  报价: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  物流: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  其他: 'bg-gray-100 text-gray-600 border-gray-200',
};
const CAT_LABEL: Record<string, string> = {
  投诉: '投诉/索赔', 交期: '交期/船期', 样品: '样品/打样', PO: 'PO/订单',
  报价: '报价/价格', 物流: '订舱/物流', 其他: '其他',
};

function impDot(imp: number | null) {
  const c = (imp ?? 0) >= 3 ? 'bg-red-500' : (imp ?? 0) === 2 ? 'bg-amber-500' : 'bg-gray-300';
  return <span className={`inline-block w-2 h-2 rounded-full ${c}`} title={`重点度 ${imp ?? 1}`} />;
}

function fromName(addr: string) {
  const m = addr.match(/^"?([^"<]+)"?\s*</);
  return (m ? m[1] : addr).trim().slice(0, 28);
}

function MailBinder({ mailId, onBound }: { mailId: string; onBound: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchOrdersForMailBind(q);
      if (alive) setResults(r);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open]);
  if (!open) {
    return <button onClick={() => setOpen(true)} className="text-[11px] px-1.5 py-0.5 rounded border border-dashed border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100">🔗 绑定订单</button>;
  }
  return (
    <span className="inline-flex flex-col gap-1 relative">
      <span className="inline-flex items-center gap-1">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜 内部单号/PO/客户/款号"
          className="w-48 text-[11px] border border-amber-300 rounded px-2 py-0.5 outline-none" />
        <button onClick={() => setOpen(false)} className="text-[11px] text-gray-400 hover:text-gray-600">取消</button>
      </span>
      {results.length > 0 && (
        <span className="absolute top-6 left-0 z-10 w-64 max-h-52 overflow-auto bg-white border border-gray-200 rounded-lg shadow flex flex-col">
          {results.map((o) => (
            <button key={o.id} disabled={busy}
              onClick={async () => { setBusy(true); const res = await bindMailToOrder(mailId, o.id); setBusy(false); if (res.ok) onBound(); }}
              className="text-left text-[11px] px-2.5 py-1.5 hover:bg-indigo-50 border-b border-gray-100 last:border-0 disabled:opacity-50">
              {o.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function MailCard({ row, onMark, onBound, dim }: { row: DigestRow; onMark: (id: string, s: 'handled' | 'ignored') => void; onBound: () => void; dim?: boolean }) {
  const handled = row.handled_status === 'handled' || row.handled_status === 'ignored';
  return (
    <div className={`flex items-start gap-3 py-2.5 px-3 rounded-lg border ${handled ? 'opacity-45 border-gray-100 bg-gray-50' : 'border-gray-200 bg-white hover:border-gray-300'} transition-colors`}>
      <div className="pt-1">{impDot(row.importance)}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {row.category && (
            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${CAT_STYLE[row.category] || CAT_STYLE.其他}`}>
              {CAT_LABEL[row.category] || row.category}
            </span>
          )}
          {row.needs_action && !handled && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">⚑ {row.action_type || '要处理'}</span>
          )}
          {row.order_no ? (
            <Link href={`/orders/${row.order_id}?tab=email_center`} className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 hover:bg-indigo-100">
              #{row.order_no}
            </Link>
          ) : (
            !handled && <MailBinder mailId={row.id} onBound={onBound} />
          )}
          {row.customer_name && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">🏢 {row.customer_name}</span>
          )}
          {row.owner_name && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">👤 {row.owner_name}</span>
          )}
        </div>
        <div className="text-sm text-gray-900 mt-1 leading-snug">
          {row.summary || row.subject}
        </div>
        <div className="text-[12px] text-gray-500 mt-0.5 truncate">
          {fromName(row.from_email)} · {new Date(row.received_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          {row.summary && <span className="text-gray-400"> · {row.subject.slice(0, 40)}</span>}
        </div>
      </div>
      {!handled && (
        <div className="flex flex-col gap-1 shrink-0">
          <button onClick={() => onMark(row.id, 'handled')} className="text-[11px] px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 whitespace-nowrap">已处理</button>
          <button onClick={() => onMark(row.id, 'ignored')} className="text-[11px] px-2 py-1 rounded bg-gray-50 text-gray-500 border border-gray-200 hover:bg-gray-100 whitespace-nowrap">忽略</button>
        </div>
      )}
    </div>
  );
}

export function InboxClient() {
  const [view, setView] = useState<MailDigestView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const res = await getMailDigest(3);
    if (res.error) setErr(res.error); else setView(res.data || null);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const onMark = async (id: string, s: 'handled' | 'ignored') => {
    // 乐观更新
    setView((v) => v ? { ...v, keyMonitor: v.keyMonitor.map(r => r.id === id ? { ...r, handled_status: s } : r),
      byCategory: v.byCategory.map(g => ({ ...g, rows: g.rows.map(r => r.id === id ? { ...r, handled_status: s } : r) })) } : v);
    const res = await markMailHandled(id, s);
    if (res.error) { setErr(res.error); load(); }
  };

  return (
    <div>
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">📬 邮件归纳</h1>
        <button onClick={load} className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-100">刷新</button>
      </div>
      <p className="text-sm text-gray-500 mb-4">近 3 天的客户/供应商邮件,系统已自动分类归纳。重点先看上面红框。</p>

      {loading && <div className="text-sm text-gray-400 py-10 text-center">加载中…</div>}
      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-4">出错:{err}</div>}

      {view && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
            <Stat n={view.counts.total} label={view.scope === 'all' ? '近3天全部' : '归属我的'} />
            <Stat n={view.counts.keyMonitor} label="重点监控" tone="red" />
            <Stat n={view.counts.needsAction} label="待我处理" tone="amber" />
            <Stat n={view.counts.unhandled} label="未处理" />
          </div>

          {view.aiPending > 0 && (
            <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
              其中 {view.aiPending} 封仅走了规则分类(AI 一句话摘要待补)—— 类别与重点度已可用;AI 摘要需 Anthropic 账户开通后自动补齐。
            </div>
          )}

          {view.keyMonitor.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-2">
                🔴 重点监控 <span className="text-xs font-normal text-gray-400">投诉 / 交期变更 / 紧急,未处理</span>
              </h2>
              <div className="flex flex-col gap-2 p-2 rounded-xl bg-red-50/50 border border-red-100">
                {view.keyMonitor.map((r) => <MailCard key={r.id} row={r} onMark={onMark} onBound={load} />)}
              </div>
            </section>
          )}

          {view.byCategory.map((g) => (
            <section key={g.category} className="mb-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                <span className={`text-[11px] px-1.5 py-0.5 rounded border ${CAT_STYLE[g.category] || CAT_STYLE.其他}`}>{g.label}</span>
                <span className="text-xs font-normal text-gray-400">{g.rows.length} 封</span>
              </h2>
              <div className="flex flex-col gap-1.5">
                {g.rows.map((r) => <MailCard key={r.id} row={r} onMark={onMark} onBound={load} />)}
              </div>
            </section>
          ))}

          {view.counts.total === 0 && (
            <div className="text-sm text-gray-400 py-12 text-center border border-dashed border-gray-200 rounded-xl">
              近 3 天没有需要归纳的邮件。收信与归纳每 15 分钟自动跑一轮。
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: 'red' | 'amber' }) {
  const c = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-gray-900';
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5">
      <div className={`text-2xl font-bold tabular-nums ${c}`}>{n}</div>
      <div className="text-[12px] text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}
