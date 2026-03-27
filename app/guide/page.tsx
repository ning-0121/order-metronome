import { MILESTONE_TEMPLATE_V1 } from '@/lib/milestoneTemplate';
import { SOP_MAP } from '@/lib/domain/sop';
import { getRoleLabel } from '@/lib/utils/i18n';

/* ── 阶段定义（与 milestone template 完全对应） ── */
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
  stage1: ['po_confirmed', 'finance_approval', 'production_order_upload'],
  stage2: ['order_docs_bom_complete', 'bulk_materials_confirmed'],
  stage3: ['processing_fee_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved', 'factory_confirmed'],
  stage4: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'],
  stage5: ['mid_qc_check', 'final_qc_check'],
  stage6: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'],
  stage7: ['booking_done', 'customs_export', 'payment_received'],
};

/* ── 角色每日 SOP ── */
const ROLE_DAILY_SOPS = [
  {
    role: 'sales',
    label: '业务',
    color: 'indigo',
    responsibilities: '客户沟通、PO跟进、产前样寄送/确认、包装方式确认、船样寄送',
    milestones: ['PO确认', '产前样寄出', '产前样客户确认', '包装方式业务确认', '船样寄送'],
    dailySteps: [
      '打开"我的工作台"，查看今日到期和超期节点',
      '优先处理红色超期节点 — 立即跟进客户或申请延期',
      '蓝色今日到期节点 — 按 SOP 完成操作并上传凭证',
      '有阻塞节点 — 联系相关方解决后点击"解除阻塞"',
      '查看备忘录提醒，处理客户跟进事项',
    ],
    tips: [
      '客户确认需上传确认邮件截图作为凭证',
      '产前样寄出时建议同步在备忘录设置提醒跟进确认',
      '如客户反馈延迟，及时在对应节点提交延期申请',
    ],
  },
  {
    role: 'merchandiser',
    label: '跟单',
    color: 'purple',
    responsibilities: '生产单、BOM、产前样准备、工厂协调、中查尾查、验货放行',
    milestones: ['生产单上传', '订单资料/BOM齐全', '产前样准备完成', '确认工厂', '原辅料到货验收', '生产启动/开裁', '产前会', '中查', '尾查', '工厂完成', '验货/放行'],
    dailySteps: [
      '打开"我的工作台"，跟单角色节点最多，优先处理超期项',
      '检查原辅料到货情况 — 到货后在系统录入实际日期',
      '跟进工厂生产进度 — 生产启动后录入开裁日期',
      '安排中查/尾查 — 按 SOP 执行检验并上传报告',
      '工厂完成后安排验货，PASS 后标记放行',
    ],
    tips: [
      '生产单上传、BOM 等凭证节点必须上传文件才能标记完成',
      '中查建议在生产完成 30-50% 时安排',
      '尾查建议在 ETD 前 7 天完成',
      '验货/放行需上传第三方验货报告或放行单',
    ],
  },
  {
    role: 'finance',
    label: '财务',
    color: 'green',
    responsibilities: '财务审核、加工费确认、收款确认',
    milestones: ['财务审核', '加工费确认', '收款完成'],
    dailySteps: [
      '打开"我的工作台"，查看待处理的财务审核节点',
      '收到 PO 后进行财务审核 — 确认金额、付款条件',
      '加工费到位后核对并上传确认函',
      '出货后跟进尾款 — 收款后标记完成',
    ],
    tips: [
      '财务审核直接影响后续所有节点启动，请优先处理',
      '加工费确认需上传确认函作为凭证',
    ],
  },
  {
    role: 'procurement',
    label: '采购',
    color: 'amber',
    responsibilities: '大货原辅料确认、采购下单、供应商跟进',
    milestones: ['大货原辅料确认', '采购订单下达'],
    dailySteps: [
      '打开"我的工作台"，查看待处理的采购节点',
      '收到 BOM 后确认原辅料可用性和供应商交期',
      '下达采购订单并获取供应商确认',
      '录入各物料预计到货日期（ETA）',
      '如 ETA 晚于排期，立即标记阻塞并通知跟单',
    ],
    tips: [
      '原辅料确认需上传供应商确认记录',
      '采购下单需上传采购订单截图和供应商确认回执',
    ],
  },
  {
    role: 'logistics',
    label: '物流',
    color: 'sky',
    responsibilities: '订舱、报关出运',
    milestones: ['订舱完成', '报关出运'],
    dailySteps: [
      '打开"我的工作台"，查看物流相关节点',
      '验货放行后联系货代订舱 — 确认船期、截关日',
      '上传 Booking Confirmation',
      '准备报关资料 — 装箱单、发票、合同、报关委托书',
      '报关放行后安排装柜出运，获取提单并上传',
    ],
    tips: [
      'FOB 订单：ETD 前 5 天完成订舱',
      'DDP 订单：ETD 前 21 天完成订舱（含内陆运输时间）',
      '订舱和报关都需上传凭证才能标记完成',
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
                <p>3. 到期的备忘会在工作台底部显示提醒</p>
                <p>4. 完成后可标记为已完成或删除</p>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 mt-2">
                <p className="text-xs text-blue-800 font-medium">建议用备忘录跟踪客户回复、供应商交期等非系统节点事项。</p>
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

      {/* ====== 7. KPI 考核说明 ====== */}
      <section id="kpi" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">7</span>
          KPI 考核说明
        </h2>
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-700">指标</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700">计算方式</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700">标准</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">准时率</td>
                <td className="px-4 py-3 text-gray-600">准时完成数 / 总完成数 x 100%</td>
                <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">&ge;80% 优秀</span></td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">超期节点数</td>
                <td className="px-4 py-3 text-gray-600">未完成且已过截止日期的节点总数</td>
                <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">越少越好</span></td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">阻塞节点数</td>
                <td className="px-4 py-3 text-gray-600">当前标记为阻塞状态的节点总数</td>
                <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">及时解决</span></td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-gray-900">凭证完整度</td>
                <td className="px-4 py-3 text-gray-600">要求凭证的节点中，完成时已上传凭证的比例</td>
                <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">100% 合规</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="bg-indigo-50 rounded-xl p-4 mt-3">
          <p className="text-xs text-indigo-800 font-medium">KPI 按角色统计。管理员可以在"我的节拍"页面查看各角色的准时率和完成进度。</p>
        </div>
      </section>

      {/* ====== 8. 常见问题 ====== */}
      <section id="faq" className="mb-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 text-sm font-bold">8</span>
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
        <p className="text-xs text-gray-400">订单节拍器 v1.0 | 如有问题请联系管理员</p>
      </div>
    </div>
  );
}
