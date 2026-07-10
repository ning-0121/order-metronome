'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  transitionProcurementLine,
  chaseProcurementLine,
  updateProcurementLineFields,
  recordGoodsReceipt,
  recordReceiptBatch,
  listReceiptBatches,
  type QueueLine,
} from '@/app/actions/procurement';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { useDialogs } from '@/components/ui/useDialogs';

const LAMP: Record<string, string> = {
  red: 'bg-red-500', yellow: 'bg-yellow-400', green: 'bg-emerald-500',
};
const CAT: Record<string, string> = {
  fabric: '面料', trim: '辅料', packing: '包装', print: '印花', other: '其他',
};
const STATUS_LABEL: Record<string, string> = {
  pending_order: '待下单', ordered: '已下单', confirmed: '已确认',
  in_production: '生产中', ready_to_ship: '已完成待送货', shipped: '已发货在途', arrived: '已送达',
};

function fmt(d: string | null) { return d ? d.slice(0, 10) : '—'; }

/** 未到货数量 = 订购 − 已收(负数钳 0);无订购量返回 null 不显示 */
function outstanding(l: QueueLine): number | null {
  const o = Number(l.ordered_qty);
  if (!o) return null;
  return Math.max(0, Math.round((o - (Number(l.received_qty) || 0)) * 1000) / 1000);
}

