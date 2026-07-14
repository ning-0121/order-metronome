import { getOrder, getOrderLogs } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { getDelayRequestsByOrder } from '@/app/actions/delays';
import { getOrderCommissions } from '@/app/actions/commissions';
import { formatDate } from '@/lib/utils/date';
import { getOrderTypeBadge, getOrderTypeLabel } from '@/lib/theme/colors';
import { OrderTimeline } from '@/components/OrderTimeline';
import { DelayRequestsList } from '@/components/DelayRequestsList';
import { OrderScoreCard } from '@/components/OrderScoreCard';
import { MerchandiserAssign } from '@/components/MerchandiserAssign';
import { FactoryAssign } from '@/components/FactoryAssign';
import { DeadlineCountdown } from '@/components/DeadlineCountdown';
import { LiveScorePreview } from '@/components/LiveScorePreview';
import { DocumentCenterTab } from '@/components/tabs/DocumentCenterTab';
import { isActiveStatus, isDoneStatus, normalizeMilestoneStatus } from '@/lib/domain/types';
import { notFound, redirect } from 'next/navigation';
import { isProcurementOnly } from '@/lib/utils/procurement-page-guard';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { PRODUCTION_MANAGER_FIXED_STEPS } from '@/lib/domain/default-assignees';
import Link from 'next/link';
import { BomTab } from '@/components/tabs/BomTab';
import { ManufacturingOrderTab } from '@/components/tabs/ManufacturingOrderTab';
import { ProcurementItemsTab } from '@/components/tabs/ProcurementItemsTab';
import { ProductVariantPicker } from '@/components/ProductVariantPicker';
import { BudgetApprovalBanner } from '@/components/BudgetApprovalBanner';
import { getOrderBudgetApproval } from '@/app/actions/budget-approvals';
import { OrderActions } from '@/components/OrderActions';
import { OrderProgressCalibrate } from '@/components/OrderProgressCalibrate';
import { PITab } from '@/components/tabs/PITab';
import { ExportSampleRequestButton } from '@/components/ExportSampleRequestButton';
import { RecalcButton } from '@/components/RecalcButton';
import { RescheduleBanner } from '@/components/RescheduleBanner';
import { OrderDelayPanel } from '@/components/OrderDelayPanel';
import { ProductionProgressTab } from '@/components/tabs/ProductionProgressTab';
import { OrderAmendmentPanel } from '@/components/OrderAmendmentPanel';
import { QuantityCorrectionButton } from '@/components/QuantityCorrectionButton';
import { CustomerAddOrderPanel } from '@/components/order/CustomerAddOrderPanel';
import { PerPoOperationsPanel } from '@/components/order/PerPoOperationsPanel';
import { BuildDocsSupplement } from '@/components/order/BuildDocsSupplement';
import { CancelRequestPanel } from '@/components/CancelRequestPanel';
import { OverdueOrderGate } from '@/components/OverdueOrderGate';
import { SplitShipmentTag } from '@/components/SplitShipmentTag';
import { ColorPendingTag } from '@/components/ColorPendingTag';
import { InspectionWaiverTag } from '@/components/InspectionWaiverTag';
import { isInspectionWaived } from '@/lib/domain/inspectionWaiver';
import { isColorPending } from '@/lib/domain/colorPending';
import { ProcurementTrackingTab } from '@/components/tabs/ProcurementTrackingTab';
import { ShipmentTab } from '@/components/tabs/ShipmentTab';
import { PackingFilesSection } from '@/components/PackingFilesSection';
import { InlineEditField } from '@/components/InlineEditField';
import { EmailCenterTab } from '@/components/tabs/EmailCenterTab';
import { OrderNotesTab } from '@/components/tabs/OrderNotesTab';
import { RootCausesPanel } from '@/components/RootCausesPanel';
import { rootCauseEngineEnabled } from '@/lib/engine/featureFlags';
import { ProcurementTab } from '@/components/tabs/ProcurementTab';
import { FinanceEventsTimeline } from '@/components/FinanceEventsTimeline';
import { SupplyChainTab } from '@/components/tabs/SupplyChainTab';
import { BomBudgetEntry } from '@/components/tabs/BomBudgetEntry';
import { BackButton } from '@/components/BackButton';
import { OrderDecisionPanel } from '@/components/OrderDecisionPanel';
import { businessDecisionEngineEnabled } from '@/lib/engine/featureFlags';
import { RetrospectiveTab } from '@/components/tabs/RetrospectiveTab';
import {
  isCustomerShipHoldFromOrder,
  CUSTOMER_SHIP_HOLD_TAG,
  isCustomerHoldStale,
  CUSTOMER_HOLD_STALE_DAYS,
} from '@/lib/domain/customerShipHold';
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
  // 2026-07-08 用户拍板:弃用「成本控制」+「报价基线/报价单识别」(布料名对不上采购)。预算/成本真相全走「采购核料」。
  const allowedTabs = ['basic', 'progress', 'delays', 'logs', 'product_link', 'bom', 'manufacturing_order', 'pi', 'procurement_items', 'procurement', 'supply_chain', 'production', 'shipment', 'documents', 'email_center', 'notes', 'score', 'retrospective'];
  const activeTab = allowedTabs.includes(rawTab) ? rawTab : 'basic';

  const { data: order, error: orderError } = await getOrder(id);
  if (orderError || !order) { notFound(); }

  const orderData = order as any;
  const customerShipHold = isCustomerShipHoldFromOrder(orderData);
  const colorPending = isColorPending(orderData);
  const customerHoldStale = isCustomerHoldStale(orderData);
  const supabase = await createClient();
  // 复审性能:getCurrentUserRole 已做 auth+profiles,直接复用它返回的 userId/roles,
  // 省掉此前额外的 auth.getUser() + profiles 查询(每开一张订单省 1 次鉴权往返 + 1 次角色查询)。
  const { role: currentRole, isAdmin, userId, roles: profileRoles } = await getCurrentUserRole(supabase);
  // 页面下游多处仍用 user.id / user?.id(currentUserId 等 props)→ 由 userId 合成最小 user 对象,
  // 保留"去重复鉴权"优化(不再另调 auth.getUser)的同时,不破坏这些引用。
  const user = userId ? { id: userId } : null;
  const isOrderOwner = userId ? orderData.created_by === userId : false;
  const currentRoles: string[] = (profileRoles && profileRoles.length > 0) ? profileRoles : (currentRole ? [currentRole] : []);
  // 纯采购角色不进订单详情(2026-07-03 用户拍板:采购看到/误改订单一切太危险)
  // → 改道采购专属核料页(只读摘要+核料+任务单下载)。兼任其他角色/管理员不受限。
  if (!isAdmin && isProcurementOnly(currentRoles)) {
    redirect(`/procurement/verify/${id}`);
  }
  // 价格/利润可见性（红线：production/merchandiser/admin_assistant/procurement/logistics 不可见）
  const canSeeFinancials = isAdmin || hasRoleInGroup(currentRoles, 'CAN_SEE_FINANCIALS');
  // 谁能看/录采购核料预算(有价):财务可见组 ∪ 预算录入白名单(理单/采购要填)。
  // 修 P2(2026-07-09 审计):此前非 admin 一律显示 BomBudgetEntry,预算单价/加工费泄露给 production/qc/logistics 等无关角色。
  const canEnterBudget = canSeeFinancials || currentRoles.some((r) => ['merchandiser', 'procurement', 'procurement_manager'].includes(r));

  // ── 并行加载 5 个独立查询（owner profile 之前是串行额外查询，2026-05-19 合并到并行池）──
  const [milestonesResult, delayRequestsResult, logsResult, attachmentsResult, ownerProfileResult] = await Promise.all([
    getMilestonesByOrder(id),
    getDelayRequestsByOrder(id),
    getOrderLogs(id),
    (supabase.from('order_attachments') as any)
      .select('id, milestone_id, file_type, file_name, file_url, storage_path, file_size, mime_type, uploaded_by, created_at')
      .eq('order_id', id)
      .order('created_at', { ascending: true }),
    orderData.owner_user_id
      ? (supabase.from('profiles') as any)
          .select('name, email')
          .eq('user_id', orderData.owner_user_id)
          .single()
      : Promise.resolve({ data: null }),
  ]);
  const { data: milestones } = milestonesResult;
  const { data: delayRequests } = delayRequestsResult;
  const { data: logs } = logsResult;
  const attachments = (attachmentsResult.data || []) as any[];
  const ownerProfile = (ownerProfileResult as any)?.data || null;
  const ownerName = ownerProfile?.name || ownerProfile?.email || '—';

  // 跟单负责人:2026-07-08 拆成两组 —— 理单跟单(owner_role='merchandiser')与生产跟单('production'),
  // 可由不同人负责。分别取各自节点的 owner 显示;之前只取「第一个」会把另一组的改动盖住(生产改了却仍显示理单人)。
  // 2026-07-08 修「生产跟单改不了名字」:显示口径必须和 assignMerchandiser 实际改的节点对齐 —— 排除
  // 生产主管固定节点(PRODUCTION_MANAGER_FIXED_STEPS,指派时永不覆盖)。否则重新指派后,若首个 production
  // 节点恰是固定节点(如 pre_production_sample_ready 仍属主管),显示就一直是主管名,看着像"改不了"。
  const pmFixedSteps = new Set(PRODUCTION_MANAGER_FIXED_STEPS);
  const followUpOwnerName = (role: string): string | null => {
    const m = (milestones as any[] | null)?.find((x: any) =>
      x.owner_role === role && x.owner_user_id && x.owner_user &&
      !(role === 'production' && pmFixedSteps.has(x.step_key)));
    return m ? (m.owner_user.name || m.owner_user.email || null) : null;
  };
  const merchandiserName = followUpOwnerName('merchandiser');   // 理单跟单
  const productionFollowName = followUpOwnerName('production');  // 生产跟单

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

  // 超预算提交采购审批(最新一条)——顶部横幅展示 + 经理/财务就地审批
  const budgetApproval = await getOrderBudgetApproval((orderData as any).id).catch(() => ({} as any));

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 醒目返回按钮 — 独立浮动栏，避免被 Navbar 遮挡 */}
      <div className="bg-indigo-50 border-b border-indigo-200 px-6 py-3">
        <div className="max-w-7xl mx-auto">
          <BackButton fromUrl={fromUrl} />
        </div>
      </div>

      {/* 重排排期横幅（出厂日已过且未出运/送仓时显示给 admin/owner） */}
      <div className="max-w-7xl mx-auto px-6 pt-4 space-y-3">
        {/* 超预算提交采购审批横幅(超基线单耗:经理批;超5%:+财务批) */}
        {(budgetApproval as any)?.data && (
          <BudgetApprovalBanner approval={(budgetApproval as any).data} canMgr={!!(budgetApproval as any).canMgr} canFin={!!(budgetApproval as any).canFin} />
        )}
        {/* 国内送仓信息缺失提示（订单创建后允许暂空，但需在「包装方式确认」前补齐） */}
        {(orderData as any).delivery_type === 'domestic' && (() => {
          const o = orderData as any;
          const missing: string[] = [];
          if (!o.delivery_warehouse_name?.trim()) missing.push('仓库名称');
          if (!o.delivery_address?.trim())        missing.push('详细地址');
          if (!o.delivery_contact?.trim())        missing.push('收货联系人');
          if (!o.delivery_phone?.trim())          missing.push('联系电话');
          if (!o.delivery_required_at)            missing.push('客户要求送达日期');
          if (missing.length === 0) return null;
          return (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
              <span className="text-xl shrink-0">📦</span>
              <div className="text-sm">
                <p className="font-semibold text-amber-900">国内送仓信息待补齐：{missing.join('、')}</p>
                <p className="text-amber-800 mt-1">
                  创建订单时允许暂空，但<strong className="text-amber-900">「包装方式确认」节点完成前必须补齐</strong>（包装/唛头依赖送货地址）。
                  请在「订单基本信息」编辑区域补充，或与客户确认后填入。
                </p>
              </div>
            </div>
          );
        })()}
        {colorPending && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <span className="text-xl shrink-0">⏳</span>
            <div className="text-sm">
              <p className="font-semibold text-amber-900">颜色待定 —— 本单颜色尚未确定</p>
              <p className="text-amber-800 mt-1">
                已允许先推进(PO确认免「颜色核对一致」)。颜色确定后请到<b>「原辅料」/订单明细</b>补齐颜色,再点顶部「⏳ 颜色待定」标签取消。
              </p>
            </div>
          </div>
        )}
        {customerShipHold && customerHoldStale && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <span className="text-xl shrink-0">🟡</span>
            <div className="text-sm">
              <p className="font-semibold text-amber-900">客户待运 · 已超过 {CUSTOMER_HOLD_STALE_DAYS} 天未刷新锚点日期</p>
              <p className="text-amber-800 mt-1">
                请在备注中更新原因与下一预计出运日，或通过超期确认调整「预计发货日」，避免列表长期挂在「待复盘」。
              </p>
            </div>
          </div>
        )}
        {(() => {
          if (customerShipHold) return null;
          const allMs: any[] = (orderData as any).milestones || [];
          const finalKeys = ['booking_done', 'domestic_delivery', 'shipment_completed', 'shipment_done'];
          const isShipped = allMs.some(m =>
            finalKeys.includes(m.step_key) && (isDoneStatus(m.status))
          );
          return (
            <RescheduleBanner
              orderId={id}
              orderNo={orderData.order_no}
              factoryDate={orderData.factory_date || null}
              deliveryRequiredAt={(orderData as any).delivery_required_at || orderData.warehouse_due_date || null}
              isShipped={isShipped}
              canReschedule={isAdmin || isOrderOwner}
            />
          );
        })()}

        {/* 整单延期管理面板：申请 + 历史 + 客户证据 */}
        <OrderDelayPanel
          orderId={id}
          orderNo={orderData.order_no}
          customerName={orderData.customer_name || ''}
          currentFactoryDate={orderData.factory_date || orderData.etd || null}
          incoterm={String(orderData.incoterm || '')}
          delayHistory={((delayRequests as any[]) || []).map((d: any) => ({
            id: d.id,
            status: d.status,
            reason_category: d.reason_category,
            reason_type: d.reason_type,
            reason_detail: d.reason_detail,
            proposed_new_anchor_date: d.proposed_new_anchor_date,
            requires_customer_approval: d.requires_customer_approval,
            customer_approval_evidence_url: d.customer_approval_evidence_url,
            delay_days: d.delay_days,
            created_at: d.created_at,
            approved_at: d.approved_at,
            decision_note: d.decision_note,
          }))}
          canRequestDelay={
            (isAdmin || isOrderOwner || currentRoles.some(r => ['sales', 'merchandiser'].includes(r))) &&
            orderData.lifecycle_status !== 'completed' &&
            orderData.lifecycle_status !== '已完成' &&
            orderData.lifecycle_status !== 'cancelled' &&
            orderData.lifecycle_status !== '已取消'
          }
          isAdmin={isAdmin}
        />

        {/* 取消订单申请：待审批横幅 + 管理员审批入口 */}
        <CancelRequestPanel orderId={id} isAdmin={isAdmin} />
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
                {orderData.order_type && (
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${getOrderTypeBadge(orderData.order_type)}`}>
                    {getOrderTypeLabel(orderData.order_type)}
                  </span>
                )}
                {orderData.is_new_customer && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">新客户首单</span>
                )}
                {orderData.is_new_factory && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">新工厂首单</span>
                )}
                {(orderData.special_tags || [])
                  .filter((tag: string) => tag !== '分批出货中' && tag !== '免验货')
                  .map((tag: string) => (
                    <span
                      key={tag}
                      className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                        tag === CUSTOMER_SHIP_HOLD_TAG ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {tag}
                    </span>
                  ))}
                {/* 分批出货标签（独立组件，可点击切换） */}
                <SplitShipmentTag
                  orderId={id}
                  orderNo={orderData.order_no}
                  initialTags={orderData.special_tags || []}
                  canEdit={isAdmin || isOrderOwner || currentRoles.includes('sales') || currentRoles.includes('sales_manager')}
                />
                <ColorPendingTag
                  orderId={id}
                  orderNo={orderData.order_no}
                  initialTags={orderData.special_tags || []}
                  canEdit={isAdmin || isOrderOwner || currentRoles.some((r) => ['sales', 'sales_manager', 'merchandiser', 'order_manager'].includes(r))}
                />
                <InspectionWaiverTag
                  orderId={id}
                  initialTags={orderData.special_tags || []}
                  canEdit={isAdmin || isOrderOwner || currentRoles.some((r) => ['sales', 'sales_manager', 'merchandiser', 'order_manager', 'production', 'qc', 'quality', 'production_manager'].includes(r))}
                />
              </div>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-gray-500 text-sm">
                  {orderData.customer_name}
                  {orderData.internal_order_no
                    ? <span className="ml-3 font-medium text-gray-600">内部单号：{orderData.internal_order_no}</span>
                    : <span className="ml-3 text-amber-600" title="财务核算靠内部单号对账;在下方「基本信息」的内部订单号处补填">⚠ 内部单号未填</span>}
                  {orderData.style_no && <span className="ml-3 text-gray-400">款号：{orderData.style_no}</span>}
                  {orderData.po_number && <span className="ml-3 text-gray-400">PO：{orderData.po_number}</span>}
                </p>
                <OrderActions
                  orderId={id}
                  orderNo={orderData.order_no}
                  lifecycleStatus={orderData.lifecycle_status || 'draft'}
                  isAdmin={isAdmin}
                  isOrderOwner={isOrderOwner}
                  isFinance={currentRoles.includes('finance')}
                />
                {/* 重算排期按钮已移除(2026-07-06 用户:不需要) */}
                {(orderData.order_type === 'sample' || (orderData as any).order_purpose === 'sample') && (
                  <ExportSampleRequestButton orderId={id} />
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {/* 出厂日期 */}
              {orderData.factory_date && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">
                    出厂：<span className="text-gray-700 font-medium">{formatDate(orderData.factory_date)}</span>
                  </span>
                  <DeadlineCountdown
                    targetDate={orderData.factory_date}
                    label="出厂"
                    customerHoldVisual={customerShipHold}
                  />
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

          {/* 建单必传附件补传条:缺 客户PO/内部报价单 且授权人(创建者/负责人/业务经理/管理员)可见;补传即时共享财务 */}
          {(() => {
            const canManage = isAdmin
              || (userId && (orderData.created_by === userId || orderData.owner_user_id === userId))
              || currentRoles.includes('sales_manager');
            if (!canManage) return null;
            const present = new Set(attachments.map((a) => a.file_type));
            const missing = ['customer_po', 'internal_quote'].filter((t) => !present.has(t));
            if (missing.length === 0) return null;
            return (
              <div className="mt-4">
                <BuildDocsSupplement orderId={orderData.id} missing={missing} />
              </div>
            );
          })()}

          {/* 超期订单强制确认 — 只显示给负责业务或管理员 */}
          {(() => {
            if (customerShipHold) return null;
            const keyDate = orderData.incoterm === 'DDP'
              ? orderData.etd
              : (orderData.factory_date || orderData.etd);
            if (!keyDate || allMilestonesCompleted) return null;
            const daysOver = Math.ceil((Date.now() - new Date(keyDate + 'T23:59:59').getTime()) / 86400000);
            if (daysOver <= 0) return null;
            // 只显示给：订单创建者（业务）或管理员
            const isOrderOwner = user && (orderData.created_by === user.id || orderData.owner_user_id === user.id);
            if (!isOrderOwner && !isAdmin) return null;
            return (
              <OverdueOrderGate
                orderId={id}
                orderNo={orderData.order_no}
                customerName={orderData.customer_name}
                keyDate={keyDate}
                daysOverdue={daysOver}
                isAdmin={isAdmin}
              />
            );
          })()}

          {/* Tab 导航（移动端可横向滚动） */}
          <div className="flex gap-1 mt-4 -mb-px overflow-x-auto scrollbar-hide">
            {[
              // 精简为常用 8 个标签(用户 2026-07 拍板);其余隐藏、功能未删,仍可经 ?tab= URL 访问
              { key: 'basic', label: '基本信息' },
              { key: 'progress', label: `执行进度 ${overdueCount > 0 ? '🔴' : blockedCount > 0 ? '🟡' : ''}` },
              { key: 'manufacturing_order', label: '🏭 生产任务单' },
              { key: 'pi', label: '🧾 PI' },
              { key: 'bom', label: '原辅料和包装' },
              { key: 'procurement_items', label: '🛒 采购核料' },
              { key: 'procurement', label: '📦 采购进度' },
              { key: 'production', label: '生产进度' },
              { key: 'shipment', label: '🚢 出货单据' },
              { key: 'score', label: `执行评分 ${commissions && commissions.length > 0 ? '✓' : ''}` },
            // 经销/采购成品单(trade)买成品无原辅料 → 隐藏「采购核料」tab(生产任务单/原辅料和包装(含包装方式)/PI 等保留)
            ].filter(t => !((orderData as any).order_purpose === 'trade' && t.key === 'procurement_items')).map(t => (
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
          {/* AI 风险评估/缺失资料检查侧栏 + 经营卡(利润/收款/风险/确认链)已移除
              (2026-07-09 用户:减少不必要的 AI 介入)。财务事件时间线保留。 */}
          {canSeeFinancials && <FinanceEventsTimeline orderId={id} />}
          <div className="grid gap-6 md:grid-cols-2">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">基础信息</h2>
              <dl className="space-y-3">
                {[
                  { label: '订单号', value: orderData.order_no },
                  { label: '客户', value: orderData.customer_name },
                  { label: '客户PO号', value: orderData.po_number },
                  { label: '内部订单号', value: '__INLINE_EDIT__' },
                  { label: '负责业务/理单', value: ownerName },
                  { label: '贸易条款', value: ({ FOB: 'FOB', DDP: 'DDP', RMB_EX_TAX: '人民币不含税', RMB_INC_TAX: '人民币含税' } as any)[orderData.incoterm] || orderData.incoterm },
                  ...(orderData.incoterm === 'DDP' ? [
                    { label: 'ETD', value: formatDate(orderData.etd) },
                    { label: '到仓日期(ETA)', value: formatDate(orderData.warehouse_due_date) },
                  ] : []),
                  { label: '订单类型', value: ({ trial: '新品试单', bulk: '正常', repeat: '翻单', urgent: '加急订单', sample: '样品' } as Record<string,string>)[orderData.order_type] || orderData.order_type },
                  { label: '包装类型', value: orderData.packaging_type === 'standard' ? '标准' : '定制' },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between items-center">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">
                      {value === '__INLINE_EDIT__' ? (
                        <InlineEditField
                          orderId={id}
                          field="internal_order_no"
                          value={orderData.internal_order_no}
                          placeholder="点击填写"
                          locked={true}
                          lockedMessage="内部单号已填写，修改需要财务审批。请联系财务或管理员。"
                        />
                      ) : (value || '—')}
                    </dd>
                  </div>
                ))}
                {/* 跟单负责人 — 理单(业务执行)/ 生产跟单 两组分开(2026-07-10 派单分工):
                    业务执行由业务执行部主管(order_manager)派;生产跟单由生产主管派;admin 两者都可 */}
                <div className="flex justify-between items-center">
                  <dt className="text-sm text-gray-500">理单跟单</dt>
                  <dd className="text-sm font-medium">
                    {(isAdmin || currentRoles.includes('order_manager')) ? (
                      <MerchandiserAssign orderId={id} currentMerchandiserName={merchandiserName} kind="merchandiser" />
                    ) : (
                      <span className="text-gray-900">{merchandiserName || '未指定'}</span>
                    )}
                  </dd>
                </div>
                {/* 进度校准(2026-07-09 用户:真实订单之前没人推进→一片风险;admin/生产主管选实际节点,之前标完成清风险)*/}
                {(isAdmin || currentRoles.includes('production_manager')) && (milestones || []).length > 0 && (
                  <div className="flex justify-between items-center gap-2 flex-wrap">
                    <dt className="text-sm text-gray-500">进度校准</dt>
                    <OrderProgressCalibrate orderId={id} steps={(milestones as any[]).map((m: any) => ({ step_key: m.step_key, name: m.name }))} />
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <dt className="text-sm text-gray-500">生产跟单</dt>
                  <dd className="text-sm font-medium">
                    {(isAdmin || currentRoles.includes('production_manager')) ? (
                      <MerchandiserAssign orderId={id} currentMerchandiserName={productionFollowName} kind="production" />
                    ) : (
                      <span className="text-gray-900">{productionFollowName || '未指定'}</span>
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
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">{value || '—'}</dd>
                  </div>
                ))}
                {/* 工厂 — admin/生产主管可更换(2026-07-09 用户) */}
                <div className="flex justify-between items-center">
                  <dt className="text-sm text-gray-500">工厂</dt>
                  <dd className="text-sm font-medium text-gray-900">
                    {(isAdmin || currentRoles.includes('production_manager'))
                      ? <FactoryAssign orderId={id} currentFactoryName={orderData.factory_name} />
                      : (orderData.factory_name || '—')}
                  </dd>
                </div>
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

            {/* 订单资料 — 按节点分组展示，清晰看出每个附件属于哪个节点 */}
            <div className="md:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">📎 订单资料</h2>
              {(() => {
                const sensitiveTypes = ['customer_po', 'internal_quote', 'customer_quote'];
                // 价格文件权限：admin + 财务 + 业务部经理 + 订单创建者（业务）可以看，跟单/生产部不能看
                const canSeeSensitive = isAdmin || isOrderOwner || currentRoles.includes('finance') || currentRoles.includes('sales_manager');
                const visibleAttachments = attachments.filter((att: any) =>
                  !sensitiveTypes.includes(att.file_type) || canSeeSensitive
                );

                // file_type → 友好标签（覆盖 FILE_TYPE_BY_STEP 里所有节点）
                const typeLabels: Record<string, string> = {
                  // 订单级（无 milestone_id）
                  customer_po: '客户PO',
                  internal_quote: '内部成本核算单',
                  customer_quote: '客户报价单',
                  // 里程碑级
                  finance_approval: '财务审批',
                  kickoff_meeting: '订单评审纪要',
                  production_order: '生产制单',
                  bom: 'BOM',
                  trims_sheet: '原辅料单',
                  processing_fee_confirm: '加工费确认',
                  factory_confirm: '工厂确认书',
                  pre_production_sample: '产前样照片',
                  sample_shipping: '产前样快递',
                  customer_approval: '客户确认',
                  procurement_order: '采购单',
                  materials_inspection: '原辅料验收',
                  pre_production_meeting: '产前会纪要',
                  production_kickoff: '开裁通知',
                  qc_report: 'QC报告',
                  packing_requirement: '装箱要求',
                  shipping_sample: '船样',
                  factory_completion: '完工证明',
                  leftover_list: '剩余物料',
                  warehouse_receipt: '成品入库',
                  inspection_release: '验货放行',
                  booking_confirm: '订舱确认',
                  customs_doc: '报关单',
                  shipment_approval: '核准出运',
                  bill_of_lading: '提单',
                  payment_receipt: '收款凭证',
                  tech_pack: 'Tech Pack',
                  packing_list: '装箱单',
                  evidence: '凭证',
                };

                // 建立 milestone_id → {name, step_key, stageIdx} 查询表
                const msMap = new Map<string, { name: string; stepKey: string; order: number }>();
                (milestones || []).forEach((m: any, idx: number) => {
                  msMap.set(m.id, { name: m.name || m.step_key, stepKey: m.step_key, order: idx });
                });

                // 分组：order-level（无 milestone_id）+ 按 milestone 分组
                const orderLevel: any[] = [];
                const byMilestone = new Map<string, any[]>();
                for (const att of visibleAttachments) {
                  if (!att.milestone_id) {
                    orderLevel.push(att);
                  } else {
                    const arr = byMilestone.get(att.milestone_id) || [];
                    arr.push(att);
                    byMilestone.set(att.milestone_id, arr);
                  }
                }
                // milestones 按节点顺序排序
                const sortedMilestoneGroups = Array.from(byMilestone.entries()).sort((a, b) => {
                  const oa = msMap.get(a[0])?.order ?? 999;
                  const ob = msMap.get(b[0])?.order ?? 999;
                  return oa - ob;
                });

                if (visibleAttachments.length === 0) {
                  return <p className="text-sm text-gray-400 text-center py-4">暂无上传资料</p>;
                }

                const AttachmentCard = ({ att }: { att: any }) => {
                  const label = typeLabels[att.file_type] || att.file_type || '附件';
                  const sizeKB = att.file_size ? Math.round(att.file_size / 1024) : null;
                  const downloadUrl = att.file_url || (att.storage_path
                    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/order-docs/${att.storage_path}`
                    : null);
                  const ext = (att.file_name || '').split('.').pop()?.toLowerCase();
                  const canPreviewInBrowser = ['pdf','png','jpg','jpeg','gif','svg','webp','txt'].includes(ext || '');
                  const isOfficeFile = ['xlsx','xls','doc','docx','ppt','pptx'].includes(ext || '');
                  const canPreviewOnline = isOfficeFile || ['csv'].includes(ext || '');
                  const previewUrl = isOfficeFile
                    ? `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(downloadUrl || '')}`
                    : canPreviewOnline
                      ? `https://docs.google.com/gview?url=${encodeURIComponent(downloadUrl || '')}&embedded=true`
                      : downloadUrl;
                  return (
                    <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors">
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
                      {downloadUrl && (
                        <div className="flex gap-1.5 flex-shrink-0">
                          <a href={previewUrl || downloadUrl} target="_blank" rel="noopener noreferrer"
                             className="text-xs px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700">
                            {canPreviewInBrowser || canPreviewOnline ? '预览' : '查看'}
                          </a>
                          {(canPreviewOnline || !canPreviewInBrowser) && (
                            <a href={downloadUrl} download={att.file_name}
                               className="text-xs px-2.5 py-1.5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100">
                              下载
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  );
                };

                return (
                  <div className="space-y-5">
                    {/* 订单级附件（新建订单时上传的 PO/生产单/报价单等） */}
                    {orderLevel.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5">
                          <span className="w-1 h-3.5 rounded-sm bg-indigo-500" />
                          订单级附件
                        </p>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {orderLevel.map(att => <AttachmentCard key={att.id} att={att} />)}
                        </div>
                      </div>
                    )}
                    {/* 按节点分组 */}
                    {sortedMilestoneGroups.map(([msId, files]) => {
                      const ms = msMap.get(msId);
                      return (
                        <div key={msId}>
                          <p className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5">
                            <span className="w-1 h-3.5 rounded-sm bg-blue-500" />
                            <span>{ms?.name || '未知节点'}</span>
                            <span className="text-gray-400 font-normal">({files.length} 个文件)</span>
                          </p>
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {files.map(att => <AttachmentCard key={att.id} att={att} />)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
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

          {/* 客户加单(增量明细,走改单审批,批准后同步采购/财务/生产) */}
          <div className="mt-6 flex flex-wrap items-start gap-3">
            <CustomerAddOrderPanel orderId={orderData.id} canSeeFin={canSeeFinancials} />
            {/* 多PO合单:按来源PO取消/减量(仅多PO单渲染) */}
            <PerPoOperationsPanel orderId={orderData.id} />
          </div>

          {/* 订单修改申请 */}
          <div className="mt-6">
            <OrderAmendmentPanel
              orderId={orderData.id}
              order={orderData}
              isAdmin={isAdmin}
              canApprove={isAdmin || currentRoles.some((r) => ['order_manager', 'sales_manager'].includes(r))}
              doneStepKeys={(milestones || []).filter((m: any) => isDoneStatus(m.status)).map((m: any) => m.step_key)}
            />
            {/* 受控数量修正(方案 C):读错/套装漏算就地改,仅经理级 */}
            {(isAdmin || currentRoles.some((r) => ['order_manager', 'sales_manager'].includes(r))) && (
              <div className="mt-3">
                <QuantityCorrectionButton orderId={orderData.id} currentQty={orderData.quantity} />
              </div>
            )}
          </div>

          {/* 决策评审面板（仅 admin + 引擎启用） */}
          {isAdmin && businessDecisionEngineEnabled() && (
            <div className="mt-6">
              <OrderDecisionPanel orderId={id} isAdmin={isAdmin} />
            </div>
          )}
          </>
        )}

        {/* Tab: 报价基线 —— 2026-07-08 已弃用(报价单布料名对不上采购)。预算/成本真相并入「🛒 采购核料」逐料填。 */}

        {/* Tab: 执行进度 */}
        {activeTab === 'progress' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">执行时间线</h2>
            {milestones && milestones.length > 0 ? (
              <OrderTimeline
                milestones={milestones}
                orderId={id}
                orderNo={orderData.order_no}
                orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'}
                isSplitShipment={Boolean(orderData.is_split_shipment)}
                currentRole={currentRole}
                currentRoles={currentRoles}
                currentUserId={user.id}
                isAdmin={isAdmin}
                inspectionWaived={isInspectionWaived(orderData)}
              />
            ) : (
              <p className="text-gray-400 text-center py-8">暂无执行节点数据</p>
            )}
          </div>
        )}

        {/* Tab: 延期申请 */}
        {activeTab === 'delays' && (
          <div id="delay-approve" className="bg-white rounded-xl border border-amber-300 ring-2 ring-amber-100 p-6 scroll-mt-24">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">延期申请记录</h2>
            {delayRequests && delayRequests.length > 0 ? (
              <DelayRequestsList
                delayRequests={delayRequests}
                orderId={id}
                // 业务部经理与 admin 同样可审批延期（按钮显隐；服务端 delays.ts 已按 CAN_APPROVE_DELAY 兜底校验）
                isAdmin={isAdmin || currentRoles.some((r) => ['sales_manager', 'order_manager'].includes(r))}
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
        {/* Tab: 原辅料和包装 —— BOM 录入是主体(喂 MRP/采购核料/生产任务单用料),文件只是佐证 */}
        {activeTab === 'bom' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">📋 原辅料和包装资料</h2>
            {/* BOM 结构化录入(2026-07-02 从底部折叠区提到顶部展开:业务找不到入口,以为没法填) */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">🧾 原辅料清单（BOM 录入 / 客户标准库带入）</h3>
              <p className="text-xs text-gray-400 mb-3">在这里录面料/辅料/包装的单耗,是采购核料和生产任务单「用料」的数据源。</p>
              <BomTab orderId={id} />
            </div>
            {/* 「包装资料/原辅料单(文件)」两块已移除(2026-07-08):空状态指向已删除的「生产单上传」节点;
                历史文件仍可在「基本信息」tab 附件列表查看,不丢失。 */}
          </div>
        )}
        {/* Tab: 生产任务单（Manufacturing Order）*/}
        {activeTab === 'manufacturing_order' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">🏭 生产任务单</h2>
            {/* 尺码表(2026-07-08:改在「原辅料和包装」页上传,这里直读展示) */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-600 mb-2">📐 尺码表</h3>
              <PackingFilesSection orderId={id} fileTypes={['size_chart']} emptyText="暂无尺码表;请到「原辅料和包装」页上传(建单不再传尺码表)" />
            </div>
            <ManufacturingOrderTab orderId={id} />
          </div>
        )}
        {/* Tab: PI 形式发票(2026-07-09:从生产单+客户PO价+交期生成,业务改/预览/下载)*/}
        {activeTab === 'pi' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <PITab orderId={id} />
          </div>
        )}
        {/* Tab: 产品款（Order Line ↔ Product Variant)*/}
        {activeTab === 'product_link' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">🧬 产品款关联</h2>
            <ProductVariantPicker orderId={id} />
          </div>
        )}
        {/* Tab: 采购核料（Procurement Items）*/}
        {activeTab === 'procurement_items' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-gray-900">🛒 采购核料</h2>
              {/* 2026-07-06 用户拍板:采购在采购中心核料;业务在此只读看进度 */}
              <Link href={`/procurement/verify/${id}`} className="text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50">
                🛒 去采购中心核料 →
              </Link>
            </div>
            {isAdmin ? (
              <>
                <p className="text-xs text-gray-400 mb-4">采购请到「采购中心 → 该订单核料页」核定/归并/下单;此处仅管理员可编。</p>
                <ProcurementItemsTab orderId={id} internalOrderNo={orderData.internal_order_no} />
              </>
            ) : canEnterBudget ? (
              // 2026-07-08 用户:采购核料 tab 专做「核料/预算录入」——业务按采购真实物料逐料手填预算
              //   (面料预算单价 + 逐款加工费/辅料);采购的核定/归并/下单在采购中心(右上链接)。
              //   供应链概览/采购进度已在「采购进度」tab,这里不再重复塞。
              <BomBudgetEntry orderId={id} />
            ) : (
              // 无价角色(生产/QC/物流等):不展示预算金额,引导去只读的采购进度(修 P2 价格泄露)
              <p className="text-sm text-gray-400">此页为预算/成本录入(含金额),你的角色无需在此操作。采购到货进度请看「📦 采购进度」tab。</p>
            )}
          </div>
        )}

        {/* Tab: 生产进度 */}
        {activeTab === 'production' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-gray-900">生产进度</h2>
              {/* 2026-07-06 用户拍板:生产/QC 在生产中心走节点,订单详情对业务只读展示 */}
              <Link href={`/production/order/${id}`} className="text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50">
                🏭 生产/QC 去生产中心走节点 →
              </Link>
            </div>
            <p className="text-xs text-gray-400 mb-4">本页对业务只读展示进度;生产/QC 请到「生产中心」点该订单走节点、传报告。</p>
            {/* 「📄 生产订单(文件)」块已移除(2026-07-08):其空状态指向已删除的「生产单上传」节点。 */}
            <ProductionProgressTab
              orderId={id}
              orderNo={orderData.order_no}
              isAdmin={isAdmin}
              canReport={isAdmin}
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
              canViewPriceDocs={isAdmin || currentRoles.includes('finance') || isOrderOwner}
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

        {/* Tab: 成本控制 —— 2026-07-08 已弃用,并入「📋 报价基线」(逐款成本单一真相)。旧 URL(?tab=cost_control)回退到报价基线。 */}

        {/* Tab: 采购进度（共享表 + 对账） */}
        {activeTab === 'procurement' && (
          <div className="space-y-4">
            {/* 真实采购执行进度(实时投影,采购在采购中心下单/催货/收货即刻反映;单一真相)*/}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <SupplyChainTab orderId={id} />
            </div>
            {/* 手工协作备注(非实时·仅补充说明,默认收起;真实进度以上方为准)*/}
            <details className="bg-white rounded-xl border border-gray-200 p-4 group">
              <summary className="cursor-pointer text-sm font-medium text-gray-600 select-none">
                📝 手工协作备注（非实时·仅补充说明,点开展开）
              </summary>
              <div className="mt-4">
                <ProcurementTrackingTab
                  orderId={id}
                  canEdit={currentRoles.some(r => ['sales', 'merchandiser', 'procurement', 'admin', 'production_manager'].includes(r))}
                  canApprove={currentRoles.some(r => ['sales', 'merchandiser', 'admin', 'finance'].includes(r))}
                />
              </div>
            </details>
            {/* 采购对账 */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">采购对账</h2>
            <p className="text-xs text-gray-500 mb-5">
              采购下单时录入订购数据，原辅料到货时录入实收数量。系统自动计算差异，差异 &gt; 3% 标红。导出 Excel 给财务发给供应商对账。
            </p>
            <ProcurementTab
              orderId={id}
              isAdmin={isAdmin}
              canEdit={isAdmin || currentRoles.some(r => ['sales', 'merchandiser', 'procurement', 'production_manager'].includes(r))}
              canRecordReceipt={isAdmin || currentRoles.some(r => ['merchandiser'].includes(r))}
            />
          </div>
          </div>
        )}

        {/* Tab: 供应链概览（Phase 1 — 只读归集，不改采购主流程） */}
        {activeTab === 'supply_chain' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <SupplyChainTab orderId={id} />
          </div>
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

        {activeTab === 'retrospective' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <RetrospectiveTab
              orderId={id}
              orderNo={orderData.order_no}
              isOwnerOrAdmin={isAdmin || isOrderOwner}
            />
          </div>
        )}

        {activeTab === 'root_causes' && isAdmin && rootCauseEngineEnabled() && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <RootCausesPanel orderId={id} isAdmin={isAdmin} />
          </div>
        )}

      </div>
    </div>
  );
}
