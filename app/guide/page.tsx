import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
import { SOP_MAP } from '@/lib/domain/sop';
import { getRoleLabel } from '@/lib/utils/i18n';

const STAGE_NAMES: Record<string, string> = {
  stage1: '阶段 1：订单启动',
  stage2: '阶段 2：订单转化',
  stage3: '阶段 3：产前样',
  stage4: '阶段 4：采购与生产',
  stage5: '阶段 5：过程控制',
  stage6: '阶段 6：出货控制',
  stage7: '阶段 7：物流收款',
};

const STAGE_KEYS: Record<string, string[]> = {
  stage1: ['po_confirmed', 'finance_approval', 'production_order_upload', 'production_resources_confirmed'],
  stage2: ['order_docs_bom_complete', 'bulk_materials_confirmed'],
  stage3: ['pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'],
  stage4: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'],
  stage5: ['mid_qc_check', 'final_qc_check'],
  stage6: ['packing_method_confirmed', 'inspection_release', 'shipping_sample_send'],
  stage7: ['booking_done', 'customs_export', 'payment_received'],
};

export default function GuidePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* 标题 */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">操作说明</h1>
        <p className="text-sm text-gray-500 mt-1">订单节拍器系统使用指南</p>
      </div>

      {/* 快速入门 */}
      <section className="section mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">快速入门</h2>
        <div className="space-y-3">
          {[
            { step: '1', title: '登录系统', desc: '使用 @qimoclothing.com 邮箱登录，首次需注册并等待管理员授权角色' },
            { step: '2', title: '查看我的节拍', desc: '登录后自动进入"我的节拍"页面，显示今日待处理、超期、阻塞的节点' },
            { step: '3', title: '处理节点', desc: '点击节点的"处理 →"按钮，按 SOP 指引完成操作，上传凭证后标记完成' },
            { step: '4', title: '遇到问题', desc: '如果节点被阻塞，标记"阻塞"并填写原因；如需延期，提交延期申请等待审批' },
          ].map(item => (
            <div key={item.step} className="flex gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 font-bold text-sm flex items-center justify-center">{item.step}</span>
              <div>
                <p className="text-sm font-medium text-gray-900">{item.title}</p>
                <p className="text-sm text-gray-500">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 角色说明 */}
      <section className="section mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">角色与权限</h2>
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <table className="table-modern">
            <thead>
              <tr>
                <th>角色</th>
                <th>职责</th>
                <th>可操作节点</th>
              </tr>
            </thead>
            <tbody>
              {[
                { role: 'sales', desc: '全流程订单跟进，客户沟通，凭证上传', nodes: 'PO确认、生产单上传、BOM、产前样寄出/确认、包装确认、船样' },
                { role: 'finance', desc: '财务审核，成本复盘，出货第三签', nodes: '财务审核、收款确认' },
                { role: 'procurement', desc: '原辅料确认，采购下单', nodes: '大货原辅料确认、采购下单+ETA' },
                { role: 'production', desc: '生产排期，开裁，产前会', nodes: '生产资源确认、产前样完成、生产排期+开裁、产前会' },
                { role: 'qc', desc: '中查、尾查、验货放行', nodes: '中查、尾查、验货/放行' },
                { role: 'logistics', desc: '物料验收，订舱，报关出运', nodes: '物料到位验收、订舱、报关+出运' },
              ].map(item => (
                <tr key={item.role}>
                  <td><span className="font-medium text-gray-900">{getRoleLabel(item.role) || item.role}</span></td>
                  <td><span className="text-sm text-gray-600">{item.desc}</span></td>
                  <td><span className="text-xs text-gray-500">{item.nodes}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 节点状态说明 */}
      <section className="section mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">节点状态说明</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { status: '未开始', desc: '等待前置节点完成', color: 'bg-gray-100 text-gray-600', dot: 'bg-gray-300' },
            { status: '进行中', desc: '当前可操作，需要处理', color: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
            { status: '已完成', desc: '已完成并上传凭证', color: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
            { status: '阻塞', desc: '遇到问题暂停', color: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
          ].map(item => (
            <div key={item.status} className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2.5 h-2.5 rounded-full ${item.dot}`} />
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${item.color}`}>{item.status}</span>
              </div>
              <p className="text-xs text-gray-500">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* KPI 说明 */}
      <section className="section mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">KPI 考核说明</h2>
        <div className="bg-indigo-50 rounded-xl p-5 space-y-3">
          <div className="flex items-start gap-3">
            <span className="text-lg">📊</span>
            <div>
              <p className="text-sm font-medium text-gray-900">准时率</p>
              <p className="text-xs text-gray-600">节点在截止日期前完成 = 准时。准时率 = 准时完成数 / 总完成数 × 100%</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-lg">⏰</span>
            <div>
              <p className="text-sm font-medium text-gray-900">超期节点</p>
              <p className="text-xs text-gray-600">未完成且已过截止日期的节点，需要立即处理或申请延期</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-lg">🚧</span>
            <div>
              <p className="text-sm font-medium text-gray-900">阻塞节点</p>
              <p className="text-xs text-gray-600">标记为阻塞的节点，需要填写原因并尽快解决</p>
            </div>
          </div>
        </div>
      </section>

      {/* 操作流程（按阶段展示 SOP） */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">操作流程 & SOP</h2>
        <div className="space-y-4">
          {Object.entries(STAGE_KEYS).map(([stageKey, stepKeys]) => {
            const stageNodes = stepKeys
              .map(sk => MILESTONE_TEMPLATE_V1.find(m => m.step_key === sk))
              .filter(Boolean) as typeof MILESTONE_TEMPLATE_V1;

            return (
              <details key={stageKey} className="rounded-xl border border-gray-200 overflow-hidden">
                <summary className="px-5 py-3 bg-gray-50 cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-100">
                  {STAGE_NAMES[stageKey]} ({stageNodes.length} 个节点)
                </summary>
                <div className="divide-y divide-gray-100">
                  {stageNodes.map(node => {
                    const sop = SOP_MAP[node.step_key];
                    return (
                      <div key={node.step_key} className="px-5 py-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm font-medium text-gray-900">{node.name}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{getRoleLabel(node.owner_role) || node.owner_role}</span>
                          {node.is_critical && <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600">关键</span>}
                        </div>
                        <p className="text-xs text-gray-500 mb-2">时限：{node.deadline_hint} · 凭证：{node.evidence_note}</p>

                        {sop && (
                          <div className="bg-indigo-50/50 rounded-lg p-3 mt-2 space-y-2">
                            <p className="text-xs font-semibold text-indigo-800">{sop.sop_title}</p>
                            <div className="text-xs text-indigo-700 space-y-0.5">
                              {sop.sop_steps.map((step, i) => (
                                <p key={i}>{step}</p>
                              ))}
                            </div>
                            <div className="border-t border-indigo-200 pt-2 mt-2">
                              <p className="text-xs font-semibold text-indigo-800 mb-1">完成标准：</p>
                              {sop.completion_rules.map((rule, i) => (
                                <p key={i} className="text-xs text-indigo-600">☑ {rule}</p>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      {/* 常见问题 */}
      <section className="section">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">常见问题</h2>
        <div className="space-y-3">
          {[
            { q: '我看不到某些节点怎么办？', a: '你只能看到和操作与你角色匹配的节点。如需操作其他角色节点，请联系管理员调整角色。' },
            { q: '节点超期了怎么办？', a: '如果确实无法按期完成，请通过节点的"申请延期"功能提交延期申请，填写原因等待审批。' },
            { q: '如何标记节点完成？', a: '点击节点的"处理 →"展开操作区，先上传凭证，再点击"标记完成"按钮。' },
            { q: '一个人可以有多个角色吗？', a: '可以。管理员在"用户管理"页面可以为你分配多个角色（如理单+采购）。' },
            { q: '备忘录的提醒在哪里看？', a: '在"我的节拍"页面底部会显示到期的备忘提醒，也可以在"备忘录"页面管理所有备忘。' },
          ].map((faq, i) => (
            <details key={i} className="rounded-lg border border-gray-200 overflow-hidden">
              <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-gray-900 hover:bg-gray-50">
                {faq.q}
              </summary>
              <p className="px-4 py-3 text-sm text-gray-600 bg-gray-50 border-t border-gray-200">{faq.a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
