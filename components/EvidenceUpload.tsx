'use client';

import { useState, useEffect } from 'react';
import { uploadEvidence, deleteAttachment, getAttachmentsByMilestone, type Attachment } from '@/app/actions/attachments';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';

interface EvidenceUploadProps {
  milestoneId: string;
  orderId: string;
  evidenceRequired: boolean;
}

export function EvidenceUpload({ milestoneId, orderId, evidenceRequired }: EvidenceUploadProps) {
  const router = useRouter();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAttachments();
  }, [milestoneId]);

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

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);

    const result = await uploadEvidence(milestoneId, orderId, file);

    if (result.data) {
      await loadAttachments();
      event.target.value = ''; // Reset input
    } else {
      setError(result.error || '上传失败');
    }

    setUploading(false);
    router.refresh();
  }

  async function handleDelete(attachmentId: string) {
    if (!confirm('确定要删除该文件吗？')) {
      return;
    }

    setLoading(true);
    const result = await deleteAttachment(attachmentId, orderId);

    if (!result.error) {
      await loadAttachments();
      router.refresh();
    } else {
      setError(result.error);
    }

    setLoading(false);
  }

  if (!evidenceRequired) {
    return null;
  }

  return (
    <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-gray-900">需要上传凭证</h4>
        {attachments.length > 0 && (
          <span className="text-sm text-green-700 bg-green-100 px-2 py-1 rounded">
            ✓ 已上传 {attachments.length} 个文件
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-100 border border-red-300 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="mb-3">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          上传凭证文件
        </label>
        <input
          type="file"
          onChange={handleFileUpload}
          disabled={uploading}
          className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-white focus:outline-none disabled:opacity-50"
        />
        {uploading && (
          <p className="mt-1 text-sm text-gray-600">上传中...</p>
        )}
      </div>

      {loading && attachments.length === 0 ? (
        <p className="text-sm text-gray-600">加载中...</p>
      ) : attachments.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">已上传文件：</p>
          <ul className="space-y-2">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center justify-between p-2 bg-white border border-gray-200 rounded"
              >
                <div className="flex-1">
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                  >
                    {attachment.file_name || '未命名文件'}
                  </a>
                  <p className="text-xs text-gray-600 mt-1">
                    上传于 {formatDate(attachment.created_at)}
                    {attachment.file_type && ` • ${attachment.file_type}`}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(attachment.id)}
                  disabled={loading}
                  className="ml-2 text-red-600 hover:text-red-700 text-sm disabled:opacity-50"
                  title="删除文件"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-orange-700 bg-orange-100 p-2 rounded">
          ⚠️ 尚未上传凭证。标记完成前，请至少上传一个文件。
        </p>
      )}
    </div>
  );
}
