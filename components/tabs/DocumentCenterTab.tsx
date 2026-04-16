'use client';

import { useState, useEffect, useTransition } from 'react';
import { getOrderDocuments, uploadDocument, aiGenerateDocument, submitForReview, approveDocument, rejectDocument } from '@/app/actions/documents';
import { DOCUMENT_TYPES, SOURCE_MODES, DOCUMENT_STATUSES, type DocumentType } from '@/lib/domain/document-templates';
import { createClient } from '@/lib/supabase/client';
import { FILE_NAMING_BY_DOC_TYPE, validateFileNameForLabel, renameFile } from '@/lib/domain/fileNaming';

interface Props {
  orderId: string;
  isAdmin: boolean;
  currentRoles: string[];
  /** 是否有权查看价格敏感单据（PI/CI），由父组件根据角色+订单归属判定 */
  canViewPriceDocs?: boolean;
  /** 订单上下文信息，用于文档标题对照 */
  orderContext?: {
    orderNo?: string;
    customerName?: string;
    factoryName?: string;
    quantity?: number;
    incoterm?: string;
  };
}

const ALL_DOC_TABS: { key: DocumentType; label: string; icon: string; priceSensitive?: boolean; productionVisible?: boolean }[] = [
  { key: 'pi', label: 'PI', icon: '📄', priceSensitive: true },
  { key: 'production_sheet', label: '生产单', icon: '🏭', productionVisible: true },
  { key: 'material_sheet', label: '原辅料单', icon: '🧵' },
  { key: 'purchase_order', label: '采购单', icon: '🛒' },
  { key: 'packing_list', label: '装箱单', icon: '📦', productionVisible: true },
  { key: 'ci', label: 'CI', icon: '💰', priceSensitive: true },
];

