import { getOrder, getOrderLogs } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { getDelayRequestsByOrder } from '@/app/actions/delays';
import { getOrderCommissions } from '@/app/actions/commissions';
import { formatDate } from '@/lib/utils/date';
import { OrderTimeline } from '@/components/OrderTimeline';
import { DelayRequestsList } from '@/components/DelayRequestsList';
import { OrderScoreCard } from '@/components/OrderScoreCard';
import { MerchandiserAssign } from '@/components/MerchandiserAssign';
import { DeadlineCountdown } from '@/components/DeadlineCountdown';
import { normalizeMilestoneStatus } from '@/lib/domain/types';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';
import { BomTab } from '@/components/tabs/BomTab';
import { OutsourceTab } from '@/components/tabs/OutsourceTab';

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const rawTab = resolvedSearchParams?.tab ?? '';
  if (rawTab === 'timeline') {
    redirect(`/orders/${id}?tab=progress`);
  }
  if (rawTab === 'overview') {
    redirect(`/orders/${id}?tab=basic`);
  }
  const allowedTabs = ['basic', 'progress', 'delays', 'logs', 'bom', 'outsource', 'score'];
  const activeTab = allowedTabs.includes(rawTab) ? rawTab : 'basic';

  const { data: order, error: orderError } = await getOrder(id);
  if (orderError || !order) { notFound(); }

  const orderData = order as any;
  const supabase = await createClient();
  const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
  const { data: { user } } = await supabase.auth.getUser();
  const isOrderOwner = user ? orderData.created_by === user.id : false;

  // 获取用户多角色
  let currentRoles: string[] = currentRole ? [currentRole] : [];
  if (user) {
    const { data: profile } = await supabase.from('profiles').select('roles, role').eq('user_id', user.id).single();
    if ((profile as any)?.roles?.length > 0) {
      currentRoles = (profile as any).roles;
    }
  }

  const { data: milestones } = await getMilestonesByOrder(id);
  const { data: delayRequests } = await getDelayRequestsByOrder(id);
  const { data: logs } = await getOrderLogs(id);

  // 获取订单附件
  const { data: attachmentsRaw } = await (supabase.from('order_attachments') as any)
    .select('id, file_type, file_name, file_url, storage_path, file_size, mime_type, uploaded_by, created_at')
    .eq('order_id', id)
    .order('created_at', { ascending: true });
  const attachments = (attachmentsRaw || []) as any[];

  // 负责业务/理单
  let ownerName = '—';
  if (orderData.owner_user_id) {
    const { data: ownerProfile } = await (supabase.from('profiles') as any)
      .select('name, email')
      .eq('user_id', orderData.owner_user_id)
      .single();
    ownerName = ownerProfile?.name || ownerProfile?.email || '—';
  }

  // 跟单负责人（从 merchandiser 关卡查找已分配的用户）
  let merchandiserName: string | null = null;
  if (milestones) {
    const merchMilestone = (milestones as any[]).find(
      (m: any) => m.owner_role === 'merchandiser' && m.owner_user_id
    );
    if (merchMilestone?.owner_user) {
      merchandiserName = merchMilestone.owner_user.name || merchMilestone.owner_user.email || null;
    }
  }

  // 执行评分
  const { data: commissions } = await getOrderCommissions(id);

  const allMilestonesCompleted = milestones
    ? milestones.every((m: any) => normalizeMilestoneStatus(m.status) === '已完成')
    : false;

  // 计算订单整体风险色
  const overdueCount = (milestones || []).filter((m: any) => {
    const status = normalizeMilestoneStatus(m.status);
    return status !== '已完成' && m.due_at && new Date(m.due_at) < new Date();
  }).length;
  const blockedCount = (milestones || []).filter((m: any) => normalizeMilestoneStatus(m.status) === '卡住').length;
  const riskColor = overdueCount > 0 || blockedCount > 0
    ? (overdueCount > 2 || blockedCount > 1 ? 'red' : 'yellow')
    : 'green';
  const riskLabel = { red: '风险', yellow: '注意', green: '正常' }[riskColor];
  const riskClass = { red: 'bg-red-100 text-red-700', yellow: 'bg-yellow-100 text-yellow-700', green: 'bg-green-100 text-green-700' }[riskColor];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部 Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Link href="/orders" className="text-sm text-gray-400 hover:text-gray-600">← 订单列表</Link>
              </div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-gray-900">{orderData.order_no}</h1>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${riskClass}`}>{riskLabel}</span>
                {orderData.lifecycle_status && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                    {orderData.lifecycle_status}
                  </span>
                )}
                {orderData.is_new_customer && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">新客户首单</span>
                )}
                {orderData.is_new_factory && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">新工厂首单</span>
                )}
              </div>
              <p className="text-gray-500 text-sm mt-1">
                {orderData.customer_name}
                {orderData.style_no && <span className="ml-3 text-gray-400">款号：{orderData.style_no}</span>}
                {orderData.po_number && <span className="ml-3 text-gray-400">PO：{orderData.po_number}</span>}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">
                  {orderData.incoterm === 'FOB' ? 'ETD' : '入仓日'}：
                  <span className="text-gray-700 font-medium">
                    {orderData.incoterm === 'FOB' ? formatDate(orderData.etd) : formatDate(orderData.warehouse_due_date)}
                  </span>
                </span>
                {(orderData.incoterm === 'FOB' ? orderData.etd : orderData.warehouse_due_date) && (
                  <DeadlineCountdown
                    targetDate={orderData.incoterm === 'FOB' ? orderData.etd : orderData.warehouse_due_date}
                    label={orderData.incoterm === 'FOB' ? 'ETD' : '入仓'}
                  />
                )}
              </div>
              {orderData.cancel_date && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">
                    Cancel：<span className="text-gray-700 font-medium">{formatDate(orderData.cancel_date)}</span>
                  </span>
                  <DeadlineCountdown targetDate={orderData.cancel_date} label="Cancel" />
                </div>
              )}
            </div>
          </div>

          {/* Tab 导航 */}
          <div className="flex gap-1 mt-4 -mb-px">
            {[
              { key: 'basic', label: '基本信息' },
              { key: 'progress', label: `执行进度 ${overdueCount > 0 ? '🔴' : blockedCount > 0 ? '🟡' : ''}` },
              { key: 'delays', label: `延期申请 ${delayRequests && delayRequests.length > 0 ? '(' + delayRequests.length + ')' : ''}` },
              { key: 'logs', label: '操作日志' },
          { key: 'bom', label: '原辅料单' },
          { key: 'outsource', label: '外发任务' },
              { key: 'score', label: `执行评分 ${commissions && commissions.length > 0 ? '✓' : ''}` },
            ].map(t => (
              <Link
                key={t.key}
                href={`/orders/${id}?tab=${t.key}`}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === t.key
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Tab 内容 */}
      <div className="max-w-7xl mx-auto px-6 py-6">

        {/* Tab: 基本信息 */}
        {activeTab === 'basic' && (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">基础信息</h2>
              <dl className="space-y-3">
                {[
                  { label: '订单号', value: orderData.order_no },
                  { label: '客户', value: orderData.customer_name },
                  { label: '负责业务/理单', value: ownerName },
                  { label: '贸易条款', value: orderData.incoterm },
                  { label: orderData.incoterm === 'FOB' ? 'ETD' : '入仓日期', value: orderData.incoterm === 'FOB' ? formatDate(orderData.etd) : formatDate(orderData.warehouse_due_date) },
                  { label: '订单类型', value: ({ trial: '新品试单', bulk: '正常', repeat: '翻单', urgent: '加急订单', sample: '样品' } as Record<string,string>)[orderData.order_type] || orderData.order_type },
                  { label: '包装类型', value: orderData.packaging_type === 'standard' ? '标准' : '定制' },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">{value || '—'}</dd>
                  </div>
                ))}
                {/* 跟单负责人 — 管理员/订单创建者可指定 */}
                <div className="flex justify-between items-center">
                  <dt className="text-sm text-gray-500">跟单负责人</dt>
                  <dd className="text-sm font-medium">
                    {(isAdmin || isOrderOwner) ? (
                      <MerchandiserAssign orderId={id} currentMerchandiserName={merchandiserName} />
                    ) : (
                      <span className="text-gray-900">{merchandiserName || '未指定'}</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">订单详情</h2>
              <dl className="space-y-3">
                {[
                  { label: '订单数量', value: orderData.quantity ? `${orderData.quantity} 件` : null },
                  { label: '下单日期', value: orderData.order_date ? formatDate(orderData.order_date) : null },
                  { label: '工厂', value: orderData.factory_name },
                  { label: '备注', value: orderData.notes },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">{value || '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* 订单资料 */}
            <div className="md:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">📎 订单资料</h2>
              {attachments.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {attachments.map((att: any) => {
                    const typeLabels: Record<string, string> = {
                      customer_po: '客户PO',
                      production_order: '生产制单',
                      trims_sheet: '辅料表',
                      packing_requirement: '装箱要求',
                      tech_pack: 'Tech Pack',
                      qc_report: 'QC报告',
                      packing_list: '装箱单',
                    };
                    const label = typeLabels[att.file_type] || att.file_type || '附件';
                    const sizeKB = att.file_size ? Math.round(att.file_size / 1024) : null;
                    const downloadUrl = att.file_url || (att.storage_path
                      ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/order-docs/${att.storage_path}`
                      : null);

                    return (
                      <div key={att.id} className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors">
                        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-sm font-bold">
                          {label.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-indigo-700">{label}</p>
                          <p className="text-xs text-gray-500 truncate">{att.file_name || '未命名'}</p>
                          <p className="text-xs text-gray-400">
                            {formatDate(att.created_at)}
                            {sizeKB !== null && <span className="ml-2">{sizeKB}KB</span>}
                          </p>
                        </div>
                        {downloadUrl && (() => {
                          const ext = (att.file_name || '').split('.').pop()?.toLowerCase();
                          const canPreviewInBrowser = ['pdf','png','jpg','jpeg','gif','svg','webp','txt'].includes(ext || '');
                          const isOfficeFile = ['xlsx','xls','doc','docx','ppt','pptx'].includes(ext || '');
                          const canPreviewOnline = isOfficeFile || ['csv'].includes(ext || '');
                          const previewUrl = isOfficeFile
                            ? `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(downloadUrl)}`
                            : canPreviewOnline
                              ? `https://docs.google.com/gview?url=${encodeURIComponent(downloadUrl)}&embedded=true`
                              : downloadUrl;
                          return (
                            <div className="flex gap-1.5 flex-shrink-0">
                              <a
                                href={previewUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
                              >
                                {canPreviewInBrowser || canPreviewOnline ? '预览' : '查看'}
                              </a>
                              {(canPreviewOnline || !canPreviewInBrowser) && (
                                <a
                                  href={downloadUrl}
                                  download={att.file_name}
                                  className="text-xs px-2.5 py-1.5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100"
                                >
                                  下载
                                </a>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-4">暂无上传资料</p>
              )}
            </div>

            {/* 执行进度概览 */}
            <div className="md:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">进度概览</h2>
                <Link href={`/orders/${id}?tab=progress`} className="text-sm text-indigo-600 hover:text-indigo-700">查看详情 →</Link>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: '总节点', value: milestones?.length || 0, color: 'text-gray-700' },
                  { label: '已完成', value: (milestones || []).filter((m: any) => normalizeMilestoneStatus(m.status) === '已完成').length, color: 'text-green-600' },
                  { label: '逾期', value: overdueCount, color: overdueCount > 0 ? 'text-red-600' : 'text-gray-400' },
                  { label: '已阻塞', value: blockedCount, color: blockedCount > 0 ? 'text-orange-600' : 'text-gray-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="text-center p-3 rounded-lg bg-gray-50">
                    <div className={`text-2xl font-bold ${color}`}>{value}</div>
                    <div className="text-xs text-gray-500 mt-1">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab: 执行进度 */}
        {activeTab === 'progress' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">执行时间线</h2>
            {milestones && milestones.length > 0 ? (
              <OrderTimeline
                milestones={milestones}
                orderId={id}
                orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'}
                currentRole={currentRole}
                currentRoles={currentRoles}
                isAdmin={isAdmin}
              />
            ) : (
              <p className="text-gray-400 text-center py-8">暂无执行节点数据</p>
            )}
          </div>
        )}

        {/* Tab: 延期申请 */}
        {activeTab === 'delays' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">延期申请记录</h2>
            {delayRequests && delayRequests.length > 0 ? (
              <DelayRequestsList
                delayRequests={delayRequests}
                orderId={id}
                isAdmin={isAdmin}
                isOrderOwner={isOrderOwner}
              />
            ) : (
              <p className="text-gray-400 text-center py-8">暂无延期申请</p>
            )}
          </div>
        )}

        {/* Tab: 操作日志 */}
        {activeTab === 'logs' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">操作日志</h2>
            {logs && logs.length > 0 ? (
              <div className="space-y-3">
                {(logs as any[]).map((log: any) => {
                  const actionLabels: Record<string, string> = {
                    mark_done: '✅ 标记完成',
                    mark_blocked: '🚫 标记阻塞',
                    unblock: '🔓 解除阻塞',
                    update: '📝 更新',
                    create: '➕ 创建',
                    delay_request: '⏱ 申请延期',
                    delay_approved: '✅ 延期已批准',
                    delay_rejected: '❌ 延期已驳回',
                    schedule_recalc: '📅 排期调整',
                    evidence_upload: '📎 上传凭证',
                  };
                  const actorName = log.actor_name || '系统';
                  return (
                    <div key={log.id} className="flex gap-4 p-3 rounded-lg bg-gray-50 border border-gray-100">
                      <div className="flex-shrink-0 w-2 h-2 rounded-full bg-indigo-400 mt-2" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-gray-900">
                            {actionLabels[log.action] || log.action}
                            <span className="ml-2 text-xs font-normal text-gray-500">— {actorName}</span>
                          </span>
                          <span className="text-xs text-gray-400 flex-shrink-0">{formatDate(log.created_at)}</span>
                        </div>
                        {log.note && <p className="text-sm text-gray-600 mt-1">{log.note}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-gray-400 text-center py-8">暂无操作记录</p>
            )}
          </div>
        )}
        {/* Tab: 原辅料单 */}
        {activeTab === 'bom' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">原辅料单</h2>
            <BomTab orderId={id} />
          </div>
        )}

        {/* Tab: 外发任务 */}
        {activeTab === 'outsource' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">外发任务</h2>
            <OutsourceTab orderId={id} isAdmin={isAdmin} />
          </div>
        )}

        {/* Tab: 执行评分 */}
        {activeTab === 'score' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">执行评分</h2>
            <OrderScoreCard commissions={commissions || []} />
          </div>
        )}

      </div>
    </div>
  );
}
