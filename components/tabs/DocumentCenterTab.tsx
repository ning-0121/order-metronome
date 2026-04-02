'use client';

import { useState, useEffect, useTransition } from 'react';
import { getOrderDocuments, uploadDocument, aiGenerateDocument, submitForReview, approveDocument, rejectDocument } from '@/app/actions/documents';
import { DOCUMENT_TYPES, SOURCE_MODES, DOCUMENT_STATUSES, type DocumentType } from '@/lib/domain/document-templates';
import { createClient } from '@/lib/supabase/client';

interface Props {
  orderId: string;
  isAdmin: boolean;
  currentRoles: string[];
  /** 是否有权查看价格敏感单据（PI/CI），由父组件根据角色+订单归属判定 */
  canViewPriceDocs?: boolean;
}

const ALL_DOC_TABS: { key: DocumentType; label: string; icon: string; priceSensitive?: boolean }[] = [
  { key: 'pi', label: 'PI', icon: '📄', priceSensitive: true },
  { key: 'production_sheet', label: '生产单', icon: '🏭' },
  { key: 'packing_list', label: '装箱单', icon: '📦' },
  { key: 'ci', label: 'CI', icon: '💰', priceSensitive: true },
];

export function DocumentCenterTab({ orderId, isAdmin, currentRoles, canViewPriceDocs }: Props) {
  // 是否可见价格单据：管理员、财务、或父组件明确传入 canViewPriceDocs
  const showPriceDocs = isAdmin || currentRoles.includes('finance') || canViewPriceDocs === true;
  const DOC_TABS = showPriceDocs ? ALL_DOC_TABS : ALL_DOC_TABS.filter(t => !t.priceSensitive);
  const [docs, setDocs] = useState<any[]>([]);
  const [activeDocType, setActiveDocType] = useState<DocumentType>(showPriceDocs ? 'pi' : 'production_sheet');
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

    setUploading(true);

    try {
      const supabase = createClient();
      const path = `${orderId}/documents/${activeDocType}_${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type, upsert: false });
      if (uploadErr) { alert('文件上传失败: ' + uploadErr.message); setUploading(false); return; }

      const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(path);

      const result = await uploadDocument(orderId, activeDocType, file.name, path, urlData?.publicUrl || path);
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

          {/* 提交审核 */}
          {doc.status === 'draft' && (
            <button onClick={() => handleSubmit(doc.id)} disabled={isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              提交审核
            </button>
          )}

          {/* 审批操作（管理员或财务） */}
          {doc.status === 'pending_review' && (isAdmin || currentRoles.includes('finance')) && (
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

  return (
    <div className="space-y-6">
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

      {/* 操作按钮 */}
      <div className="flex gap-3 flex-wrap">
        <button onClick={handleAIGenerate} disabled={generating}
          className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
          {generating ? '🤖 AI生成中...' : `🤖 AI生成${DOCUMENT_TYPES[activeDocType].label}`}
        </button>

        <label className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 cursor-pointer">
          {uploading ? '📤 上传中...' : `📤 上传${DOCUMENT_TYPES[activeDocType].label}`}
          <input type="file" className="hidden" onChange={handleUpload} disabled={uploading}
            accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png" />
        </label>
      </div>

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
    </div>
  );
}
