import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
import { SOP_MAP } from '@/lib/domain/sop';
import { getRoleLabel } from '@/lib/utils/i18n';

/* ── 阶段定义（与 milestone template 完全对应） ── */
const STAGE_NAMES: Record<string, string> = {
  stage1: '阶段 1：订单评审',
  stage2: '阶段 2：预评估',
  stage3: '阶段 3：工厂匹配 & 产前样',
  stage4: '阶段 4：采购与生产',
  stage5: '阶段 5：过程控制',
  stage6: '阶段 6：出货控制',
  stage7: '阶段 7：物流收款',
};

const STAGE_KEYS: Record<string, string[]> = {
  stage1: ['po_confirmed', 'finance_approval', 'order_kickoff_meeting', 'production_order_upload'],
  stage2: ['order_docs_bom_complete', 'bulk_materials_confirmed'],
  stage3: ['processing_fee_confirmed', 'factory_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'],
  stage4: ['procurement_order_placed', 'materials_received_inspected', 'pre_production_meeting', 'production_kickoff'],
  stage5: ['mid_qc_check', 'final_qc_check'],
  stage6: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'],
  stage7: ['booking_done', 'customs_export', 'finance_shipment_approval', 'shipment_execute', 'payment_received'],
};

/* ── 角色每日 SOP ── */
const ROLE_DAILY_SOPS = [
  {
    role: 'sales',
    label: '业务',
    color: 'indigo',
    responsibilities: '客户沟通、PO确认、生产单制作、辅料单/BOM、大货原辅料确认、产前样寄出/客户确认、包装确认、船样、订舱、报关安排出运',
    milestones: ['PO确认', '订单启动会', '生产单上传', '订单资料/BOM齐全', '大货原辅料确认', '产前样寄出', '产前样客户确认', '包装方式业务确认', '船样寄送', '订舱完成', '报关安排出运'],
    dailySteps: [
      '打开"我的工作台"，查看今日到期和超期节点（业务节点最多，优先处理红色超期）',
      '订单启动阶段 — 上传生产单、整理 BOM/原辅料单',
      '产前样阶段 — 验收产前样、安排寄送、跟进客户确认',
      '生产阶段 — 原辅料到货后进行验收确认，跟进订单进度和品质',
      '出货阶段 — 确认包装方式、验收/寄送船样、联系货代订舱、准备报关资料',
      '报关放行后跟进装柜出运，获取提单并上传',
    ],
    tips: [
      '业务是节点最多的角色，建议每天上下午各检查一次工作台',
      '产前样寄出后建议在备忘录设置提醒跟进客户确认',
      '订舱需上传 Booking Confirmation，报关需上传提单和报关单',
      'FOB 订单：ETD 前 5 天完成订舱；DDP 订单：ETD 前 21 天完成订舱',
      '如客户反馈延迟，及时在对应节点提交延期申请',
    ],
  },
  {
    role: 'merchandiser',
    label: '跟单',
    color: 'purple',
    responsibilities: '封样与确认工厂、产前样准备、原辅料到货验收、产前会、生产启动/开裁、中查尾查、工厂完成、验货放行',
    milestones: ['封样与确认工厂', '产前样准备完成', '原辅料到货验收', '产前会', '生产启动/开裁', '中查', '尾查', '工厂完成', '验货/放行'],
    dailySteps: [
      '打开"我的工作台"，查看今日到期和超期节点',
      '产前样阶段 — 协调工厂安排产前样，跟进制作进度',
      '确认工厂 — 评估工厂报价和产能，确认后上传工厂确认书',
      '生产阶段 — 跟进生产进度，录入开裁日期，召开产前会',
      '质检阶段 — 安排中查（生产 30-50%）和尾查（ETD-7 天），上传检验报告',
      '出货阶段 — 确认工厂完成，安排验货，PASS 后标记放行',
    ],
    tips: [
      '中查建议在生产完成 30-50% 时安排',
      '尾查建议在 ETD 前 7 天完成，按 AQL 标准执行',
      '验货/放行需上传第三方验货报告或放行单',
      '发现严重质量问题需立即通知业务和管理员',
    ],
  },
  {
    role: 'finance',
    label: '财务',
    color: 'green',
    responsibilities: 'PO 审核、加工费目标价确认、核准出运、收款',
    milestones: ['财务审核', '加工费目标价确认', '核准出运', '收款完成'],
    dailySteps: [
      '打开"我的工作台"，查看待处理的财务节点',
      '收到 PO 后进行审核 — 确认金额、付款条件、利润空间（审核通过时必须填写内部订单号）',
      '审核原辅料采购成本和货代费用',
      '加工费到位后核对并上传确认函',
      '出货后跟进客户尾款，收款确认后标记完成并给出出货许可',
    ],
    tips: [
      '财务审核直接影响后续所有节点启动，请优先处理',
      '加工费确认需上传确认函作为凭证',
      '收款完成是订单最后一个节点，确认后订单进入复盘阶段',
    ],
  },
  {
    role: 'procurement',
    label: '采购',
    color: 'amber',
    responsibilities: '面辅料采购、供应商跟进、采购订单下达',
    milestones: ['采购订单下达'],
    dailySteps: [
      '打开"我的工作台"，查看待处理的采购节点',
      '对比 PO 和原辅料订单，审核物料规格和数量',
      '与供应商进行价格对比谈判，整理采购计划',
      '下达采购订单并获取供应商确认',
      '跟进采购进度和供应商交期，确认大货原辅料品质',
      '如 ETA 晚于排期，立即标记阻塞并通知业务',
    ],
    tips: [
      '原辅料确认需上传供应商确认记录和品质确认文件',
      '采购下单需上传采购订单截图和供应商确认回执',
      '高风险物料（高弹面料、浅色、大码）需特别关注品质',
    ],
  },
  {
    role: 'logistics',
    label: '物流/仓库',
    color: 'sky',
    responsibilities: '出货装柜、运输安排、出运执行',
    milestones: ['出运'],
    dailySteps: [
      '关注业务发起的订舱和报关节点进度',
      '财务核准出运后，协调装柜、拍摄装柜照片',
      '确认柜号、铅封号，获取提单',
      '上传装柜照片和提单，标记出运完成',
    ],
    tips: [
      '装柜照片需拍摄：空柜、装货过程、满柜、封柜',
      '出运完成后需上传提单作为凭证',
      '如遇运输异常，及时通知业务和管理员',
    ],
  },
  {
    role: 'admin',
    label: '管理员',
    color: 'slate',
    responsibilities: '全局监控、延期审批、催办推进、用户角色管理',
    milestones: ['可操作所有节点'],
    dailySteps: [
      '打开"我的节拍"（管理员首页），查看全局异常概览',
      '处理红色超期节点 — 点击"催办"发送邮件提醒负责人',
      '审批待处理的延期申请 — 审批通过后系统自动重算排期',
      '关注阻塞节点 — 了解原因，协调资源推动解决',
      '如有新员工，在"用户管理"中分配角色',
    ],
    tips: [
      '催办限制：同一节点 1 小时内只能催办 1 次',
      '延期审批后系统会自动重算下游节点时间',
      '用户管理中可为同一人分配多个角色',
    ],
  },
];

