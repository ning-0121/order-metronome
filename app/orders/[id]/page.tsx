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
import { OrderAIRisk } from '@/components/OrderAIRisk';
import { OrderAgentSuggestions } from '@/components/OrderAgentSuggestions';
import { LiveScorePreview } from '@/components/LiveScorePreview';
import { DocumentCenterTab } from '@/components/tabs/DocumentCenterTab';
import { normalizeMilestoneStatus, isDoneStatus, isActiveStatus } from '@/lib/domain/types';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';
import { BomTab } from '@/components/tabs/BomTab';
import { OrderActions } from '@/components/OrderActions';
import { RecalcButton } from '@/components/RecalcButton';
import { ProductionProgressTab } from '@/components/tabs/ProductionProgressTab';
import { OrderAmendmentPanel } from '@/components/OrderAmendmentPanel';
import { AISkillSidebar } from '@/components/skills/AISkillSidebar';
import { ShipmentTab } from '@/components/tabs/ShipmentTab';
import { PackingFilesSection } from '@/components/PackingFilesSection';
import { EmailCenterTab } from '@/components/tabs/EmailCenterTab';
import { OrderNotesTab } from '@/components/tabs/OrderNotesTab';
import { BackButton } from '@/components/BackButton';
// POVerifyButton removed - auto-verify at order creation

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; from?: string; focus?: string }>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const rawTab = resolvedSearchParams?.tab ?? '';
  const focusMs = resolvedSearchParams?.focus || '';
  const fromUrl = resolvedSearchParams?.from
    ? decodeURIComponent(resolvedSearchParams.from)
    : '/orders';
  if (rawTab === 'timeline') {
    redirect(`/orders/${id}?tab=progress`);
  }
  if (rawTab === 'overview') {
    redirect(`/orders/${id}?tab=basic`);
  }
  const allowedTabs = ['basic', 'progress', 'delays', 'logs', 'bom', 'production', 'shipment', 'documents', 'email_center', 'notes', 'score'];
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

  // ── 并行加载 4 个独立查询（之前是串行，P1 性能修复） ──
  const [milestonesResult, delayRequestsResult, logsResult, attachmentsResult] = await Promise.all([
    getMilestonesByOrder(id),
    getDelayRequestsByOrder(id),
    getOrderLogs(id),
    (supabase.from('order_attachments') as any)
      .select('id, file_type, file_name, file_url, storage_path, file_size, mime_type, uploaded_by, created_at')
      .eq('order_id', id)
      .order('created_at', { ascending: true }),
  ]);
  const { data: milestones } = milestonesResult;
  const { data: delayRequests } = delayRequestsResult;
  const { data: logs } = logsResult;
  const attachments = (attachmentsResult.data || []) as any[];

  // 负责业务/理单
  let ownerName = '—';
  if (orderData.owner_user_id) {
    const { data: ownerProfile } = await (supabase.from('profiles') as any)
      .select('name, email')
      .eq('user_id', orderData.owner_user_id)
      .single();
    ownerName = ownerProfile?.name || ownerProfile?.email || '—';
  }

  // 跟单负责人（从 merchandiser 关卡查找已分配的用户，兼容多种角色值）
  let merchandiserName: string | null = null;
  let merchandiserUserId: string | null = null;
  if (milestones) {
    const merchRoles = ['merchandiser', 'production', 'qc'];
    const merchMilestone = (milestones as any[]).find(
      (m: any) => merchRoles.includes(m.owner_role) && m.owner_user_id
    );
    if (merchMilestone?.owner_user) {
      merchandiserName = merchMilestone.owner_user.name || merchMilestone.owner_user.email || null;
      merchandiserUserId = merchMilestone.owner_user_id;
    }
    // 如果没从 milestone 找到，尝试查订单的 merchandiser_user_id（如果存在）
    if (!merchandiserName && orderData.merchandiser_user_id) {
      const { data: merchProfile } = await (supabase.from('profiles') as any)
        .select('name, email').eq('user_id', orderData.merchandiser_user_id).single();
      if (merchProfile) {
        merchandiserName = merchProfile.name || merchProfile.email || null;
        merchandiserUserId = orderData.merchandiser_user_id;
      }
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
      {/* 醒目返回按钮 — 独立浮动栏，避免被 Navbar 遮挡 */}
      <div className="bg-indigo-50 border-b border-indigo-200 px-6 py-3">
        <div className="max-w-7xl mx-auto">
          <BackButton fromUrl={fromUrl} />
        </div>
      </div>

      {/* 顶部 Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Link href="/orders" className="text-sm text-gray-400 hover:text-gray-600">
                  订单列表
                </Link>
              </div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-gray-900">{orderData.order_no}</h1>
                {orderData.lifecycle_status !== 'draft' && riskColor !== 'green' && (
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${riskClass}`}>{riskLabel}</span>
                )}
                {orderData.lifecycle_status && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                    {orderData.lifecycle_status === 'draft' ? '草稿' : orderData.lifecycle_status === 'active' ? '执行中' : orderData.lifecycle_status === 'completed' || orderData.lifecycle_status === '已完成' ? '已完成' : orderData.lifecycle_status === 'cancelled' || orderData.lifecycle_status === '已取消' ? '已取消' : orderData.lifecycle_status === 'pending_approval' ? '⏳ 待审批' : orderData.lifecycle_status}
                  </span>
                )}
                {orderData.order_type && (() => {
                  const tl: Record<string, string> = { trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急' };
                  const tc: Record<string, string> = { trial: 'bg-blue-100 text-blue-700', bulk: 'bg-gray-100 text-gray-700', repeat: 'bg-green-100 text-green-700', urgent: 'bg-red-100 text-red-700' };
                  return <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${tc[orderData.order_type] || 'bg-gray-100'}`}>{tl[orderData.order_type] || orderData.order_type}</span>;
                })()}
                {orderData.is_new_customer && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">新客户首单</span>
                )}
                {orderData.is_new_factory && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">新工厂首单</span>
                )}
                {(orderData.special_tags || []).map((tag: string) => (
                  <span key={tag} className="text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 text-red-700">{tag}</span>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-gray-500 text-sm">
                  {orderData.customer_name}
                  {orderData.style_no && <span className="ml-3 text-gray-400">款号：{orderData.style_no}</span>}
                  {orderData.po_number && <span className="ml-3 text-gray-400">PO：{orderData.po_number}</span>}
                </p>
                <OrderActions
                  orderId={id}
                  orderNo={orderData.order_no}
                  lifecycleStatus={orderData.lifecycle_status || 'draft'}
                  isAdmin={isAdmin}
                  isOrderOwner={isOrderOwner}
                />
                {isAdmin && <RecalcButton orderId={id} orderNo={orderData.order_no} />}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {/* 出厂日期 */}
              {orderData.factory_date && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">
                    出厂：<span className="text-gray-700 font-medium">{formatDate(orderData.factory_date)}</span>
                  </span>
                  <DeadlineCountdown targetDate={orderData.factory_date} label="出厂" />
                </div>
              )}
              {/* ETD/ETA 仅 DDP 才显示（FOB / 人民币 由客户自己安排出运或我们送仓） */}
              {orderData.incoterm === 'DDP' && orderData.etd && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">
                    ETD：<span className="text-gray-700 font-medium">{formatDate(orderData.etd)}</span>
                  </span>
                  <DeadlineCountdown targetDate={orderData.etd} label="ETD" />
                </div>
              )}
              {orderData.incoterm === 'DDP' && orderData.warehouse_due_date && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">
                    ETA：<span className="text-gray-700 font-medium">{formatDate(orderData.warehouse_due_date)}</span>
                  </span>
                  <DeadlineCountdown targetDate={orderData.warehouse_due_date} label="ETA" />
                </div>
              )}
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

          {/* Tab 导航（移动端可横向滚动） */}
          <div className="flex gap-1 mt-4 -mb-px overflow-x-auto scrollbar-hide">
            {[
              { key: 'basic', label: '基本信息' },
              { key: 'progress', label: `执行进度 ${overdueCount > 0 ? '🔴' : blockedCount > 0 ? '🟡' : ''}` },
              { key: 'delays', label: `延期申请 ${delayRequests && delayRequests.length > 0 ? '(' + delayRequests.length + ')' : ''}` },
              { key: 'logs', label: '操作日志' },
          { key: 'bom', label: '原辅料和包装' },
          { key: 'production', label: '生产进度' },
              { key: 'shipment', label: '出货管理' },
              { key: 'documents', label: '单据中心' },
              { key: 'email_center', label: '邮件中心' },
              { key: 'notes', label: '📝 备注' },
              { key: 'score', label: `执行评分 ${commissions && commissions.length > 0 ? '✓' : ''}` },
            ].map(t => (
              <Link
                key={t.key}
                href={`/orders/${id}?tab=${t.key}${fromUrl !== '/orders' ? `&from=${encodeURIComponent(fromUrl)}` : ''}`}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
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
          <>
          {/* AI Skills 侧栏 — 订单创建者/跟单/节点负责人/admin 都可见
              （无权用户会被 server action 拦截，UI 自动隐藏） */}
          <div className="mb-6">
            <AISkillSidebar orderId={id} />
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">基础信息</h2>
              <dl className="space-y-3">
                {[
                  { label: '订单号', value: orderData.order_no },
                  { label: '客户', value: orderData.customer_name },
                  { label: '客户PO号', value: orderData.po_number },
                  { label: '内部订单号', value: orderData.internal_order_no },
                  { label: '负责业务/理单', value: ownerName },
                  { label: '贸易条款', value: ({ FOB: 'FOB', DDP: 'DDP', RMB_EX_TAX: '人民币不含税', RMB_INC_TAX: '人民币含税' } as any)[orderData.incoterm] || orderData.incoterm },
                  ...(orderData.incoterm === 'DDP' ? [
                    { label: 'ETD', value: formatDate(orderData.etd) },
                    { label: '到仓日期(ETA)', value: formatDate(orderData.warehouse_due_date) },
                  ] : []),
                  { label: '订单类型', value: ({ trial: '新品试单', bulk: '正常', repeat: '翻单', urgent: '加急订单', sample: '样品' } as Record<string,string>)[orderData.order_type] || orderData.order_type },
                  { label: '包装类型', value: orderData.packaging_type === 'standard' ? '标准' : '定制' },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">{value || '—'}</dd>
                  </div>
                ))}
                {/* 跟单负责人 — 管理员/订单创建者/生产主管可指定 */}
                <div className="flex justify-between items-center">
                  <dt className="text-sm text-gray-500">跟单负责人</dt>
                  <dd className="text-sm font-medium">
                    {(isAdmin || isOrderOwner || currentRoles.includes('production_manager')) ? (
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
                  { label: '款数', value: orderData.style_count ? `${orderData.style_count} 款` : null },
                  { label: '颜色数', value: orderData.color_count ? `${orderData.color_count} 色` : null },
                  { label: '下单日期', value: orderData.order_date ? formatDate(orderData.order_date) : null },
                  { label: '出厂日期', value: orderData.factory_date ? formatDate(orderData.factory_date) : null },
                  { label: '工厂', value: orderData.factory_name },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">{value || '—'}</dd>
                  </div>
                ))}
                {/* 备注高亮显示 */}
                {orderData.notes ? (
                  <div className="mt-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                    <dt className="text-xs font-semibold text-amber-700 mb-1">客户备注</dt>
                    <dd className="text-sm text-amber-900 leading-relaxed whitespace-pre-wrap">{orderData.notes}</dd>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <dt className="text-sm text-gray-500">备注</dt>
                    <dd className="text-sm font-medium text-gray-900">—</dd>
                  </div>
                )}
              </dl>
            </div>

            {/* AI 订单风险分析 */}
            <div className="md:col-span-2">
              <OrderAIRisk contextData={(() => {
                const parts: string[] = [];
                parts.push(`订单${orderData.order_no}，客户：${orderData.customer_name}，工厂：${orderData.factory_name || '未指定'}`);
                parts.push(`类型：${orderData.order_type}，贸易：${orderData.incoterm}，数量：${orderData.quantity || '未知'}件`);
                if (orderData.is_new_customer) parts.push('⚠ 新客户首单');
                if (orderData.is_new_factory) parts.push('⚠ 新工厂首单');
                if (orderData.special_tags?.length > 0) parts.push(`风险标签：${orderData.special_tags.join('、')}`);
                const doneMilestones = (milestones as any[]).filter((m: any) => isDoneStatus(m.status)).length;
                const totalMilestones = (milestones as any[]).length;
                const overdueMilestones = (milestones as any[]).filter((m: any) => isActiveStatus(m.status) && m.due_at && new Date(m.due_at) < new Date());
                parts.push(`进度：${doneMilestones}/${totalMilestones}完成`);
                if (overdueMilestones.length > 0) parts.push(`逾期节点：${overdueMilestones.map((m: any) => m.name).join('、')}`);
                const etdDate = orderData.etd || orderData.warehouse_due_date;
                if (etdDate) {
                  const daysLeft = Math.ceil((new Date(etdDate).getTime() - new Date().getTime()) / 86400000);
                  parts.push(`交期${daysLeft > 0 ? `剩余${daysLeft}天` : `已超${Math.abs(daysLeft)}天`}`);
                }
                return parts.join('，');
              })()} orderId={id} />
            </div>

            {/* Agent 可执行建议 */}
            <div className="md:col-span-2">
              <OrderAgentSuggestions orderId={id} />
            </div>

            {/* 订单资料 */}
            <div className="md:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">📎 订单资料</h2>
              {(() => {
                const sensitiveTypes = ['customer_po', 'internal_quote', 'customer_quote'];
                const isMerchandiser = user ? orderData.merchandiser_user_id === user.id : false;
                const canSeeSensitive = isAdmin || isOrderOwner || isMerchandiser || currentRoles.includes('finance');
                const visibleAttachments = attachments.filter((att: any) =>
                  !sensitiveTypes.includes(att.file_type) || canSeeSensitive
                );
                return visibleAttachments.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleAttachments.map((att: any) => {
                    const typeLabels: Record<string, string> = {
                      customer_po: '客户PO',
                      internal_quote: '内部报价单',
                      customer_quote: '客户报价单',
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
              );
              })()}
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

          {/* 订单修改申请 */}
          <div className="mt-6">
            <OrderAmendmentPanel
              orderId={orderData.id}
              order={orderData}
              isAdmin={isAdmin}
              doneStepKeys={(milestones || []).filter((m: any) => isDoneStatus(m.status)).map((m: any) => m.step_key)}
            />
          </div>
          </>
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
                currentUserId={user.id}
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
                            {log.milestone_name && <span className="ml-1 text-xs font-normal text-indigo-600">「{log.milestone_name}」</span>}
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
        {/* Tab: 原辅料和包装 */}
        {activeTab === 'bom' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">📋 原辅料和包装资料</h2>
            {/* 包装资料文件 */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">📦 包装资料</h3>
              <PackingFilesSection orderId={id} fileTypes={['packing_requirement', 'tech_pack']} emptyText="业务在「生产单上传」节点上传的包装资料将显示在这里" />
            </div>
            {/* 原辅料单文件 */}
            <div className="pt-4 border-t border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">🧵 原辅料单</h3>
              <PackingFilesSection orderId={id} fileTypes={['trims_sheet', 'production_order']} emptyText="业务在「生产单上传」节点上传的原辅料单将显示在这里" />
            </div>
            {/* BOM 清单已移除 */}
          </div>
        )}

        {/* Tab: 生产进度 */}
        {activeTab === 'production' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">生产进度</h2>
            {/* 生产订单文件快捷查看 */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-600 mb-2">📄 生产订单</h3>
              <PackingFilesSection orderId={id} fileTypes={['production_order']} emptyText="暂未上传生产订单，请在「执行进度→生产单上传」中补传" />
            </div>
            <ProductionProgressTab
              orderId={id}
              isAdmin={isAdmin}
              canReport={currentRoles.some(r => ['sales', 'merchandiser'].includes(r))}
            />
          </div>
        )}

        {/* Tab: 出货管理 */}
        {activeTab === 'shipment' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">出货管理</h2>
            <ShipmentTab
              orderId={id}
              orderQty={orderData.quantity || undefined}
              currentRole={currentRole || ''}
              isAdmin={isAdmin}
              userId={user?.id}
              isSplitShipment={orderData.is_split_shipment || false}
              orderContext={{
                customerName: orderData.customer_name,
                factoryDate: orderData.factory_date,
                etd: orderData.etd,
                incoterm: orderData.incoterm,
              }}
            />
          </div>
        )}

        {/* Tab: 单据中心 */}
        {activeTab === 'documents' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">📋 单据中心</h2>
            <DocumentCenterTab orderId={id} isAdmin={isAdmin} currentRoles={currentRoles}
              canViewPriceDocs={isAdmin || currentRoles.includes('finance') || isOrderOwner || (user ? (orderData.owner_user_id === user.id || orderData.merchandiser_user_id === user.id) : false)}
              orderContext={{
                orderNo: orderData.order_no,
                customerName: orderData.customer_name,
                factoryName: orderData.factory_name,
                quantity: orderData.quantity,
                incoterm: orderData.incoterm,
              }} />
          </div>
        )}

        {/* Tab: 邮件中心（合并原邮件往来 + 邮件差异 + 联系邮箱） */}
        {activeTab === 'email_center' && (
          <EmailCenterTab
            orderId={id}
            customerName={orderData.customer_name || ''}
            orderNo={orderData.order_no || ''}
          />
        )}

        {/* Tab: 备注（通用备注日志 — 所有角色可写） */}
        {activeTab === 'notes' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">订单备注</h2>
            <p className="text-xs text-gray-500 mb-5">
              任何和这个订单相关的事都可以记在这里：延期原因、客户沟通、品质问题、内部协调...
              所有人都能看到，形成完整沟通历史。
            </p>
            <OrderNotesTab orderId={id} currentUserId={user?.id} isAdmin={isAdmin} />
          </div>
        )}

        {/* Tab: 执行评分 */}
        {activeTab === 'score' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">执行评分</h2>
            <LiveScorePreview orderId={id} />
          </div>
        )}

      </div>
    </div>
  );
}
