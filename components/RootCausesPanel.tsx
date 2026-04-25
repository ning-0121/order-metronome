'use client';

/**
 * Root Causes 面板（订单详情页 admin tab）
 *
 * 仅 admin 可见。功能：
 *   - 列出当前订单的 active / confirmed / dismissed / resolved 根因
 *   - 一键扫描
 *   - 确认 / 驳回单条根因
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  scanOrderRootCauses,
  listOrderRootCauses,
  confirmRootCause,
  dismissRootCause,
} from '@/app/actions/rootCauses';
import type { RootCause, Severity } from '@/lib/engine/types';

interface Props {
  orderId: string;
  isAdmin: boolean;
}

const SEVERITY_STYLE: Record<Severity, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-100', text: 'text-red-700', label: '🚨 严重' },
  high:     { bg: 'bg-orange-100', text: 'text-orange-700', label: '⚠️ 高' },
  medium:   { bg: 'bg-amber-100', text: 'text-amber-700', label: '⚡ 中' },
  low:      { bg: 'bg-gray-100', text: 'text-gray-600', label: '· 低' },
};

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  active:    { bg: 'bg-red-50',    text: 'text-red-600',    label: '待处理' },
  confirmed: { bg: 'bg-blue-50',   text: 'text-blue-600',   label: '已确认' },
  dismissed: { bg: 'bg-gray-100',  text: 'text-gray-500',   label: '已驳回' },
  resolved:  { bg: 'bg-green-50',  text: 'text-green-600',  label: '已消除' },
};

const DOMAIN_LABEL: Record<string, string> = {
  delay: '延期', profit: '利润', payment: '收款', quality: '质量',
  confirmation: '确认链', logistics: '物流', factory: '工厂', customer: '客户',
};

export function RootCausesPanel({ orderId, isAdmin }: Props) {
  const router = useRouter();
  const [causes, setCauses] = useState<RootCause[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, includeResolved]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listOrderRootCauses(orderId, { includeResolved });
      if (res.error) setError(res.error);
      else setCauses(res.data || []);
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleScan() {
    if (!isAdmin) return;
    setScanning(true);
    setError(null);
    try {
      const res = await scanOrderRootCauses(orderId);
      if (res.error) {
        setError(res.error);
      } else if (res.data) {
        const { newCauses, updatedCauses, resolvedCauses, errors, rulesEvaluated } = res.data;
        const msg = `规则扫描完成：评估 ${rulesEvaluated} 条规则，新增 ${newCauses}、更新 ${updatedCauses}、自动消除 ${resolvedCauses}` +
          (errors.length > 0 ? `（有 ${errors.length} 条规则失败）` : '');
        alert(msg);
        await load();
        router.refresh();
      }
    } catch (e: any) {
      setError(e?.message ?? '扫描失败');
    } finally {
      setScanning(false);
    }
  }

  async function handleConfirm(causeId: string) {
    const note = prompt('确认根因（可填备注，留空也可以）：');
    if (note === null) return;
    const res = await confirmRootCause(causeId, note || undefined);
    if (res.error) alert(res.error);
    else await load();
  }

  async function handleDismiss(causeId: string) {
    const note = prompt('驳回原因（必填，用于审计）：');
    if (note === null) return;
    if (!note.trim()) {
      alert('驳回必须填写原因');
      return;
    }
    const res = await dismissRootCause(causeId, note);
    if (res.error) alert(res.error);
    else await load();
  }

  if (!isAdmin) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center">
        仅管理员可查看订单根因分析。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">订单根因分析</h3>
          <p className="text-xs text-gray-500 mt-0.5">基于规则引擎自动识别延期/利润/付款/质量/确认链等风险</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <input type="checkbox" checked={includeResolved} onChange={e => setIncludeResolved(e.target.checked)} />
            含已消除
          </label>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {scanning ? '扫描中...' : '🔍 立即扫描'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">加载中...</div>
      ) : causes.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">
          {includeResolved ? '暂无任何根因记录' : '暂无 active/confirmed 根因。点「立即扫描」生成一次。'}
        </div>
      ) : (
        <div className="space-y-2">
          {causes.map(c => {
            const sev = SEVERITY_STYLE[c.severity];
            const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.active;
            const expanded = expandedId === c.id;
            const sourceTag =
              c.source === 'rule' ? '规则' : c.source === 'ai' ? 'AI' : '人工';

            return (
              <div key={c.id} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex items-start gap-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sev.bg} ${sev.text}`}>
                    {sev.label}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.bg} ${st.text}`}>
                    {st.label}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {DOMAIN_LABEL[c.cause_domain] ?? c.cause_domain}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-600">
                    {sourceTag}
                  </span>
                  {c.stage && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">
                      阶段 {c.stage}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">
                    {new Date(c.created_at).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                </div>

                <div className="mt-2">
                  <p className="text-sm font-semibold text-gray-900">{c.cause_title}</p>
                  {c.cause_description && (
                    <p className="text-xs text-gray-600 mt-1 whitespace-pre-line">{c.cause_description}</p>
                  )}
                </div>

                <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                  {c.impact_days > 0 && <span>影响 ~{c.impact_days} 天</span>}
                  {c.impact_cost > 0 && <span>金额 ~¥{Number(c.impact_cost).toLocaleString()}</span>}
                  {c.responsible_role && <span>责任：{c.responsible_role}</span>}
                  <span>置信度 {(c.confidence_score * 100).toFixed(0)}%</span>
                  <span>code: <code className="font-mono text-gray-400">{c.cause_code}</code></span>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    {expanded ? '收起 evidence' : '查看 evidence'}
                  </button>
                  {c.status === 'active' && (
                    <>
                      <button
                        onClick={() => handleConfirm(c.id)}
                        className="text-xs px-2 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => handleDismiss(c.id)}
                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                      >
                        驳回
                      </button>
                    </>
                  )}
                  {c.resolution_note && (
                    <span className="text-xs text-gray-400 italic ml-auto">{c.resolution_note}</span>
                  )}
                </div>

                {expanded && (
                  <pre className="mt-2 p-2 rounded bg-gray-50 text-[11px] text-gray-700 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(c.evidence_json, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[11px] text-gray-400 pt-2 border-t border-gray-100">
        引擎版本：v0.1.0 · 已注册 5 条规则（付款 / 利润 / 确认链 / 质量 / 延期）
      </div>
    </div>
  );
}