export default function GuidePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* 标题 */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">操作说明 & SOP</h1>
        <p className="text-sm text-gray-500 mt-1">订单节拍器系统 — 员工操作手册</p>
      </div>

      {/* 目录导航 */}
      <nav className="mb-8 rounded-xl border border-gray-200 p-4 bg-gray-50/50">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">快速导航</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          {[
            { href: '#quickstart', label: '快速入门' },
            { href: '#daily', label: '每日工作流' },
            { href: '#roles', label: '角色 SOP' },
            { href: '#status', label: '节点状态' },
            { href: '#operations', label: '常用操作' },
            { href: '#milestones', label: '全部节点 SOP' },
            { href: '#kpi', label: 'KPI 说明' },
            { href: '#updates', label: 'v3.2 更新' },
            { href: '#faq', label: '常见问题' },
          ].map(item => (
            <a key={item.href} href={item.href} className="px-3 py-2 rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200 transition-all text-center font-medium">
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      {/* ====== 1. 快速入门 ====== */}
      <section id="quickstart" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">1</span>
          快速入门（首次使用必读）
        </h2>
        <div className="space-y-3">
          {[
            { step: '1', title: '登录系统', desc: '使用 @qimoclothing.com 公司邮箱登录。首次需点击"注册"创建账号，等待管理员分配角色后即可使用。', emphasis: '忘记密码可点击"忘记密码"通过邮箱重置。' },
            { step: '2', title: '进入工作台', desc: '登录后自动进入"我的工作台"页面。这里只显示需要你处理的异常：超期节点、今日到期、被阻塞的节点。', emphasis: '没有待办 = 一切正常，无需操作。' },
            { step: '3', title: '处理节点', desc: '点击节点展开详情，点击"处理"按钮。如果节点要求上传凭证（蓝色标记），需先上传文件，再点击"标记完成"。', emphasis: '不确定怎么做？点击节点旁的"SOP"按钮查看操作规程。' },
            { step: '4', title: '遇到问题', desc: '节点被卡住无法推进 → 点击"标记阻塞"并填写原因。需要延期 → 点击"申请延期"提交申请，等管理员审批。', emphasis: '所有操作都有记录，放心点击不会出错。' },
          ].map(item => (
            <div key={item.step} className="flex gap-3 p-3 rounded-xl bg-white border border-gray-100">
              <span className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600 text-white font-bold text-sm flex items-center justify-center">{item.step}</span>
              <div>
                <p className="text-sm font-semibold text-gray-900">{item.title}</p>
                <p className="text-sm text-gray-600 mt-0.5">{item.desc}</p>
                <p className="text-xs text-indigo-600 mt-1 font-medium">{item.emphasis}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ====== 2. 每日工作流程 ====== */}
      <section id="daily" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">2</span>
          每日工作流程
        </h2>
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-indigo-50 px-5 py-3">
            <p className="text-sm font-semibold text-indigo-800">每天上班后，按以下顺序操作：</p>
          </div>
          <div className="p-5 space-y-4">
            {[
              { time: '上班后', action: '登录系统 → 进入"我的工作台"', detail: '查看是否有超期（红色）、今日到期（蓝色）、阻塞（橙色）节点' },
              { time: '优先级 1', action: '处理红色超期节点', detail: '已经超过截止日期的节点。立即完成操作，或提交延期申请说明原因' },
              { time: '优先级 2', action: '处理蓝色今日到期节点', detail: '今天必须完成的节点。按 SOP 操作，上传凭证，标记完成' },
              { time: '优先级 3', action: '处理橙色阻塞节点', detail: '之前标记阻塞的节点，如果问题已解决，点击"解除阻塞"恢复推进' },
              { time: '随时', action: '查看通知铃铛', detail: '右上角铃铛会提示新的催办、延期审批结果等系统通知' },
            ].map((item, i) => (
              <div key={i} className="flex gap-3">
                <div className="flex-shrink-0 w-20">
                  <span className={`text-xs font-bold px-2 py-1 rounded-md ${
                    i === 0 ? 'bg-gray-100 text-gray-700' :
                    i === 1 ? 'bg-red-100 text-red-700' :
                    i === 2 ? 'bg-blue-100 text-blue-700' :
                    i === 3 ? 'bg-orange-100 text-orange-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{item.time}</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">{item.action}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ====== 3. 各角色 SOP ====== */}
      <section id="roles" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">3</span>
          各角色操作 SOP
        </h2>
        <p className="text-sm text-gray-500 mb-4">找到你的角色，了解你负责哪些节点以及每天该做什么。</p>
        <div className="space-y-3">
          {ROLE_DAILY_SOPS.map(role => (
            <details key={role.role} className="rounded-xl border border-gray-200 overflow-hidden group">
              <summary className="px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full bg-${role.color}-100 text-${role.color}-700`}>
                      {role.label}
                    </span>
                    <span className="text-sm font-medium text-gray-900">{role.responsibilities}</span>
                  </div>
                </div>
              </summary>
              <div className="border-t border-gray-200 px-5 py-4 space-y-4 bg-gray-50/30">
                {/* 负责节点 */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">负责节点</p>
                  <div className="flex flex-wrap gap-1.5">
                    {role.milestones.map(m => (
                      <span key={m} className="text-xs px-2 py-1 rounded-md bg-white border border-gray-200 text-gray-700">{m}</span>
                    ))}
                  </div>
                </div>
                {/* 每日步骤 */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">每日操作步骤</p>
                  <div className="space-y-2">
                    {role.dailySteps.map((step, i) => (
                      <div key={i} className="flex gap-2 text-sm text-gray-700">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs font-bold flex items-center justify-center">{i + 1}</span>
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* 注意事项 */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">注意事项</p>
                  <div className="space-y-1.5">
                    {role.tips.map((tip, i) => (
                      <p key={i} className="text-xs text-gray-600 flex gap-2">
                        <span className="text-amber-500 flex-shrink-0">*</span>
                        {tip}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </details>
          ))}
        </div>
      </section>

      {/* ====== 4. 节点状态说明 ====== */}
      <section id="status" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">4</span>
          节点状态说明
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { status: '未开始', desc: '排在前面的节点还没完成，暂时不需要操作', color: 'bg-gray-100 text-gray-600', dot: 'bg-gray-300', action: '等待' },
            { status: '进行中', desc: '轮到你了！需要按 SOP 操作并完成', color: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500', action: '去处理' },
            { status: '已完成', desc: '操作完成，凭证已上传', color: 'bg-green-100 text-green-700', dot: 'bg-green-500', action: '无' },
            { status: '阻塞', desc: '遇到问题暂停，需要填写原因', color: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500', action: '解决后解除' },
          ].map(item => (
            <div key={item.status} className="rounded-xl border border-gray-200 p-4 bg-white">
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2.5 h-2.5 rounded-full ${item.dot}`} />
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${item.color}`}>{item.status}</span>
              </div>
              <p className="text-xs text-gray-500 mb-2">{item.desc}</p>
              <p className="text-xs font-medium text-gray-700">操作：{item.action}</p>
            </div>
          ))}
        </div>

        {/* 状态流转图 */}
        <div className="mt-4 rounded-xl border border-gray-200 p-4 bg-white">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">状态流转</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
            <span className="px-2 py-1 rounded bg-gray-100">未开始</span>
            <span className="text-gray-400">&rarr;</span>
            <span className="px-2 py-1 rounded bg-blue-100 text-blue-700">进行中</span>
            <span className="text-gray-400">&rarr;</span>
            <span className="px-2 py-1 rounded bg-green-100 text-green-700">已完成</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 mt-2">
            <span className="px-2 py-1 rounded bg-blue-100 text-blue-700">进行中</span>
            <span className="text-gray-400">&harr;</span>
            <span className="px-2 py-1 rounded bg-orange-100 text-orange-700">阻塞</span>
            <span className="text-xs text-gray-500 ml-2">（阻塞解除后回到进行中）</span>
          </div>
          <p className="text-xs text-gray-500 mt-3">* 前一个节点标记完成后，下一个节点会自动变为"进行中"</p>
        </div>
      </section>

      {/* ====== 5. 常用操作指南 ====== */}
      <section id="operations" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">5</span>
          常用操作指南
        </h2>
        <div className="space-y-3">

          {/* 标记完成 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何标记节点完成？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 进入<strong>订单列表</strong> &rarr; 点击对应订单 &rarr; 切换到<strong>"进度"</strong>标签页</p>
                <p>2. 找到你要处理的节点（蓝色"进行中"状态），点击展开</p>
                <p>3. 如果节点标记了<strong>蓝色"需要凭证"</strong>，先在上传区域上传文件</p>
                <p>4. 点击<strong>"标记完成"</strong>按钮</p>
                <p>5. 系统会自动将下一个节点设为"进行中"</p>
              </div>
              <div className="bg-amber-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-amber-800 font-medium">注意：如果节点要求凭证但未上传，系统会阻止标记完成。</p>
              </div>
            </div>
          </details>

          {/* 标记阻塞 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何标记节点阻塞？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 进入订单详情 &rarr; "进度"标签页 &rarr; 找到对应节点</p>
                <p>2. 点击<strong>"标记阻塞"</strong>按钮</p>
                <p>3. <strong>必须填写阻塞原因</strong>（例如：客户未回复确认、面料缺货等）</p>
                <p>4. 阻塞的节点会显示为橙色，管理员和相关人员可以在工作台看到</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-blue-800 font-medium">问题解决后，在工作台或节点详情点击"解除阻塞"即可恢复。</p>
              </div>
            </div>
          </details>

          {/* 申请延期 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何申请延期？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 进入订单详情 &rarr; "进度"标签页 &rarr; 找到需要延期的节点</p>
                <p>2. 点击<strong>"申请延期"</strong></p>
                <p>3. 填写延期信息：</p>
                <ul className="ml-4 space-y-1 text-sm">
                  <li>- <strong>原因类别</strong>：客户确认延迟 / 供应商延迟 / 内部延迟 / 物流 / 不可抗力 / 其他</li>
                  <li>- <strong>原因说明</strong>：具体描述延期原因</li>
                  <li>- <strong>建议新日期</strong>：可选择调整整体锚点日期或仅调整本节点</li>
                  <li>- <strong>是否需要客户审批</strong>：如需要，上传客户确认截图</li>
                </ul>
                <p>4. 提交后等待管理员审批</p>
                <p>5. 管理员批准后，系统自动重新计算下游节点的截止日期</p>
              </div>
            </div>
          </details>

          {/* 上传凭证 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何上传凭证？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 在节点详情区找到<strong>蓝色底色的"凭证上传"区域</strong></p>
                <p>2. 点击上传按钮，选择文件（支持图片、PDF、Excel 等）</p>
                <p>3. 上传成功后文件会显示在下方列表</p>
                <p>4. 可以点击文件名预览/下载，也可以删除重新上传</p>
              </div>
              <div className="bg-amber-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-amber-800 font-medium">凭证是 KPI 考核和问题追溯的依据，请确保上传正确、清晰的文件。</p>
              </div>
            </div>
          </details>

          {/* 创建订单 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何创建新订单？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 进入<strong>订单列表</strong> &rarr; 点击右上角<strong>"新建订单"</strong></p>
                <p>2. <strong>第一步：</strong>填写订单基本信息</p>
                <ul className="ml-4 space-y-1">
                  <li>- 客户名称、工厂名称</li>
                  <li>- 贸易条款（FOB / DDP）</li>
                  <li>- FOB 填 ETD（船期），DDP 填到仓日期</li>
                  <li>- 订单类型、风险标记（新客户、新工厂等）</li>
                  <li>- 上传附件：客户 PO、生产单、辅料单等</li>
                </ul>
                <p>3. <strong>第二步：</strong>系统自动生成 23 个里程碑节点，按 7 个阶段展示</p>
                <p>4. <strong>第三步：</strong>阅读使用说明（首次创建建议仔细阅读）</p>
                <p>5. <strong>第四步：</strong>自动跳转到订单详情页开始执行</p>
              </div>
            </div>
          </details>

          {/* 备忘录 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何使用备忘录？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 点击导航栏<strong>"备忘录"</strong>进入备忘录页面</p>
                <p>2. 点击"新建"添加备忘，可设置提醒日期</p>
                <p>3. <strong>智能关联订单：</strong>输入内容中包含订单号（如 QM-20260328-001）、PO 号或客户名时，系统会自动识别并提示关联</p>
                <p>4. 点击"关联此订单"后可选择关联到具体执行环节，关卡到期前 3 天系统自动邮件提醒</p>
                <p>5. 已关联的备忘会显示订单号标签，点击可直接跳转到订单详情</p>
                <p>6. 到期的备忘会在工作台底部显示提醒，完成后可标记为已完成或删除</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-blue-800 font-medium">建议：从微信或邮件中直接复制包含订单号的消息粘贴到备忘录，系统会自动识别并关联。</p>
              </div>
            </div>
          </details>

          {/* 跟单指定 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              如何指定跟单负责人？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 进入订单详情页 → "基本信息" Tab</p>
                <p>2. 找到<strong>"跟单负责人"</strong>一栏，点击"指定"</p>
                <p>3. 从下拉列表中选择跟单人员，点击"确认"</p>
                <p>4. 系统会自动将该订单所有跟单相关的关卡分配给此人</p>
              </div>
              <div className="bg-amber-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-amber-800 font-medium">仅管理员和订单创建者可以指定跟单。其他角色（采购、财务等）在首次操作对应关卡时会自动认领。</p>
              </div>
            </div>
          </details>

          {/* 执行评分 */}
          <details className="rounded-xl border border-gray-200 overflow-hidden">
            <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50">
              执行评分和提成是怎么算的？
            </summary>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200 space-y-2">
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>1. 订单完成后，系统自动为<strong>业务</strong>和<strong>跟单</strong>分别生成执行评分</p>
                <p>2. 评分从五个维度计算（满分 100 分）：</p>
                <ul className="ml-4 space-y-1">
                  <li>- <strong>节拍准时（40分）</strong>：你负责的关卡是否按时完成</li>
                  <li>- <strong>零阻塞（20分）</strong>：你负责的环节是否出现卡住</li>
                  <li>- <strong>延期控制（15分）</strong>：是否申请了延期</li>
                  <li>- <strong>品质达标（15分）</strong>：中查、尾查是否一次通过（业务和跟单共担）</li>
                  <li>- <strong>准时交付（10分）</strong>：订单是否按时出运（业务和跟单共担）</li>
                </ul>
                <p>3. 总分对应提成系数：S 级（95+）110%、A 级（85-94）100%、B 级（75-84）85%、C 级（60-74）70%、D 级（60 以下）50%</p>
                <p>4. 在订单详情页的<strong>"执行评分"Tab</strong> 可以查看详细评分和规则说明</p>
              </div>
              <div className="bg-green-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-green-800 font-medium">绝大多数正常执行的订单都在 A 级以上。好好做，全额提成就是你的。评分有争议可以找管理员复核。</p>
              </div>
            </div>
          </details>
        </div>
      </section>

      {/* ====== 6. 全部节点 SOP ====== */}
      <section id="milestones" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">6</span>
          全部节点详细 SOP
        </h2>
        <p className="text-sm text-gray-500 mb-4">点击每个阶段查看该阶段所有节点的标准操作规程。</p>
        <div className="space-y-3">
          {Object.entries(STAGE_KEYS).map(([stageKey, stepKeys]) => {
            const stageNodes = stepKeys
              .map(sk => MILESTONE_TEMPLATE_V1.find(m => m.step_key === sk))
              .filter(Boolean) as typeof MILESTONE_TEMPLATE_V1;

            return (
              <details key={stageKey} className="rounded-xl border border-gray-200 overflow-hidden">
                <summary className="px-5 py-3 bg-white cursor-pointer font-medium text-sm text-gray-900 hover:bg-gray-50 flex items-center justify-between">
                  <span>{STAGE_NAMES[stageKey]}</span>
                  <span className="text-xs text-gray-400 font-normal">{stageNodes.length} 个节点</span>
                </summary>
                <div className="divide-y divide-gray-100 border-t border-gray-200">
                  {stageNodes.map(node => {
                    const sop = SOP_MAP[node.step_key];
                    return (
                      <div key={node.step_key} className="px-5 py-4">
                        {/* 节点名称 + 标签 */}
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900">{node.name}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">{getRoleLabel(node.owner_role) || node.owner_role}</span>
                          {node.is_critical && <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium">关键节点</span>}
                          {node.evidence_required && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">需要凭证</span>}
                        </div>

                        {/* SOP 内容 */}
                        {sop ? (
                          <div className="bg-indigo-50/50 rounded-lg p-4 mt-2 space-y-3">
                            <p className="text-xs font-bold text-indigo-900">{sop.sop_title}</p>
                            {/* 步骤 */}
                            <div>
                              <p className="text-xs font-semibold text-indigo-800 mb-1">操作步骤：</p>
                              <div className="text-xs text-indigo-700 space-y-0.5">
                                {sop.sop_steps.map((step, i) => (
                                  <p key={i}>{step}</p>
                                ))}
                              </div>
                            </div>
                            {/* 必须提交 */}
                            <div>
                              <p className="text-xs font-semibold text-indigo-800 mb-1">必须提交：</p>
                              {sop.required_fields.map((field, i) => (
                                <p key={i} className="text-xs text-indigo-600">* {field}</p>
                              ))}
                            </div>
                            {/* 完成标准 */}
                            <div className="border-t border-indigo-200 pt-2">
                              <p className="text-xs font-semibold text-indigo-800 mb-1">完成标准：</p>
                              {sop.completion_rules.map((rule, i) => (
                                <p key={i} className="text-xs text-indigo-600 flex gap-1"><span>*</span> {rule}</p>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-gray-400 mt-1 italic">按节点名称要求完成操作即可，无额外 SOP 要求。</p>
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

      {/* ====== 7. 执行评分与提成 ====== */}
      <section id="kpi" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">7</span>
          执行评分与提成
        </h2>

        <div className="bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 rounded-xl p-4 border border-orange-100 mb-4">
          <p className="text-sm text-gray-700 leading-relaxed">
            评分不是为了扣钱，是为了让认真做事的人拿到应得的回报。
            每个订单完成后系统自动评分，<strong>业务/理单</strong>和<strong>跟单</strong>各一份成绩单。
          </p>
        </div>

        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-700">维度</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700">满分</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700">扣分规则</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">⏱ 节拍准时</td>
                <td className="px-4 py-3 text-gray-600">40</td>
                <td className="px-4 py-3 text-gray-600">每个逾期关卡 -8 分</td>
                <td className="px-4 py-3 text-xs text-gray-500">只算你负责的关卡</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">🟢 零阻塞</td>
                <td className="px-4 py-3 text-gray-600">20</td>
                <td className="px-4 py-3 text-gray-600">每次阻塞 -10 分</td>
                <td className="px-4 py-3 text-xs text-gray-500">只算你负责的关卡</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">📅 延期控制</td>
                <td className="px-4 py-3 text-gray-600">15</td>
                <td className="px-4 py-3 text-gray-600">每次延期申请 -5 分</td>
                <td className="px-4 py-3 text-xs text-gray-500">只算你负责的关卡</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">✅ 品质达标</td>
                <td className="px-4 py-3 text-gray-600">15</td>
                <td className="px-4 py-3 text-gray-600">中查不过 -5，尾查不过 -10</td>
                <td className="px-4 py-3 text-xs text-gray-500">业务和跟单共担</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">🚢 准时交付</td>
                <td className="px-4 py-3 text-gray-600">10</td>
                <td className="px-4 py-3 text-gray-600">迟 1-3 天得 5 分，迟 4-7 天 0 分，超 7 天 -5 分</td>
                <td className="px-4 py-3 text-xs text-gray-500">业务和跟单共担</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-5 gap-2 text-center text-xs mt-4">
          <div className="rounded-lg bg-purple-50 border border-purple-200 p-2.5">
            <div className="font-bold text-purple-700">S 级 · 95+</div>
            <div className="text-purple-500 mt-0.5">提成 110%</div>
          </div>
          <div className="rounded-lg bg-green-50 border border-green-200 p-2.5">
            <div className="font-bold text-green-700">A 级 · 85-94</div>
            <div className="text-green-500 mt-0.5">提成 100%</div>
          </div>
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-2.5">
            <div className="font-bold text-blue-700">B 级 · 75-84</div>
            <div className="text-blue-500 mt-0.5">提成 85%</div>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5">
            <div className="font-bold text-amber-700">C 级 · 60-74</div>
            <div className="text-amber-500 mt-0.5">提成 70%</div>
          </div>
          <div className="rounded-lg bg-red-50 border border-red-200 p-2.5">
            <div className="font-bold text-red-700">D 级 · &lt;60</div>
            <div className="text-red-500 mt-0.5">提成 50%</div>
          </div>
        </div>

        <div className="bg-green-50 rounded-xl p-4 mt-3">
          <p className="text-xs text-green-800 font-medium">正常执行的订单基本都在 A 级以上，好好做就是全额提成。评分可在订单详情"执行评分"Tab 查看明细，有争议可找管理员复核。</p>
        </div>
      </section>

      {/* ====== 8. v3.2 更新说明 (2026-03-31) ====== */}
      <section id="updates" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center text-purple-600 text-sm font-bold">8</span>
          v3.2 更新说明（2026-03-31）
        </h2>
        <div className="space-y-4">

          {/* 阶段重构 */}
          <div className="rounded-xl border border-purple-200 bg-purple-50/30 p-4">
            <h3 className="text-sm font-bold text-purple-800 mb-2">🏗️ 阶段体系重构</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• 阶段1 更名为<strong>「订单评审」</strong>：PO确认 → 财务审核 → 订单评审会 → 生产单上传</li>
              <li>• 阶段2 更名为<strong>「预评估」</strong>：BOM/采购预评估（采购负责）→ 生产预评估（跟单负责）</li>
              <li>• 阶段3 更名为<strong>「工厂匹配 & 产前样」</strong>：加工费确认 → 工厂匹配确认 → 产前样流程</li>
              <li>• 阶段4-7 不变</li>
            </ul>
          </div>

          {/* 检查清单 */}
          <div className="rounded-xl border border-amber-200 bg-amber-50/30 p-4">
            <h3 className="text-sm font-bold text-amber-800 mb-2">📋 节点内置检查清单（重要）</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• <strong>财务审核</strong>：价格vs报价核对、利润率（{'<'}15%报CEO）、币种/付款方式、运费/验货费核查</li>
              <li>• <strong>订单评审会</strong>：款式/面料/颜色/手感/印花/尺码表/裁剪配比/头样/包装/辅料 共12项确认</li>
              <li>• <strong>BOM/采购预评估</strong>：面料/辅料供应商、到料时间、高风险材料标注</li>
              <li>• <strong>生产预评估</strong>：交期可行性、工艺难点评估</li>
              <li>• <strong>工厂匹配确认</strong>：产品类型匹配、价格交期品质匹配、第一候选+备选工厂</li>
              <li>• <strong>规则</strong>：全部必填项勾完才能标记节点完成，各角色只能编辑自己负责的项</li>
              <li>• <strong>排期影响</strong>：未确认项选择预计确认日期后，自动重算下游节点排期</li>
            </ul>
          </div>

          {/* 三单比对 */}
          <div className="rounded-xl border border-green-200 bg-green-50/30 p-4">
            <h3 className="text-sm font-bold text-green-800 mb-2">🔍 AI 三单比对</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• 创建订单必须上传<strong>3个文件</strong>：客户PO + 内部报价单 + 客户最终报价单</li>
              <li>• AI 自动比对三份文件的<strong>款号、单价、数量、交期、颜色、尺码、包装、工艺</strong>等9个维度</li>
              <li>• 发现差异时弹窗展示三列对比表格，业务确认后才能继续创建</li>
            </ul>
          </div>

          {/* 新建订单 */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4">
            <h3 className="text-sm font-bold text-blue-800 mb-2">📝 新建订单要求</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• <strong>出厂日期、ETD、ETA</strong>全部必填</li>
              <li>• <strong>款数、颜色数、预估总数量</strong>必填</li>
              <li>• 翻单类型不再标"新客户首单/新工厂首单"</li>
              <li>• <strong>内部订单号</strong>在财务审核完成时必须填写</li>
              <li>• <strong>快递单号</strong>在产前样寄出时必须填写</li>
              <li>• 产前样客户确认新增"未通过/需返样"二次样流程</li>
              <li>• 删除订单必须输入完整订单号确认</li>
            </ul>
          </div>

          {/* AI */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 p-4">
            <h3 className="text-sm font-bold text-indigo-800 mb-2">🧠 AI 全场景助手</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• <strong>工作台</strong>：每日AI建议，优先级排序和风险预警</li>
              <li>• <strong>订单详情</strong>：AI订单风险分析（综合客户/工厂/标签/进度/交期）</li>
              <li>• <strong>节点操作</strong>：点击"去处理"时AI给出操作要点和历史教训</li>
              <li>• <strong>创建订单</strong>：客户/工厂历史风险预警 + 三单比对</li>
              <li>• <strong>知识库</strong>：AI分析客户画像、工厂评估、流程瓶颈</li>
              <li>• 所有AI功能24小时缓存，失败时静默降级不影响正常使用</li>
            </ul>
          </div>

          {/* 权限 */}
          <div className="rounded-xl border border-red-200 bg-red-50/30 p-4">
            <h3 className="text-sm font-bold text-red-800 mb-2">🔒 权限与安全</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• 管理员<strong>不能</strong>标记任何关卡完成，只能监督、催办、审批</li>
              <li>• 已完成/已取消的订单<strong>禁止</strong>修改关卡、申请延期</li>
              <li>• 检查清单<strong>角色隔离</strong>：各部门只能编辑自己负责的检查项</li>
              <li>• 催办邮件失败正确提示，逾期只算进行中节点</li>
            </ul>
          </div>

          {/* 性能 */}
          <div className="rounded-xl border border-gray-200 bg-gray-50/30 p-4">
            <h3 className="text-sm font-bold text-gray-800 mb-2">⚡ 性能优化</h3>
            <ul className="text-sm text-gray-700 space-y-1.5">
              <li>• 订单列表查询优化（JOIN查询替代N+1循环）</li>
              <li>• 状态值中英文标准化，全系统一致</li>
              <li>• 清理废弃代码，系统更精简稳定</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ====== 9. 常见问题 ====== */}
      <section id="faq" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">9</span>
          常见问题
        </h2>
        <div className="space-y-2">
          {[
            { q: '登录后看不到任何订单和节点？', a: '新注册账号需要管理员分配角色后才能看到内容。请联系管理员（alex@ 或 su@）在"用户管理"中为你分配角色。' },
            { q: '我看不到某些节点的"处理"按钮？', a: '你只能操作与你角色匹配的节点。比如业务只能操作业务负责的节点。如果你需要操作其他角色的节点，联系管理员为你增加对应角色。' },
            { q: '节点超期了但我确实来不及完成怎么办？', a: '请立即在该节点提交"延期申请"，填写原因和建议新日期。管理员审批通过后系统会自动重算排期。不要放着不管，超期会影响 KPI。' },
            { q: '标记完成时提示"需要上传凭证"？', a: '这个节点设置了凭证要求（蓝色"需要凭证"标签）。在节点详情区的上传区域先上传文件，然后再标记完成。' },
            { q: '"标记完成"按钮点不了，提示前置节点未完成？', a: '这个节点有依赖关系，必须等前面的关键节点完成后才能操作。检查前面是否有未完成的节点。' },
            { q: '订单完成后提示"去复盘"是什么意思？', a: '当订单所有节点完成后，系统要求进行复盘总结。点击"去复盘"填写：是否准时交货、主要延误原因、做得好的地方、改进措施等。这是必做步骤。' },
            { q: '一个人可以有多个角色吗？', a: '可以。管理员在"用户管理"页面可以为同一个人分配多个角色（如跟单+采购），这样你就能操作多个角色的节点。' },
            { q: '手机上可以用吗？', a: '可以。系统支持手机浏览器访问，界面会自动适配手机屏幕。建议将网址添加到手机桌面方便使用。' },
            { q: '收到催办邮件是什么意思？', a: '管理员通过系统对你负责的超期或即将到期的节点发送了催办提醒。请尽快登录系统处理对应节点。' },
            { q: '如何查看操作记录？', a: '进入订单详情 → 切换到"日志"标签页，可以查看该订单所有节点的操作记录（谁、什么时间、做了什么）。' },
            { q: '管理员可以帮我操作关卡吗？', a: '不可以。管理员只能审批延期、解除阻塞、指定负责人，但不能替任何人标记关卡完成。每个关卡只有对应角色的人才能操作，这是为了保证责任明确。' },
            { q: '备忘录里输入订单号会怎样？', a: '系统会自动识别并弹出关联提示，你可以选择关联到具体订单和执行环节。关联后关卡到期前 3 天会自动收到邮件提醒。' },
            { q: '执行评分什么时候出来？', a: '订单完成后自动生成。在订单详情的"执行评分"Tab 可以随时查看评分标准，订单完成后会显示实际得分。' },
            { q: '评分不满意可以申诉吗？', a: '可以。联系管理员说明情况，管理员可以手动重新计算。我们尊重每个人的付出，客户原因导致的问题不会影响你的评分。' },
            { q: '什么是"进行中订单导入"？', a: '用于导入已经在执行的订单。开启后选择当前正在做的节点，之前的节点自动标记完成，之后的节点从今天重新排期。适合系统上线初期批量导入正在执行的订单。' },
            { q: '内部订单号在哪里填？', a: '在财务审核节点完成时必须填写。这是实体订单册上的编号，方便系统订单与纸质订单册对应。填写后在订单详情"基本信息"区可以看到。' },
            { q: '产前样客户未通过怎么办？', a: '在"产前样客户确认"节点点击"未通过/需返样"按钮，系统会自动回退到"产前样准备完成"节点，开始二次样流程。' },
            { q: '为什么有些过期节点没有显示逾期？', a: '只有"进行中"的节点过了截止日期才算逾期。"未开始"的节点即使截止日期已过也不算逾期，避免导入订单时大量误报。' },
            { q: '检查清单是什么？怎么用？', a: '部分节点（如财务审核、订单评审会）内置了检查清单，展开"去处理"就能看到。逐项勾选确认，全部必填项完成后才能标记节点完成。不同角色只能编辑自己负责的项。' },
            { q: '检查清单中"未确认"项怎么处理？', a: '在订单评审会节点，如果某项（如款式、头样）客户尚未确认，选择预计确认日期。系统会根据这个日期自动调整后续节点排期。' },
            { q: '三单比对是什么？', a: '创建订单时必须上传客户PO、内部报价单、客户最终报价单三份文件。AI 会自动比对三份文件的款号、价格、数量等9个维度，发现差异会弹窗提示。' },
            { q: 'AI 建议在哪里看？', a: '四个地方：1) 工作台顶部每日建议；2) 订单详情页风险分析；3) 节点"去处理"表单顶部操作建议；4) 创建订单时客户/工厂风险提示。' },
          ].map((faq, i) => (
            <details key={i} className="rounded-xl border border-gray-200 overflow-hidden">
              <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-gray-900 hover:bg-gray-50 bg-white">
                {faq.q}
              </summary>
              <p className="px-4 py-3 text-sm text-gray-600 bg-gray-50 border-t border-gray-200">{faq.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* 页脚 */}
      <div className="text-center py-6 border-t border-gray-200">
        <p className="text-xs text-gray-400">订单节拍器 v3.2 | 更新于 2026-03-31 | 访问 order.qimoactivewear.com | 如有问题请联系管理员</p>
      </div>
    </div>
  );
}
