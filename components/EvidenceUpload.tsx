'use client';

import { useState, useEffect } from 'react';
import { uploadEvidence, deleteAttachment, getAttachmentsByMilestone, getRequiredDocumentsStatus, type Attachment } from '@/app/actions/attachments';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';
import {
  type DocumentType,
  DOC_TYPE_LABELS,
  getAvailableDocTypes,
  getDefaultDocType,
  getDocTypeLabel,
} from '@/lib/domain/required-documents';

interface EvidenceUploadProps {
  milestoneId: string;
  orderId: string;
  evidenceRequired: boolean;
  stepKey?: string;
  onRequiredDocsChange?: (isComplete: boolean) => void;
}

interface RequiredDocStatus {
  stepKey: string;
  requiredDocs: string[];
  optionalDocs: string[];
  uploadedDocs: { docType: string; fileName: string; id: string }[];
  missingDocs: string[];
  isComplete: boolean;
}

export function EvidenceUpload({
  milestoneId,
  orderId,
  evidenceRequired,
  stepKey = '',
  onRequiredDocsChange,
}: EvidenceUploadProps) {
  const router = useRouter();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocType, setSelectedDocType] = useState<DocumentType>(() =>
    getDefaultDocType(stepKey)
  );
  const [docStatus, setDocStatus] = useState<RequiredDocStatus | null>(null);

  // Get available doc types for this milestone
  const availableDocTypes = getAvailableDocTypes(stepKey);

  useEffect(() => {
    loadAttachments();
    loadDocStatus();
  }, [milestoneId]);

  useEffect(() => {
    // Notify parent of required docs completion status
    if (onRequiredDocsChange && docStatus) {
      onRequiredDocsChange(docStatus.isComplete);
    }
  }, [docStatus, onRequiredDocsChange]);

  async function loadAttachments() {
    setLoading(true);
    const result = await getAttachmentsByMilestone(milestoneId);
    if (result.data) {
      setAttachments(result.data);
    } else if (result.error) {
      setError(result.error);
    }
    setLoading(false);
  }

  async function loadDocStatus() {
    const result = await getRequiredDocumentsStatus(milestoneId);
    if (!result.error) {
      setDocStatus(result);
    }
  }

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);

    const result = await uploadEvidence(milestoneId, orderId, file, selectedDocType);

    if (result.data) {
      await loadAttachments();
      await loadDocStatus();
      event.target.value = ''; // Reset input

      // Auto-select next missing doc type if available
      if (docStatus && docStatus.missingDocs.length > 1) {
        const nextMissing = docStatus.missingDocs.find(d => d !== selectedDocType);
        if (nextMissing) {
          setSelectedDocType(nextMissing as DocumentType);
        }
      }
    } else {
      setError(result.error || '上传失败');
    }

    setUploading(false);
    router.refresh();
  }

  async function handleDelete(attachmentId: string) {
    if (!confirm('确定要删除此文件吗？')) {
      return;
    }

    setLoading(true);
    const result = await deleteAttachment(attachmentId, orderId);

    if (!result.error) {
      await loadAttachments();
      await loadDocStatus();
      router.refresh();
    } else {
      setError(result.error);
    }

    setLoading(false);
  }

  // Render required docs checklist
  function renderRequiredDocsChecklist() {
    if (!docStatus || docStatus.requiredDocs.length === 0) {
      return null;
    }

    const uploadedTypes = new Set(docStatus.uploadedDocs.map(d => d.docType));

    return (
      <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <h5 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
          <span>📋</span>
          必要文件清单
          {docStatus.isComplete ? (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
              ✓ 已完成
            </span>
          ) : (
            <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">
              缺少 {docStatus.missingDocs.length} 项
            </span>
          )}
        </h5>
        <ul className="space-y-1">
          {docStatus.requiredDocs.map((docType) => {
            const isUploaded = uploadedTypes.has(docType);
            const uploaded = docStatus.uploadedDocs.find(d => d.docType === docType);
            return (
              <li
                key={docType}
                className={`flex items-center justify-between text-sm py-1 px-2 rounded ${
                  isUploaded ? 'bg-green-50 text-green-700' : 'bg-white text-gray-600'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={isUploaded ? 'text-green-500' : 'text-gray-300'}>
                    {isUploaded ? '✓' : '○'}
                  </span>
                  {getDocTypeLabel(docType)}
                  <span className="text-xs text-red-500">*必填</span>
                </span>
                {uploaded && (
                  <span className="text-xs text-gray-500 truncate max-w-32">
                    {uploaded.fileName}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {/* Optional docs */}
        {docStatus.optionalDocs.length > 0 && (
          <>
            <h5 className="text-sm font-medium text-gray-500 mt-3 mb-1">可选文件</h5>
            <ul className="space-y-1">
              {docStatus.optionalDocs.map((docType) => {
                const isUploaded = uploadedTypes.has(docType);
                const uploaded = docStatus.uploadedDocs.find(d => d.docType === docType);
                return (
                  <li
                    key={docType}
                    className={`flex items-center justify-between text-sm py-1 px-2 rounded ${
                      isUploaded ? 'bg-blue-50 text-blue-700' : 'bg-white text-gray-500'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={isUploaded ? 'text-blue-500' : 'text-gray-300'}>
                        {isUploaded ? '✓' : '○'}
                      </span>
                      {getDocTypeLabel(docType)}
                    </span>
                    {uploaded && (
                      <span className="text-xs text-gray-500 truncate max-w-32">
                        {uploaded.fileName}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    );
  }

  // Show component even if evidenceRequired is false, but with different messaging
  const hasRequiredDocs = docStatus && docStatus.requiredDocs.length > 0;

  if (!evidenceRequired && !hasRequiredDocs) {
    return null;
  }

  return (
    <div className="mt-4 p-4 bg-blue-50/50 border border-blue-200/60 rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-gray-900 flex items-center gap-2">
          <span>📎</span>
          证据文件
        </h4>
        {attachments.length > 0 && (
          <span className="text-sm text-green-700 bg-green-100 px-2 py-1 rounded-full">
            ✓ 已上传 {attachments.length} 个文件
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Required docs checklist */}
      {renderRequiredDocsChecklist()}

      {/* Upload form */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Doc type selector */}
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              文件类型
            </label>
            <select
              value={selectedDocType}
              onChange={(e) => setSelectedDocType(e.target.value as DocumentType)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              {availableDocTypes.map((docType) => {
                const isMissing = docStatus?.missingDocs.includes(docType);
                const isRequired = docStatus?.requiredDocs.includes(docType);
                return (
                  <option key={docType} value={docType}>
                    {getDocTypeLabel(docType)}
                    {isRequired && ' *'}
                    {isMissing && ' (待上传)'}
                  </option>
                );
              })}
            </select>
          </div>

          {/* File input */}
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              选择文件
            </label>
            <input
              type="file"
              onChange={handleFileUpload}
              disabled={uploading}
              className="w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-white file:mr-3 file:py-2 file:px-4 file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 focus:outline-none disabled:opacity-50"
            />
          </div>
        </div>
        {uploading && (
          <p className="text-sm text-indigo-600 animate-pulse">正在上传...</p>
        )}
      </div>

      {/* Uploaded files list */}
      {loading && attachments.length === 0 ? (
        <p className="text-sm text-gray-600">加载附件中...</p>
      ) : attachments.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">已上传文件：</p>
          <ul className="space-y-2">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center justify-between p-3 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition-shadow"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 hover:text-indigo-700 text-sm font-medium truncate"
                    >
                      {attachment.file_name || '未命名文件'}
                    </a>
                    {attachment.doc_type && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full whitespace-nowrap">
                        {getDocTypeLabel(attachment.doc_type)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    上传于 {formatDate(attachment.created_at)}
                    {attachment.file_type && ` • ${attachment.file_type}`}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(attachment.id)}
                  disabled={loading}
                  className="ml-3 p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                  title="删除文件"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : hasRequiredDocs ? (
        <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
          <p className="text-sm text-orange-700 flex items-center gap-2">
            <span>⚠️</span>
            请上传必要的证据文件后，才能标记此里程碑为完成状态。
          </p>
        </div>
      ) : (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-700 flex items-center gap-2">
            <span>⚠️</span>
            尚未上传任何文件。请至少上传一个证据文件。
          </p>
        </div>
      )}
    </div>
  );
}