function LampDot({ lamp }: { lamp: string | null }) {
  if (!lamp) return <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-200" title="无截止/不监控" />;
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${LAMP[lamp]}`} title={lamp} />;
}

function RowShell({ line, sizes, children }: { line: QueueLine; sizes?: string[]; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 py-2 px-3 hover:bg-gray-50">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <LampDot lamp={line.lamp} />
          <span className="font-medium text-gray-900 truncate">{line.material_name}</span>
          {line.color && <span className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 shrink-0">{line.color}</span>}
          {sizes && sizes.length > 1
            ? <span className="text-xs px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 shrink-0" title={`该料多个尺码合并显示:${sizes.join('·')}`}>{sizes.length}个尺码</span>
            : (line as any).size && <span className="text-xs px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 shrink-0" title="尺码(N1 按码拆行)">{(line as any).size}码</span>}
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{CAT[line.category || 'other'] || line.category}</span>
          {/* 已归到采购单的行 → 主链接进"单张采购单"(按供应商/颜色,同供应商多色即合并单,正是用户要的"单个采购单的样子");
              未归单的行 → 进核料页(整单核料+任务单下载)。2026-07-06 用户反馈:点了总看到总订单,要能点进单张采购单。 */}
          <Link href={line.purchase_order_id ? `/procurement/po/${line.purchase_order_id}` : `/procurement/verify/${line.order_id}`}
            className="text-xs text-indigo-600 hover:underline shrink-0"
            title={line.purchase_order_id ? '打开这张采购单(按供应商/颜色)' : '打开核料页'}>
            {line.internal_order_no ? `${line.internal_order_no} | ` : ''}{line.order_no}·{line.customer_name}
          </Link>
          {/* 核料页:带 procurement_item_id 时聚焦到这一款料(2026-07-09 用户:点单料别看到整单);无 id 兜底进整单核料页 */}
          <Link href={line.procurement_item_id ? `/procurement/verify/${line.order_id}?item=${line.procurement_item_id}` : `/procurement/verify/${line.order_id}`}
            className="text-xs text-gray-400 hover:text-indigo-600 shrink-0"
            title={line.procurement_item_id ? `只看「${line.material_name}」这一款料的核料明细(可切换查看全部)` : '打开核料页,右上可下载生产任务单'}>
            📋任务单
          </Link>
          {/* 每行点开对应的采购单详情(供应商/合计/明细/状态)——该行已挂到某采购单时显示 */}
          {line.purchase_order_id && (
            <Link href={`/procurement/po/${line.purchase_order_id}`} className="text-xs text-emerald-600 hover:underline shrink-0" title="查看该行所在的采购单">
              🧾{line.po_no || '采购单'}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{children}</div>
      </div>
    </div>
  );
}

/** 队列行按 采购单+物料+颜色+状态 合并(2026-07-08 用户:同料多尺码太乱)。
 *  历史按码拆的执行行在此合并显示,催货/推进对该组所有行一起操作;收货仍逐行(数量按码)。 */
type QueueGroup = { key: string; rep: QueueLine; ids: string[]; lines: QueueLine[]; sizes: string[]; totalOrdered: number; lamp: string | null };
function groupQueue(lines: QueueLine[]): QueueGroup[] {
  const m = new Map<string, QueueGroup>();
  for (const l of lines) {
    const key = `${(l as any).purchase_order_id || ''}¦${l.material_name || ''}¦${l.color || ''}¦${l.line_status}`;
    let g = m.get(key);
    if (!g) { g = { key, rep: l, ids: [], lines: [], sizes: [], totalOrdered: 0, lamp: null }; m.set(key, g); }
    g.ids.push(l.id);
    g.lines.push(l);
    const sz = (l as any).size; if (sz && !g.sizes.includes(String(sz))) g.sizes.push(String(sz));
    g.totalOrdered += Number((l as any).ordered_qty) || 0;
    if (l.lamp === 'red') g.lamp = 'red';
    else if (l.lamp === 'yellow' && g.lamp !== 'red') g.lamp = 'yellow';
    else if (!g.lamp) g.lamp = l.lamp ?? null;
  }
  return [...m.values()];
}

/** 内控:该行所在采购单尚未下单(草稿/待审批/驳回)—— 不给验收/催货/推进按钮,引导先去审批下单。
 *  服务端亦已硬闸(recordReceipt/recordGoodsReceipt/transitionProcurementLine),此处只是把 UI 对齐,不误导。 */
function BlockedPoNote({ l }: { l: QueueLine }) {
  return (
    <>
      <span className="text-xs px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200 font-medium">⚠ 采购单未下单/待审批,不能操作</span>
      {l.purchase_order_id && (
        <Link href={`/procurement/po/${l.purchase_order_id}`}
          className="text-xs px-2 py-1 rounded font-medium bg-orange-500 text-white hover:bg-orange-600">去审批 →</Link>
      )}
    </>
  );
}

export function ProcurementQueueClient({
  pendingRequests = [], pendingOrder: pendingOrder0, chase: chase0, readyShip: readyShip0, receive: receive0,
  counts, banner, canFinanceOver = false,
}: {
  pendingRequests?: Array<{ order_id: string; order_no: string | null; internal_order_no?: string | null; customer_name: string | null; submitted_at: string | null; req_count: number; late_count: number }>;
  pendingOrder: QueueLine[]; chase: QueueLine[]; readyShip: QueueLine[]; receive: QueueLine[];
  counts: { pendingRequests: number; pendingOrder: number; chase: number; readyShip: number; receive: number; overdueOrders: number; atRiskOrders: number };
  banner?: React.ReactNode;
  canFinanceOver?: boolean;
}) {
  const router = useRouter();
  const { confirm, prompt, dialog } = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<string | null>(null); // `${rowId}:${kind}`
  const [err, setErr] = useState('');
  const [expandRecv, setExpandRecv] = useState<Set<string>>(new Set()); // 待验收:同料多尺码合并行的展开态(按 group key)

  // 队列本地镜像:操作成功后即时移动行 + 更新头部计数,不必等整页 router.refresh()
  // (2026-07-09 用户:点「工厂已完成」料还留在待催货、上方数字要手动刷新才一起跳过去)。
  const [q, setQ] = useState({ pendingOrder: pendingOrder0, chase: chase0, readyShip: readyShip0, receive: receive0 });
  // 服务端新数据到达(router.refresh 后 props 换新引用)→ 以服务端真相覆盖本地乐观态,二者对齐
  useEffect(() => {
    setQ({ pendingOrder: pendingOrder0, chase: chase0, readyShip: readyShip0, receive: receive0 });
  }, [pendingOrder0, chase0, readyShip0, receive0]);
  const { pendingOrder, chase, readyShip, receive } = q;

  // 状态 → 所属队列(与服务端 getProcurementQueues 分桶口径一致);离队状态(取消/已验收等)返回 null
  function bucketOf(status: string): 'pendingOrder' | 'chase' | 'readyShip' | 'receive' | null {
    if (status === 'pending_order') return 'pendingOrder';
    if (['ordered', 'confirmed', 'in_production'].includes(status)) return 'chase';
    if (['ready_to_ship', 'shipped'].includes(status)) return 'readyShip';
    if (status === 'arrived') return 'receive';
    return null;
  }
  // 乐观移动:把这些行从当前所在队列取出、置为新状态、按 bucketOf 重新归队(null=离队删除)
  function moveLines(ids: string[], to: string) {
    const idSet = new Set(ids);
    setQ(prev => {
      const all = [...prev.pendingOrder, ...prev.chase, ...prev.readyShip, ...prev.receive];
      const moved = all.filter(l => idSet.has(l.id)).map(l => ({ ...l, line_status: to }));
      const keep = (arr: QueueLine[]) => arr.filter(l => !idSet.has(l.id));
      const next = { pendingOrder: keep(prev.pendingOrder), chase: keep(prev.chase), readyShip: keep(prev.readyShip), receive: keep(prev.receive) };
      const b = bucketOf(to);
      if (b) next[b] = [...next[b], ...moved];
      return next;
    });
  }
  // 乐观离队(收货收齐等已确定离开队列的操作)
  function dropLines(ids: string[]) {
    const idSet = new Set(ids);
    setQ(prev => ({
      pendingOrder: prev.pendingOrder.filter(l => !idSet.has(l.id)),
      chase: prev.chase.filter(l => !idSet.has(l.id)),
      readyShip: prev.readyShip.filter(l => !idSet.has(l.id)),
      receive: prev.receive.filter(l => !idSet.has(l.id)),
    }));
  }

  async function run(key: string, fn: () => Promise<{ error?: string }>, onSuccess?: () => void) {
    setBusy(key); setErr('');
    const r = await fn();
    setBusy(null);
    if (r?.error) { setErr(r.error); return false; }
    onSuccess?.();                       // 先本地即时反映,再拉服务端对齐
    setOpenForm(null); router.refresh(); return true;
  }
  // 组操作:对该组所有行(各尺码)依次执行,汇总首个错误
  async function runGroup(key: string, ids: string[], fn: (id: string) => Promise<{ error?: string }>, onSuccess?: () => void) {
    setBusy(key); setErr('');
    let firstErr: string | undefined;
    for (const id of ids) { const r = await fn(id); if (r?.error && !firstErr) firstErr = r.error; }
    setBusy(null);
    if (firstErr) { setErr(firstErr); return false; }
    onSuccess?.();                       // 先本地即时反映,再拉服务端对齐
    setOpenForm(null); router.refresh(); return true;
  }

  const btn = 'text-xs px-2 py-1 rounded font-medium disabled:opacity-50';

  // 2026-07-03 用户拍板:状态推进全部二次确认;点错可「↩回退」上一状态(留痕)
  async function confirmRun(l: QueueLine, key: string, to: string, text: string) {
    if (!(await confirm({ title: '确认操作?', message: text, confirmText: '确认' }))) return;
    run(`${l.id}:${key}`, () => transitionProcurementLine(l.id, to as any), () => moveLines([l.id], to));
  }
  async function confirmRunGroup(g: QueueGroup, key: string, to: string, text: string) {
    if (!(await confirm({ title: '确认操作?', message: text, confirmText: '确认' }))) return;
    runGroup(`${g.key}:${key}`, g.ids, (id) => transitionProcurementLine(id, to as any), () => moveLines(g.ids, to));
  }
  const BACK_ONE: Record<string, string> = {
    confirmed: 'ordered', in_production: 'confirmed',
    ready_to_ship: 'in_production', shipped: 'ready_to_ship', arrived: 'shipped',
  };
  function GroupBackButton({ g }: { g: QueueGroup }) {
    const backTo = BACK_ONE[g.rep.line_status];
    if (!backTo) return null;
    return (
      <button className={`${btn} border border-gray-200 text-gray-400 hover:text-red-500`}
        title="点错了?退回上一状态(操作留痕)" disabled={busy === `${g.key}:back`}
        onClick={async () => {
          if (!(await confirm({ title: '退回上一状态?', message: `把「${g.rep.material_name}」从「${STATUS_LABEL[g.rep.line_status] || g.rep.line_status}」退回「${STATUS_LABEL[backTo] || backTo}」\n(误点纠正,操作会留痕)`, danger: true, confirmText: '回退' }))) return;
          runGroup(`${g.key}:back`, g.ids, (id) => transitionProcurementLine(id, backTo as any, { note: '误点回退' }), () => moveLines(g.ids, backTo));
        }}>↩ 回退</button>
    );
  }
  function BackButton({ l }: { l: QueueLine }) {
    const backTo = BACK_ONE[l.line_status];
    if (!backTo) return null;
    return (
      <button className={`${btn} border border-gray-200 text-gray-400 hover:text-red-500`}
        title="点错了?退回上一状态(操作留痕)" disabled={busy === `${l.id}:back`}
        onClick={async () => {
          if (!(await confirm({ title: '退回上一状态?', message: `把「${l.material_name}」从「${STATUS_LABEL[l.line_status] || l.line_status}」退回「${STATUS_LABEL[backTo] || backTo}」\n(误点纠正,操作会留痕)`, danger: true, confirmText: '回退' }))) return;
          run(`${l.id}:back`, () => transitionProcurementLine(l.id, backTo as any, { note: '误点回退' }), () => moveLines([l.id], backTo));
        }}>↩ 回退</button>
    );
  }

  // 分组行(同料多尺码合并显示)——计数用分组数,和实际看到的行数一致(2026-07-09 用户:计数对不上)
  const chaseGroups = groupQueue(chase);
  const readyShipGroups = groupQueue(readyShip);
  // 待验收也合并(2026-07-09 用户:水洗标同料 3 个尺码显示成 3 行,看着像重复采购)——归总一条,展开逐码收货
  const receiveGroups = groupQueue(receive);

  // 单行待验收块(RowShell + 收货登记/验收判定/回退表单)—— 合并组展开后逐码复用同一块,逻辑不变
  const receiveLineBlock = (l: QueueLine): React.ReactNode => (
    <div key={l.id}>
      <RowShell line={l}>
        <span className="text-xs text-gray-400">
          订购 {l.ordered_qty ?? '—'} {l.ordered_unit}{l.received_qty ? ` · 已收 ${l.received_qty}` : ''}
          {outstanding(l) != null && <> · <b className={outstanding(l)! > 0 ? 'text-amber-600' : 'text-emerald-600'}>未到 {outstanding(l)}</b></>}
        </span>
        {l.po_not_placed ? <BlockedPoNote l={l} /> : (
          <>
            <button className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}
              onClick={() => setOpenForm(openForm === `${l.id}:reg` ? null : `${l.id}:reg`)}>📥 收货登记</button>
            <button className={`${btn} bg-white text-gray-600 border border-gray-300 hover:bg-gray-50`}
              onClick={() => setOpenForm(openForm === `${l.id}:recv` ? null : `${l.id}:recv`)}>验收判定</button>
            <BackButton l={l} />
          </>
        )}
      </RowShell>
      {!l.po_not_placed && openForm === `${l.id}:reg` && (
        <ReceiptRegisterForm line={l} canFinanceOver={canFinanceOver} onDone={() => { setOpenForm(null); dropLines([l.id]); router.refresh(); }} />
      )}
      {!l.po_not_placed && openForm === `${l.id}:recv` && (
        <ReceiveForm line={l} busy={!!busy && busy.startsWith(`${l.id}:recv`)}
          onSubmit={(p) => run(`${l.id}:recv:${p.result}`, () => recordGoodsReceipt(l.id, p))} />
      )}
    </div>
  );

  // 今日先处理(2026-07-05 简化:按优先级列出有活的队列,新人一眼知道从哪下手)
  const todo = [
    { label: '待采购订单(去核料下单)', n: pendingRequests.length, href: '#q-pendingRequests' },
    { label: '待验收', n: receiveGroups.length, href: '#q-receive' },
    { label: '待催货', n: chaseGroups.length, href: '#q-chase' },
    { label: '已完成待送货', n: readyShipGroups.length, href: '#q-readyShip' },
    { label: '待下单(去归采购单)', n: pendingOrder.length, href: '#q-pendingOrder' },
  ].filter(t => t.n > 0);

  // 头部计数:队列数从本地镜像即时算,风险数(逾期/需抓紧追)是订单级派生,沿用服务端值(下次刷新对齐)
  const Stat = ({ label, value, tone, href }: { label: string; value: number; tone: string; href: string }) => (
    <a href={href} className={`block rounded-xl border px-4 py-3 transition hover:shadow-md hover:-translate-y-0.5 ${tone}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-0.5 opacity-80">{label}</div>
    </a>
  );

  return (
    <div className="space-y-3">
      {/* Dashboard 壳:计数(本地即时) */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-3 mb-3">
        <Stat label="📨 待采购订单" value={pendingRequests.length} href="#q-pendingRequests" tone="border-emerald-300 bg-emerald-50 text-emerald-800" />
        <Stat label="待下单" value={pendingOrder.length} href="#q-pendingOrder" tone="border-indigo-200 bg-indigo-50 text-indigo-800" />
        <Stat label="待催货 / 生产中" value={chaseGroups.length} href="#q-chase" tone="border-amber-200 bg-amber-50 text-amber-800" />
        <Stat label="已完成待送货" value={readyShipGroups.length} href="#q-readyShip" tone="border-sky-200 bg-sky-50 text-sky-800" />
        <Stat label="已送达待验收" value={receiveGroups.length} href="#q-receive" tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
        <Stat label="🔴 到货逾期" value={counts.overdueOrders} href="#q-chase" tone="border-red-200 bg-red-50 text-red-800" />
        <Stat label="⚠️ 需抓紧追" value={counts.atRiskOrders} href="#q-chase" tone="border-rose-200 bg-rose-50 text-rose-800" />
      </div>

      {banner}

      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}

      {/* 今日先处理:一眼知道从哪下手 */}
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-2.5 flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-emerald-800">👉 今天先处理</span>
        {todo.length === 0
          ? <span className="text-xs text-gray-500">采购队列都清空了 · 只看下方风险中心即可</span>
          : todo.map(t => (
            <a key={t.href} href={t.href} className="text-xs px-2.5 py-1 rounded-full bg-white border border-emerald-200 text-emerald-700 font-medium hover:bg-emerald-100">
              {t.label} <b>{t.n}</b>
            </a>
          ))}
      </div>

      {/* ── 待采购订单(业务执行提交采购申请 → 采购从这里接活;完成「采购下单」节点后自动消失)── */}
      <section id="q-pendingRequests" className="scroll-mt-4 bg-white rounded-xl border-2 border-emerald-200 overflow-hidden">
        <div className="bg-emerald-50 px-4 py-2.5 border-b border-emerald-100 font-bold text-emerald-900 text-sm">
          📨 待采购订单（{pendingRequests.length}）<span className="font-normal text-emerald-700">— 业务执行已提交采购申请</span>
        </div>
        {pendingRequests.length === 0 ? <Empty /> : pendingRequests.map(o => (
          <Link key={o.order_id} href={`/procurement/verify/${o.order_id}`}
            className="flex items-center gap-3 px-4 py-3 border-b border-gray-50 hover:bg-emerald-50/50">
            {o.late_count > 0
              ? <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" title={`${o.late_count} 项已过最晚下单日`} />
              : <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" />}
            <span className="text-sm font-semibold text-gray-900">{o.internal_order_no ? `${o.internal_order_no} | ` : ''}{o.order_no || '—'}</span>
            <span className="text-sm text-gray-600">{o.customer_name || ''}</span>
            <span className="text-xs text-gray-400">{o.req_count} 项物料需求 · 提交于 {fmt(o.submitted_at)}</span>
            {o.late_count > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">🔥 {o.late_count} 项超最晚下单日</span>}
            <span className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium">去核料下单 →</span>
          </Link>
        ))}
      </section>

      {/* ── 待下单(2026-07-04 用户拍板:下单只走采购单——归采购单→审批闸→强制凭证。
             这里不再逐行快速下单,改引导去待采购工作台归单;仅保留「取消」用于剔除不该采的行)── */}
      <section id="q-pendingOrder" className="scroll-mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-indigo-50 px-4 py-2.5 border-b border-indigo-100 font-bold text-indigo-900 text-sm flex items-center gap-2">
          📝 待下单（{pendingOrder.length}）
          {pendingOrder.length > 0 && (
            <Link href="/procurement/netting" className="ml-auto text-xs px-3 py-1 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">
              🧩 去归采购单下单 →
            </Link>
          )}
        </div>
        {pendingOrder.length === 0 ? <Empty /> : (
          <>
            <p className="px-4 pt-2 text-[11px] text-gray-500">这些料还没归到采购单。下单请到「待采购工作台」归成采购单 → 审批 → 强制传凭证下单(不再逐行下单)。</p>
            {pendingOrder.map(l => (
              <RowShell key={l.id} line={l}>
                <span className="text-xs text-gray-400">需到 {fmt(l.required_by)} · {l.ordered_qty ?? '—'} {l.ordered_unit}</span>
                <button className={`${btn} border border-indigo-200 text-indigo-600 hover:bg-indigo-50`} disabled={busy === `${l.id}:edit`}
                  title="改尺码 / 数量 / 规格(仅未归采购单可改)"
                  onClick={async () => {
                    const SIZES = ['', 'XXS', 'XS', 'S', 'M', 'L', 'XL', '1XL', '2XL', '3XL', '4XL', '5XL'];
                    const v = await prompt({
                      title: `改采购行「${l.material_name}」`,
                      fields: [
                        { name: 'size', label: '尺码', type: 'select', options: SIZES.map(s => ({ value: s, label: s || '(不分码)' })), defaultValue: (l as any).size || '' },
                        { name: 'ordered_qty', label: '数量', type: 'number', defaultValue: String(l.ordered_qty ?? '') },
                        { name: 'specification', label: '规格(如 40*30)', type: 'text', defaultValue: (l as any).specification || '' },
                      ],
                      confirmText: '保存',
                    });
                    if (v) run(`${l.id}:edit`, () => updateProcurementLineFields(l.id, { size: v.size, ordered_qty: v.ordered_qty ? Number(v.ordered_qty) : undefined, specification: v.specification }));
                  }}>✏️ 改</button>
                <button className={`${btn} border border-gray-200 text-gray-500`} disabled={busy === `${l.id}:cancel`}
                  onClick={async () => { const v = await prompt({ title: '取消该采购行', fields: [{ name: 'reason', label: '取消理由', type: 'textarea', required: true }], confirmText: '确认取消', }); if (v) run(`${l.id}:cancel`, () => transitionProcurementLine(l.id, 'cancelled', { note: v.reason }), () => dropLines([l.id])); }}>取消</button>
              </RowShell>
            ))}
          </>
        )}
      </section>

      {/* ── 待催货(生产中) ── */}
      <section id="q-chase" className="scroll-mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-amber-50 px-4 py-2.5 border-b border-amber-100 font-bold text-amber-900 text-sm">
          🔔 待催货 / 生产中（{chaseGroups.length}）
        </div>
        {chaseGroups.length === 0 ? <Empty /> : chaseGroups.map(g => {
          const l = { ...g.rep, lamp: g.lamp } as QueueLine;
          const multi = g.sizes.length > 1;
          return (
          <RowShell key={g.key} line={l} sizes={g.sizes}>
            <span className="text-xs text-gray-400">
              {STATUS_LABEL[l.line_status]} · 预计 {fmt(l.expected_arrival || l.promised_date)}
              {multi && <span className="ml-1">· 合计 {g.totalOrdered} {(l as any).ordered_unit || ''}</span>}
              {(l.chase_count ?? 0) > 0 && <span className="text-amber-600 ml-1">催{l.chase_count}次</span>}
            </span>
            {l.po_not_placed ? <BlockedPoNote l={l} /> : (<>
              <button className={`${btn} bg-amber-500 text-white hover:bg-amber-600`} disabled={busy === `${g.key}:chase`}
                onClick={async () => { const v = await prompt({ title: `催货「${l.material_name}」${multi ? `(${g.sizes.length}个尺码一起)` : ''}`, message: `已催 ${l.chase_count ?? 0} 次`, fields: [{ name: 'note', label: '催货备注(可选)', type: 'textarea' }], confirmText: '记一次催货', }); if (v) runGroup(`${g.key}:chase`, g.ids, (id) => chaseProcurementLine(id, v.note || undefined)); }}>催货</button>
              {l.line_status === 'ordered' && (
                <button className={`${btn} border border-gray-200 text-gray-600`} disabled={busy === `${g.key}:conf`}
                  onClick={() => confirmRunGroup(g, 'conf', 'confirmed', `确认「${l.material_name}」供应商已接单/确认交期?${multi ? `(${g.sizes.length}个尺码)` : ''}`)}>确认</button>
              )}
              <button className={`${btn} bg-sky-600 text-white hover:bg-sky-700`} disabled={busy === `${g.key}:rts`}
                onClick={() => confirmRunGroup(g, 'rts', 'ready_to_ship', `确定「${l.material_name}」工厂已完成、进入待送货?${multi ? `(${g.sizes.length}个尺码一起)` : ''}\n(点错可用「↩回退」退回)`)}>✅ 工厂已完成</button>
              <button className={`${btn} border border-gray-200 text-gray-600`} disabled={busy === `${g.key}:ship`}
                onClick={() => confirmRunGroup(g, 'ship', 'shipped', `确定「${l.material_name}」已直接发货(跳过待送货)?${multi ? `(${g.sizes.length}个尺码)` : ''}`)}>直接发货</button>
              <GroupBackButton g={g} />
            </>)}
          </RowShell>
          );
        })}
      </section>

      {/* ── 已完成待送货 / 在途 ── */}
      <section id="q-readyShip" className="scroll-mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-sky-50 px-4 py-2.5 border-b border-sky-100 font-bold text-sky-900 text-sm">
          🚚 已完成待送货 / 在途（{readyShipGroups.length}）
        </div>
        {readyShipGroups.length === 0 ? <Empty /> : readyShipGroups.map(g => {
          const l = { ...g.rep, lamp: g.lamp } as QueueLine;
          const multi = g.sizes.length > 1;
          const out = multi ? g.totalOrdered : outstanding(l);
          return (
            <RowShell key={g.key} line={l} sizes={g.sizes}>
              <span className="text-xs text-gray-400">
                {STATUS_LABEL[l.line_status]} · 预计 {fmt(l.expected_arrival || l.promised_date)}
                {out != null && <> · <b className={out > 0 ? 'text-amber-600' : 'text-emerald-600'}>未到 {out}</b> {l.ordered_unit}</>}
              </span>
              {l.po_not_placed ? <BlockedPoNote l={l} /> : (<>
                {l.line_status === 'ready_to_ship' && (
                  <button className={`${btn} bg-sky-600 text-white hover:bg-sky-700`} disabled={busy === `${g.key}:ship`}
                    onClick={() => confirmRunGroup(g, 'ship', 'shipped', `确定「${l.material_name}」供应商已发货?${multi ? `(${g.sizes.length}个尺码)` : ''}`)}>🚚 已发货</button>
                )}
                {l.line_status === 'shipped' && (
                  <button className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`} disabled={busy === `${g.key}:arr`}
                    onClick={() => confirmRunGroup(g, 'arr', 'arrived', `确定「${l.material_name}」货已送达工厂/仓库?${multi ? `(${g.sizes.length}个尺码)` : ''}\n送达后进入待验收。`)}>📦 已送达</button>
                )}
                <GroupBackButton g={g} />
              </>)}
            </RowShell>
          );
        })}
      </section>

      {/* ── 已送达待验收 ── */}
      <section id="q-receive" className="scroll-mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-emerald-50 px-4 py-2.5 border-b border-emerald-100 font-bold text-emerald-900 text-sm">
          ✅ 已送达待验收（{receiveGroups.length}）
        </div>
        {receiveGroups.length === 0 ? <Empty /> : receiveGroups.map(g => {
          // 单尺码/未拆码 → 原样单行;同料多尺码 → 归总一条,展开逐码收货(收货数量按码,故不在合并行直接收)
          if (g.ids.length <= 1) return receiveLineBlock(g.rep);
          const totalOut = g.lines.reduce((s, x) => s + (outstanding(x) || 0), 0);
          const open = expandRecv.has(g.key);
          return (
            <div key={g.key}>
              <RowShell line={g.rep} sizes={g.sizes}>
                <span className="text-xs text-gray-400">
                  订购 {g.totalOrdered} {g.rep.ordered_unit} · <b className={totalOut > 0 ? 'text-amber-600' : 'text-emerald-600'}>未到 {totalOut}</b>
                </span>
                {g.rep.po_not_placed ? <BlockedPoNote l={g.rep} /> : (
                  <>
                    {/* 三码一起到 → 一键把各尺码按订购量登记收齐(离队);逐码不同量的走「展开逐码收货」 */}
                    <button className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`} disabled={busy === `${g.key}:recvall` || totalOut <= 0}
                      title="全部尺码按订购量登记为已收齐(数量一致时用;有短缺/让步请展开逐码收)"
                      onClick={async () => {
                        if (!(await confirm({ title: '一键全部收齐?', message: `「${g.rep.material_name}」全部 ${g.sizes.length} 个尺码按订购量登记为已收齐(合计 ${g.totalOrdered} ${g.rep.ordered_unit || ''}),之后离开待验收。\n有短缺/让步/拒收的,请改用「展开逐码收货」。`, confirmText: '全部收齐' }))) return;
                        runGroup(`${g.key}:recvall`, g.ids, (id) => {
                          const line = g.lines.find(x => x.id === id)!;
                          const out = outstanding(line);
                          if (out == null || out <= 0) return Promise.resolve({});   // 该码已收满 → 跳过,避免超收
                          return recordReceiptBatch(id, { received_qty: out, mark_complete: true });
                        }, () => dropLines(g.ids));
                      }}>✅ 全部收齐</button>
                    <button className={`${btn} bg-white text-indigo-600 border border-indigo-200 hover:bg-indigo-50`}
                      onClick={() => setExpandRecv(s => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
                      title="同一款料按尺码拆的执行行合并显示;展开后逐个尺码收货登记/验收(收货数量按码)">
                      {open ? '收起尺码' : `展开 ${g.sizes.length} 个尺码 · 逐码收货`}
                    </button>
                  </>
                )}
              </RowShell>
              {open && <div className="bg-teal-50/30 border-l-2 border-teal-200">{g.lines.map(receiveLineBlock)}</div>}
            </div>
          );
        })}
      </section>
      {/* 对话框宿主:confirm/prompt(工厂已完成/确认/取消等)全靠它渲染。
          复审误删过一次(把它当成 ReceiptRegisterForm 的越界引用),导致按钮点不了 → 已恢复。 */}
      {dialog}
    </div>
  );
}

// 空队列压扁(2026-07-05 简化:不再占大块"暂无",一条细线,让有活的队列突出)
function Empty() { return <div className="px-4 py-1.5 text-xs text-gray-300">— 暂无</div>; }

// OrderForm(逐行快速下单)已废除(2026-07-04):下单只走采购单(归并→审批→强制凭证)。

function ReceiveForm({ line, busy, onSubmit }: {
  line: QueueLine; busy: boolean;
  onSubmit: (p: { received_qty: number; result: 'pass' | 'concession' | 'reject'; defect_notes?: string }) => void;
}) {
  const [qty, setQty] = useState(line.ordered_qty?.toString() || '');
  const [defect, setDefect] = useState('');
  const [vErr, setVErr] = useState('');
  const submit = (result: 'pass' | 'concession' | 'reject') => {
    const q = parseFloat(qty);
    if (!(q >= 0)) { setVErr('请填实收数量'); return; }
    // 让步/拒收必须填缺陷说明(修 P3 2026-07-09:此前文案说必填却无校验,审计留痕缺失)
    if ((result === 'concession' || result === 'reject') && !defect.trim()) {
      setVErr(`${result === 'concession' ? '让步' : '拒收'}必须填写缺陷说明(留痕、供追责/退货)`); return;
    }
    setVErr('');
    onSubmit({ received_qty: q, result, defect_notes: defect.trim() || undefined });
  };
  return (
    <div className="bg-emerald-50/50 px-3 py-3 flex flex-wrap items-center gap-2 border-b border-gray-100">
      <input className="rounded border border-gray-300 px-2 py-1 text-xs w-28" placeholder={`实收(${line.ordered_unit || ''})`} type="number" step="0.01" value={qty} onChange={e => setQty(e.target.value)} />
      <input className="rounded border border-gray-300 px-2 py-1 text-xs flex-1 min-w-[160px]" placeholder="缺陷说明（让步/拒收必填）" value={defect} onChange={e => { setDefect(e.target.value); if (vErr) setVErr(''); }} />
      <button disabled={busy} className="text-xs px-2 py-1 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50" onClick={() => submit('pass')}>通过</button>
      <button disabled={busy} className="text-xs px-2 py-1 rounded bg-amber-500 text-white font-medium hover:bg-amber-600 disabled:opacity-50" onClick={() => submit('concession')} title="需采购经理/管理员">让步</button>
      <button disabled={busy} className="text-xs px-2 py-1 rounded bg-red-500 text-white font-medium hover:bg-red-600 disabled:opacity-50" onClick={() => submit('reject')}>拒收</button>
      {vErr && <span className="text-xs text-red-600 w-full">{vErr}</span>}
    </div>
  );
}

/** 收货登记(分批次 + 码单上传 + 累计汇总)。仓库把实收数据交采购,采购在此逐批录入。 */
function ReceiptRegisterForm({ line, onDone, canFinanceOver = false }: { line: QueueLine; onDone: () => void; canFinanceOver?: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [complete, setComplete] = useState(false);
  const [allowOver, setAllowOver] = useState(false);   // 财务超收放行
  const [slipPaths, setSlipPaths] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const reload = () => listReceiptBatches(line.id).then(r => { setBatches((r as any).data || []); setLoading(false); });
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [line.id]);

  const received = batches.reduce((s, b) => s + (Number(b.received_qty) || 0), 0);
  const ordered = Number(line.ordered_qty) || 0;

  async function uploadSlips(files: FileList) {
    setUploading(true); setErr('');
    try {
      const supabase = createBrowserClient();
      const paths: string[] = [];
      for (const f of Array.from(files)) {
        const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `receipts/${line.order_id}/${line.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const { error } = await supabase.storage.from('order-docs').upload(path, f, { contentType: f.type, upsert: false });
        if (error) { setErr('码单上传失败:' + error.message); continue; }
        paths.push(path);
      }
      setSlipPaths(p => [...p, ...paths]);
    } finally { setUploading(false); }
  }

  async function submit() {
    const q = parseFloat(qty);
    if (!(q > 0)) { setErr('请填本批实收数量'); return; }
    setSaving(true); setErr('');
    const res = await recordReceiptBatch(line.id, {
      received_qty: q, received_date: date, note: note || undefined,
      slip_paths: slipPaths.length ? slipPaths : undefined, mark_complete: complete,
      allow_over: allowOver,
    });
    setSaving(false);
    if ((res as any).error) { setErr((res as any).error); return; }
    if ((res as any).complete) { onDone(); return; }   // 收齐离队
    setQty(''); setNote(''); setSlipPaths([]);          // 未收齐:清本批,留着继续录
    reload();
  }

  return (
    <div className="bg-emerald-50/50 px-3 py-3 border-b border-gray-100 space-y-2">
      <div className="text-xs text-gray-600">
        订购 <b>{ordered || '—'}</b> {line.ordered_unit} · 已收 <b className={received >= ordered && ordered > 0 ? 'text-emerald-600' : 'text-amber-600'}>{received}</b>
        {ordered > 0 && <> · 差 <b>{Math.max(0, Math.round((ordered - received) * 1000) / 1000)}</b></>}
      </div>
      {/* 已收批次 */}
      {loading ? <div className="text-xs text-gray-400">加载批次…</div> : batches.length > 0 && (
        <div className="text-xs text-gray-500 space-y-0.5">
          {batches.map((b, i) => (
            <div key={b.id} className="flex items-center gap-2">
              <span>第{i + 1}批 {b.received_at?.slice(0, 10)}:</span>
              <b className="text-gray-700">{b.received_qty} {b.received_unit || ''}</b>
              {b.defect_notes && <span className="text-gray-400">· {b.defect_notes}</span>}
              {(b.slip_urls || []).map((u: string, j: number) => (
                <a key={j} href={u} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">码单{j + 1}</a>
              ))}
            </div>
          ))}
        </div>
      )}
      {/* 录本批 */}
      <div className="flex flex-wrap items-center gap-2">
        <input className="rounded border border-gray-300 px-2 py-1 text-xs w-24" placeholder={`本批实收`} type="number" step="0.01" value={qty} onChange={e => setQty(e.target.value)} />
        <input className="rounded border border-gray-300 px-2 py-1 text-xs" type="date" value={date} onChange={e => setDate(e.target.value)} title="收货日期" />
        <input className="rounded border border-gray-300 px-2 py-1 text-xs flex-1 min-w-[120px]" placeholder="备注(可选)" value={note} onChange={e => setNote(e.target.value)} />
        <label className="text-xs px-2 py-1 rounded bg-white border border-gray-300 cursor-pointer hover:bg-gray-50 whitespace-nowrap">
          {uploading ? '上传中…' : `📎 码单${slipPaths.length ? `(${slipPaths.length})` : ''}`}
          <input type="file" accept="image/*,.pdf" multiple className="hidden" disabled={uploading}
            onChange={e => { if (e.target.files?.length) uploadSlips(e.target.files); e.currentTarget.value = ''; }} />
        </label>
        <label className="text-xs flex items-center gap-1 text-gray-600"><input type="checkbox" checked={complete} onChange={e => setComplete(e.target.checked)} />收齐</label>
        <button disabled={saving || uploading} className="text-xs px-3 py-1 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50" onClick={submit}>{saving ? '登记中…' : '登记本批'}</button>
      </div>
      {/* 超收 ±10% 预警(本批会超时提示) */}
      {(() => {
        const q = parseFloat(qty) || 0;
        if (!(ordered > 0) || q <= 0) return null;
        const projected = Math.round((received + q) * 1000) / 1000;
        const cap = Math.round(ordered * 1.1 * 1000) / 1000;
        if (projected <= cap) return null;
        return (
          <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 text-amber-800 space-y-1">
            <p>⚠ 本批后累计 <b>{projected}</b> 将超采购量 {ordered} 的 10%(上限 {cap})。系统会拦截并通知财务。处理:①退回布行 ②让布行补足 ③超出搁置 ④财务审批放行。</p>
            {canFinanceOver
              ? <label className="flex items-center gap-1.5 text-amber-900 font-medium"><input type="checkbox" checked={allowOver} onChange={e => setAllowOver(e.target.checked)} />财务放行本次超收入账(留痕)</label>
              : <span className="text-amber-600">需财务勾选放行才能入账。</span>}
          </div>
        );
      })()}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}
