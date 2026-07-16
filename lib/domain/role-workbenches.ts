export type CanonicalWorkbench = 'business_development' | 'business_execution' | 'production_manager' | 'production_follow_up_qc' | 'procurement' | 'logistics' | 'finance';

export const ROLE_WORKBENCH_QUEUES: Record<CanonicalWorkbench, readonly string[]> = {
  business_development: ['新客户开发', '报价待处理', '样衣待跟进', 'PO 待确认', 'PO 待交接', '客户商业变更', '客户异常'],
  business_execution: ['新交接 PO', '待 AI 识别/待建单', '订单资料缺失', '待客户确认', '采购协调', '生产协调', '客户交期异常', '出货准备', '物流协调', '待关闭订单', '跨部门异常'],
  production_manager: ['待接收生产需求', '待定工厂', '待排单', '待分配生产跟单/QC', '工厂产能冲突', '待调整排单', '待审批生产延期', '今日应开裁', '今日应上线', 'QC 重大异常', '已超期'],
  production_follow_up_qc: ['新分配订单', '工厂待确认沟通', '待物料齐套', '待开裁', '待上线', '生产中待更新', '待首件', '待中查', '待尾查', '待复检', '待整改确认', '待包装', '待完工', '待出货跟进', '已超期未更新'],
  procurement: ['待核料', '待询价', '待供应商确认', '待下单', '待催货', '待到料', '缺料异常', '质量异常'],
  logistics: ['待出货准备', '待 QC 放行', '待财务条件', '待订舱', '待装箱', '待出库', '待物流凭证', '异常出货'],
  finance: ['待订单审核', '待收款', '待付款', '待成本核算', '待对账', '待结算', '财务异常'],
};

export function workbenchesForRoles(roles: string[]): CanonicalWorkbench[] {
  const result = new Set<CanonicalWorkbench>();
  for (const role of roles) {
    if (role === 'sales' || role === 'sales_manager') result.add('business_development');
    if (role === 'merchandiser' || role === 'order_manager') result.add('business_execution');
    if (role === 'production_manager') result.add('production_manager');
    if (role === 'production' || role === 'qc' || role === 'quality') result.add('production_follow_up_qc');
    if (role === 'procurement' || role === 'procurement_manager') result.add('procurement');
    if (role === 'logistics') result.add('logistics');
    if (role === 'finance') result.add('finance');
  }
  return [...result];
}