export function DocumentCenterTab({ orderId, isAdmin, currentRoles, canViewPriceDocs, orderContext }: Props) {
  // 行政督办：可以看除价格之外的所有文件
  const isAdminAssistant = currentRoles.includes('admin_assistant') && !isAdmin;

  // 生产线角色（生产部+跟单+生产主管）：只能看生产单和装箱单
  const isProductionLine = !isAdmin && !isAdminAssistant
    && currentRoles.some(r => ['production', 'merchandiser', 'production_manager'].includes(r))
    && !currentRoles.some(r => ['sales', 'finance', 'procurement'].includes(r));
  // 只读（生产部+跟单不能上传，但生产主管可以上传生产单/装箱单）
  const isProductionOnly = isProductionLine && !currentRoles.includes('production_manager');

  // 是否可见价格单据：管理员、财务、或父组件明确传入（行政不可见）
  const showPriceDocs = !isProductionLine && !isAdminAssistant && (isAdmin || currentRoles.includes('finance') || canViewPriceDocs === true);

  // 生产线角色只看 productionVisible 的 tab
  const DOC_TABS = isProductionLine
    ? ALL_DOC_TABS.filter(t => t.productionVisible)
    : showPriceDocs ? ALL_DOC_TABS : ALL_DOC_TABS.filter(t => !t.priceSensitive);
  const [docs, setDocs] = useState<any[]>([]);
  const [activeDocType, setActiveDocType] = useState<DocumentType>(
    isProductionLine ? 'production_sheet' : showPriceDocs ? 'pi' : 'production_sheet'
  );
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState<string | null>(null);

  useEffect(() => {
    loadDocs();
  }, [orderId]);

  async function loadDocs() {
    setLoading(true);
    const res = await getOrderDocuments(orderId);
    setDocs(res.data || []);
    setLoading(false);
  }

  // 当前类型的单据
  const typeDocs = docs.filter(d => d.document_type === activeDocType);
  const officialDoc = typeDocs.find(d => d.is_official);
  const currentDraft = typeDocs.find(d => d.is_current && !d.is_official && d.status !== 'archived');
  const history = typeDocs.filter(d => !d.is_official && d !== currentDraft);

  // 上传文件
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  const ALLOWED_EXTENSIONS = ['pdf', 'xlsx', 'xls', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'csv'];
  // 部分正式单据拒收图片 — 必须是 Excel/PDF
  const STRICT_DOC_TYPES: Record<string, string[]> = {
    purchase_order: ['xlsx', 'xls', 'pdf'],       // 采购单
    pi: ['pdf', 'xlsx', 'xls'],                   // PI
    ci: ['pdf', 'xlsx', 'xls'],                   // CI
    material_sheet: ['xlsx', 'xls', 'pdf'],       // 原辅料单
    packing_list: ['xlsx', 'xls', 'pdf'],         // 装箱单
  };

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // 文件大小验证
    if (file.size > MAX_FILE_SIZE) {
      alert('文件过大，最大允许 50MB');
      e.target.value = '';
      return;
    }

    // 文件类型验证
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      alert(`不支持的文件类型 .${ext}，仅支持: ${ALLOWED_EXTENSIONS.join(', ')}`);
      e.target.value = '';
      return;
    }

    // 严格文件类型白名单（正式单据拒收图片/截图）
    const strictAllowed = STRICT_DOC_TYPES[activeDocType];
    if (strictAllowed && !strictAllowed.includes(ext)) {
      alert(
        `⛔ ${DOCUMENT_TYPES[activeDocType].label}只接受 ${strictAllowed.map(e => '.' + e).join(' / ')} 文件，\n` +
        `"${file.name}"（.${ext}）被拒绝。\n\n` +
        `如有图片形式的单据，请先转成 PDF 或 Excel 后再上传。`
      );
      e.target.value = '';
      return;
    }

    // 命名规范检查
    const docHint = FILE_NAMING_BY_DOC_TYPE[activeDocType];
    let finalFile = file;
    if (docHint) {
      const check = validateFileNameForLabel(file.name, docHint.label, orderContext?.orderNo);
      if (!check.ok) {
        const issueStr = check.issues.map(i => '· ' + i.message).join('\n');
        const useRecommended = confirm(
          `⚠️ 文件名不符合命名规范：\n${issueStr}\n\n推荐命名：\n${check.suggestion}\n\n点击"确定"使用推荐命名上传\n点击"取消"保持原文件名上传`
        );
        if (useRecommended) finalFile = renameFile(file, check.suggestion);
      }
    }

    setUploading(true);

    try {
      const supabase = createClient();
      const path = `${orderId}/documents/${activeDocType}_${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage.from('order-docs').upload(path, finalFile, { contentType: finalFile.type, upsert: false });
      if (uploadErr) { alert('文件上传失败: ' + uploadErr.message); setUploading(false); return; }

      const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(path);

      const result = await uploadDocument(orderId, activeDocType, finalFile.name, path, urlData?.publicUrl || path);
      if (result.error) alert(result.error);
      else await loadDocs();
    } catch (err: any) {
      alert('上传异常: ' + err.message);
    }
    setUploading(false);
    e.target.value = '';
  }

  // AI 生成
  async function handleAIGenerate() {
    setGenerating(true);
    const result = await aiGenerateDocument(orderId, activeDocType);
    if (result.error) alert(result.error);
    else await loadDocs();
    setGenerating(false);
  }

  // 提交审核
  async function handleSubmit(docId: string) {
    if (!confirm('确认提交审核？')) return;
    startTransition(async () => {
      const res = await submitForReview(docId);
      if (res.error) alert(res.error);
      else await loadDocs();
    });
  }

  // 审批
  async function handleApprove(docId: string) {
    if (!confirm('确认审批通过？')) return;
    startTransition(async () => {
      const res = await approveDocument(docId);
      if (res.error) alert(res.error);
      else await loadDocs();
    });
  }

  // 驳回
  async function handleReject(docId: string) {
    if (!rejectReason.trim()) { alert('请填写驳回原因'); return; }
    startTransition(async () => {
      const res = await rejectDocument(docId, rejectReason);
      if (res.error) alert(res.error);
      else { setShowRejectForm(null); setRejectReason(''); await loadDocs(); }
    });
  }

  function renderDocCard(doc: any, isOfficial: boolean) {
    const statusInfo = DOCUMENT_STATUSES[doc.status as keyof typeof DOCUMENT_STATUSES] || { label: doc.status, color: 'bg-gray-100' };
    const sourceInfo = SOURCE_MODES[doc.source_mode as keyof typeof SOURCE_MODES] || { label: doc.source_mode, icon: '📋', color: '' };

    return (
      <div key={doc.id} className={`rounded-xl border p-4 ${isOfficial ? 'border-green-300 bg-green-50/30' : 'border-gray-200'}`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="font-bold text-gray-900">{doc.document_no || '未编号'}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${statusInfo.color}`}>{statusInfo.label}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${sourceInfo.color}`}>{sourceInfo.icon} {sourceInfo.label}</span>
            {isOfficial && <span className="text-xs px-2 py-0.5 rounded-full bg-green-200 text-green-800 font-bold">正式版本</span>}
          </div>
          <span className="text-xs text-gray-400">v{doc.version_no}</span>
        </div>

        {doc.file_name && (
          <p className="text-sm text-gray-600 mb-2">📎 {doc.file_name}</p>
        )}

        {doc.editable_json && !doc.file_name && (
          <p className="text-xs text-gray-500 mb-2">AI生成草稿（可编辑）</p>
        )}

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {/* 查看/下载 */}
          {doc.file_url && (
            <a href={doc.file_url} target="_blank" rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50">
              查看
            </a>
          )}

          {/* 提交审核（生产部不可操作） */}
          {doc.status === 'draft' && !isProductionOnly && (
            <button onClick={() => handleSubmit(doc.id)} disabled={isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              提交审核
            </button>
          )}

          {/* 审批操作（管理员或财务，生产部不可操作） */}
          {doc.status === 'pending_review' && !isProductionOnly && (isAdmin || currentRoles.includes('finance')) && (
            <>
              <button onClick={() => handleApprove(doc.id)} disabled={isPending}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                审批通过
              </button>
              <button onClick={() => setShowRejectForm(doc.id)} disabled={isPending}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50">
                驳回
              </button>
            </>
          )}

          {/* 驳回后可重新编辑提交 */}
          {doc.status === 'rejected' && (
            <button onClick={() => handleSubmit(doc.id)} disabled={isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
              重新提交
            </button>
          )}
        </div>

        {/* 驳回原因表单 */}
        {showRejectForm === doc.id && (
          <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200">
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              placeholder="请填写驳回原因..." rows={2}
              className="w-full rounded border border-red-300 px-3 py-2 text-sm mb-2" />
            <div className="flex gap-2">
              <button onClick={() => handleReject(doc.id)} className="text-xs px-3 py-1.5 rounded bg-red-600 text-white">确认驳回</button>
              <button onClick={() => { setShowRejectForm(null); setRejectReason(''); }} className="text-xs px-3 py-1.5 rounded border text-gray-600">取消</button>
            </div>
          </div>
        )}

        {/* 审批信息 */}
        {doc.approved_at && (
          <p className="text-xs text-green-600 mt-2">✅ 审批于 {new Date(doc.approved_at).toLocaleDateString('zh-CN')}</p>
        )}
        {doc.reject_reason && (
          <p className="text-xs text-red-600 mt-2">❌ 驳回原因: {doc.reject_reason}</p>
        )}
      </div>
    );
  }

  if (loading) return <div className="text-center py-12 text-gray-400">加载中...</div>;

  // 生产部只读：不能上传/AI生成/审批
  const canUpload = !isProductionOnly;

  return (
    <div className="space-y-6">
      {/* 订单上下文对照信息 */}
      {orderContext && (
        <div className="flex items-center gap-4 px-4 py-3 bg-gray-50 rounded-lg border border-gray-200 text-sm">
          <span className="font-mono font-bold text-gray-900">{orderContext.orderNo}</span>
          <span className="text-gray-600">{orderContext.customerName}</span>
          {orderContext.factoryName && <span className="text-gray-500">{orderContext.factoryName}</span>}
          {orderContext.quantity && <span className="text-gray-500">{orderContext.quantity}件</span>}
          {orderContext.incoterm && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">{orderContext.incoterm}</span>}
        </div>
      )}

      {/* 生产部提示 */}
      {isProductionLine && (
        <div className="px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          {isProductionOnly
            ? '生产部查看模式 — 仅可查看和下载生产单、装箱单'
            : '生产主管模式 — 可查看、上传生产单和装箱单'}
        </div>
      )}

      {/* 单据类型切换 */}
      <div className="flex gap-2 flex-wrap">
        {DOC_TABS.map(tab => (
          <button key={tab.key}
            onClick={() => setActiveDocType(tab.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeDocType === tab.key
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}>
            {tab.icon} {tab.label}
            {docs.filter(d => d.document_type === tab.key && d.is_official).length > 0 && (
              <span className="ml-1 text-green-300">✓</span>
            )}
          </button>
        ))}
      </div>

      {/* 上传按钮（生产部不可见，AI生成移至各节点SOP中） */}
      {canUpload && (
        <div className="space-y-2">
          <div className="flex gap-3 flex-wrap items-center">
            <label className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 cursor-pointer">
              {uploading ? '📤 上传中...' : `📤 上传${DOCUMENT_TYPES[activeDocType].label}`}
              <input type="file" className="hidden" onChange={handleUpload} disabled={uploading}
                accept={(STRICT_DOC_TYPES[activeDocType] || ALLOWED_EXTENSIONS).map(e => '.' + e).join(',')} />
            </label>
          </div>
          {/* 类型限制提示 */}
          {STRICT_DOC_TYPES[activeDocType] && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 inline-block">
              ⚠️ {DOCUMENT_TYPES[activeDocType].label}只接受 {STRICT_DOC_TYPES[activeDocType].map(e => '.' + e).join(' / ')} 文件（图片/截图会被拒绝）
            </div>
          )}
          {/* 命名建议 */}
          {FILE_NAMING_BY_DOC_TYPE[activeDocType] && (
            <div className="text-[11px] text-gray-500 bg-gray-50 rounded px-2 py-1.5 border border-gray-200 inline-flex flex-wrap items-center gap-x-1.5">
              <span className="text-gray-400">📝 建议命名：</span>
              <code className="font-mono text-gray-700">
                {FILE_NAMING_BY_DOC_TYPE[activeDocType].example.replace(
                  'QM-20260415-001',
                  orderContext?.orderNo || 'QM-订单号',
                )}
              </code>
              <a href="/guide#naming" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">规范 ↗</a>
            </div>
          )}
        </div>
      )}

      {/* 当前正式版本 */}
      {officialDoc && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">📌 当前正式版本</h3>
          {renderDocCard(officialDoc, true)}
        </div>
      )}

      {/* 当前草稿/待审核 */}
      {currentDraft && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">📝 当前版本</h3>
          {renderDocCard(currentDraft, false)}
        </div>
      )}

      {/* 历史版本 */}
      {history.length > 0 && (
        <details className="group">
          <summary className="text-sm font-semibold text-gray-500 cursor-pointer hover:text-gray-700">
            📋 历史版本 ({history.length})
          </summary>
          <div className="mt-2 space-y-2">
            {history.map(doc => renderDocCard(doc, false))}
          </div>
        </details>
      )}

      {/* 空状态 */}
      {typeDocs.length === 0 && (
        <div className="text-center py-8 text-gray-400">
          <p className="text-3xl mb-2">{DOCUMENT_TYPES[activeDocType].icon}</p>
          <p>暂无{DOCUMENT_TYPES[activeDocType].label}，点击上方按钮创建</p>
        </div>
      )}

      {/* ===== 所有已上传文件汇总 ===== */}
      <AllUploadedFiles
        orderId={orderId}
        isProductionLine={isProductionLine}
        hidePriceDocs={isAdminAssistant || isProductionLine}
        canDelete={isAdmin || currentRoles.includes('sales')}
      />
    </div>
  );
}

// ══════ 所有已上传文件（按权限过滤）══════

const FILE_TYPE_CONFIG: Array<{ type: string; label: string; icon: string; sensitive: boolean }> = [
  { type: 'customer_po', label: '客户PO', icon: '📋', sensitive: true },
  { type: 'internal_quote', label: '内部成本核算单', icon: '💰', sensitive: true },
  { type: 'customer_quote', label: '客户最终报价单', icon: '📄', sensitive: true },
  { type: 'production_order', label: '生产订单', icon: '🏭', sensitive: false },
  { type: 'trims_sheet', label: '原辅料单', icon: '🧵', sensitive: false },
  { type: 'packing_requirement', label: '包装资料', icon: '📦', sensitive: false },
  { type: 'tech_pack', label: 'Tech Pack', icon: '📐', sensitive: false },
  { type: 'evidence', label: '节点凭证', icon: '📎', sensitive: false },
];

function AllUploadedFiles({ orderId, isProductionLine, hidePriceDocs, canDelete }: { orderId: string; isProductionLine: boolean; hidePriceDocs?: boolean; canDelete?: boolean }) {
  const [files, setFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    (supabase.from('order_attachments') as any)
      .select('id, file_name, file_url, file_type, mime_type, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .then(({ data }: any) => { setFiles(data || []); setLoading(false); });
  }, [orderId]);

  async function handleDelete(f: any) {
    if (!confirm(`确定删除「${f.file_name}」？此操作不可恢复。`)) return;
    const { deleteAttachment } = await import('@/app/actions/attachments');
    const res = await deleteAttachment(f.id, orderId);
    if (res.error) { alert(res.error); return; }
    setFiles(prev => prev.filter(x => x.id !== f.id));
  }

  if (loading) return null;

  // 权限过滤：生产线只看非敏感文件，行政也隐藏价格文件
  const visibleTypes = (isProductionLine || hidePriceDocs)
    ? FILE_TYPE_CONFIG.filter(t => !t.sensitive)
    : FILE_TYPE_CONFIG;
  const visibleTypeKeys = new Set(visibleTypes.map(t => t.type));
  const filteredFiles = files.filter(f => visibleTypeKeys.has(f.file_type));

  if (filteredFiles.length === 0) return null;

  // 按类型分组
  const grouped = new Map<string, any[]>();
  for (const f of filteredFiles) {
    const list = grouped.get(f.file_type) || [];
    list.push(f);
    grouped.set(f.file_type, list);
  }

  const typeMap = Object.fromEntries(FILE_TYPE_CONFIG.map(t => [t.type, t]));

  return (
    <div className="border-t border-gray-200 pt-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">📁 所有已上传文件</h3>
      <div className="space-y-4">
        {Array.from(grouped.entries()).map(([type, items]) => {
          const cfg = typeMap[type];
          return (
            <div key={type}>
              <p className="text-xs font-medium text-gray-600 mb-1.5">{cfg?.icon || '📎'} {cfg?.label || type}（{items.length}）</p>
              <div className="space-y-1">
                {items.map((f: any) => (
                  <div key={f.id} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg border border-gray-100">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm text-gray-900 truncate">{f.file_name || '未命名'}</span>
                      <span className="text-xs text-gray-400">{new Date(f.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {f.file_url && (
                        <a href={f.file_url} target="_blank" rel="noopener noreferrer"
                          className="text-xs px-2.5 py-1 rounded bg-white border border-gray-300 text-indigo-600 hover:bg-indigo-50">
                          查看
                        </a>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDelete(f)}
                          className="text-xs px-2.5 py-1 rounded bg-white border border-red-200 text-red-600 hover:bg-red-50"
                          title="删除"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {isProductionLine && (
        <p className="text-xs text-amber-600 mt-3">生产部仅可查看生产订单、原辅料单、包装资料相关文件</p>
      )}
    </div>
  );
}
