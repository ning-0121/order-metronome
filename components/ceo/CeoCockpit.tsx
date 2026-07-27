import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCeoCockpit } from '@/lib/services/ceo-cockpit.service';
import { CeoDeptBoard } from '@/components/ceo/CeoDeptBoard';

/**
 * CEO 驾驶舱(2026-07-27):A 需我审批 · B 五部门异常 · C 新增 · D 需关注客户/订单 · E 员工报告。
 * 置顶于 /ceo,给 CEO 一屏监控;下方保留原作战室明细。自取数(getCeoCockpit)。
 */
export async function CeoCockpit({ userId, roles }: { userId: string; roles: string[] }) {
  const supabase = await createClient();
  let c;
  try { c = await getCeoCockpit(supabase, { userId, roles }); }
  catch (e) { return <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">驾驶舱聚合暂不可用:{e instanceof Error ? e.message : '未知错误'}</div>; }

  const Card = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
        {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
      </div>
      {children}
    </section>
  );
  const Stat = ({ n, label, tone = 'gray', href }: { n: number | string; label: string; tone?: string; href?: string }) => {
    const color = tone === 'red' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-emerald-600' : tone === 'indigo' ? 'text-indigo-600' : 'text-gray-800';
    const inner = (<><div className={`text-2xl font-bold ${color}`}>{n}</div><div className="text-[11px] text-gray-500">{label}</div></>);
    return href ? <Link href={href} className="block rounded-lg px-2 py-1.5 hover:bg-gray-50">{inner}</Link> : <div className="px-2 py-1.5">{inner}</div>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-bold text-gray-900">🎛 CEO 驾驶舱</h2>
        <span className="text-[11px] text-gray-400">监控为主 · 只在需要我拍板时介入</span>
      </div>

      {/* A 需我审批 */}
      <Card title="A · 需我介入 / 审批" hint={`待审批 ${c.A.total}`}>
        {c.A.groups.length === 0 && c.A.suspiciousDelays.length === 0 ? (
          <p className="text-sm text-emerald-600">✅ 暂无需要我处理的审批</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {c.A.groups.map((g) => (
                <Link key={g.key} href="/admin/pending-approvals" className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs hover:border-indigo-300 hover:bg-indigo-50">
                  {g.label} <b className="text-indigo-600">{g.count}</b>
                </Link>
              ))}
              {c.A.groups.length === 0 && <span className="text-xs text-gray-400">无待批(下方为监控提示)</span>}
            </div>
            {c.A.suspiciousDelays.length > 0 && (
              <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-2">
                <div className="text-[11px] font-semibold text-amber-700 mb-1">⚠️ 可疑延期(大额/同单反复,建议我看一眼)</div>
                <ul className="space-y-0.5 text-xs text-gray-700">
                  {c.A.suspiciousDelays.map((d, i) => <li key={i}><Link href={`/orders/${d.orderId}`} className="hover:underline"><b className="text-indigo-700">{d.orderNo}</b> · {d.customer} — {d.reason} ›</Link></li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>

      {/* B 五部门 —— 点「逾期 N」展开看具体订单 */}
      <Card title="B · 五部门工作与异常" hint="点「逾期 N」看具体订单 · 红=逾期 橙=卡住">
        <CeoDeptBoard depts={c.B} />
      </Card>

      {/* C 新增情况 */}
      <Card title="C · 新增情况" hint="订单 / 打样 / 工厂 / 供应商">
        <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
          <Stat n={c.C.newOrders7d} label="近7天新单" tone="indigo" href="/orders" />
          <Stat n={c.C.newOrders30d} label="近30天新单" href="/orders" />
          <Stat n={c.C.sampleActive} label="打样进行中" tone="amber" href="/orders" />
          <Stat n={c.C.completed7d} label="近30天完成" tone="green" />
          <Stat n={c.C.newSuppliers7d} label="近7天新供应商" href="/suppliers" />
          <Stat n={c.C.newFactories7d} label="近7天新工厂" />
        </div>
        {c.C.recent.length > 0 && (
          <ul className="mt-2 divide-y divide-gray-100 text-xs">
            {c.C.recent.map((o, i) => (
              <li key={i}><Link href={`/orders/${o.orderId}`} className="flex justify-between py-1 text-gray-600 hover:bg-gray-50 rounded px-1"><span><b className="text-indigo-700">{o.orderNo}</b> · {o.customer}{o.purpose !== 'production' ? ` · ${o.purpose === 'sample' ? '打样' : o.purpose === 'trade' ? '经销' : o.purpose}` : ''}</span><span className="text-gray-400">{o.at} ›</span></Link></li>
            ))}
          </ul>
        )}
      </Card>

      {/* D 需关注客户/订单 */}
      <Card title="D · 需我关注的客户 / 订单">
        {c.D.matters.length === 0 && c.D.stuck.length === 0 ? (
          <p className="text-sm text-emerald-600">✅ 暂无需要特别关注的客户/订单</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold text-gray-500 mb-1">客户事项</div>
              {c.D.matters.length === 0 ? <p className="text-xs text-gray-400">无</p> : (
                <ul className="space-y-1 text-xs">
                  {c.D.matters.map((m, i) => {
                    const body = (<><span className={`shrink-0 rounded px-1 text-[10px] ${m.severity === 'high' || m.severity === '高' ? 'bg-rose-100 text-rose-700' : 'bg-gray-100 text-gray-600'}`}>{m.customer || '客户'}</span><span className="text-gray-700">{m.title}{m.orderNo ? ` · ${m.orderNo}` : ''}{m.orderId ? ' ›' : ''}</span></>);
                    return <li key={i} className="flex items-start gap-1.5">{m.orderId ? <Link href={`/orders/${m.orderId}`} className="flex items-start gap-1.5 hover:bg-gray-50 rounded px-0.5">{body}</Link> : body}</li>;
                  })}
                </ul>
              )}
            </div>
            <div>
              <div className="text-[11px] font-semibold text-gray-500 mb-1">卡住订单</div>
              {c.D.stuck.length === 0 ? <p className="text-xs text-gray-400">无</p> : (
                <ul className="space-y-1 text-xs">
                  {c.D.stuck.map((s, i) => (
                    <li key={i}><Link href={`/orders/${s.orderId}`} className="block text-gray-700 hover:bg-gray-50 rounded px-0.5"><b className="text-indigo-700">{s.orderNo}</b> · {s.customer} — {s.node}{s.days > 0 ? ` (卡 ${s.days} 天)` : ''} ›</Link></li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* E 员工工作报告 */}
      <Card title="E · 各部门员工工作报告" hint="逾期优先 · 近30天产出">
        {c.E.length === 0 ? <p className="text-sm text-gray-400">暂无员工在办节点</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-400"><th className="py-1 pr-3">员工</th><th className="pr-3">部门</th><th className="pr-3 text-center">在办</th><th className="pr-3 text-center">逾期</th><th className="pr-3 text-center">近30天完成</th><th className="text-center">按时率</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {c.E.map((e, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 font-medium text-gray-800">{e.name}</td>
                    <td className="pr-3 text-gray-500">{e.deptLabel}</td>
                    <td className="pr-3 text-center">{e.active}</td>
                    <td className={`pr-3 text-center ${e.overdue > 0 ? 'font-semibold text-rose-600' : 'text-gray-400'}`}>{e.overdue || '—'}</td>
                    <td className="pr-3 text-center text-emerald-600">{e.done30d || '—'}</td>
                    <td className={`text-center ${e.onTimePct != null && e.onTimePct < 60 ? 'text-rose-600' : 'text-gray-600'}`}>{e.onTimePct != null ? `${e.onTimePct}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
