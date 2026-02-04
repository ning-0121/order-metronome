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
      setError(result.error || 'Upload failed');
    }
    
    setUploading(false);
    router.refresh();
  }

  async function handleDelete(attachmentId: string) {
    if (!confirm('Are you sure you want to delete this file?')) {
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
        <h4 className="font-semibold text-gray-900">Evidence Required</h4>
        {attachments.length > 0 && (
          <span className="text-sm text-green-700 bg-green-100 px-2 py-1 rounded">
            ✓ {attachments.length} file{attachments.length > 1 ? 's' : ''} uploaded
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
          Upload Evidence File
        </label>
        <input
          type="file"
          onChange={handleFileUpload}
          disabled={uploading}
          className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-white focus:outline-none disabled:opacity-50"
        />
        {uploading && (
          <p className="mt-1 text-sm text-gray-600">Uploading...</p>
        )}
      </div>

      {loading && attachments.length === 0 ? (
        <p className="text-sm text-gray-600">Loading attachments...</p>
      ) : attachments.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">Uploaded Files:</p>
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
                    {attachment.file_name || 'Unnamed file'}
                  </a>
                  <p className="text-xs text-gray-600 mt-1">
                    Uploaded {formatDate(attachment.created_at)}
                    {attachment.file_type && ` • ${attachment.file_type}`}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(attachment.id)}
                  disabled={loading}
                  className="ml-2 text-red-600 hover:text-red-700 text-sm disabled:opacity-50"
                  title="Delete file"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-orange-700 bg-orange-100 p-2 rounded">
          ⚠️ No evidence uploaded yet. You must upload at least one file before marking this milestone as done.
        </p>
      )}
    </div>
  );
}
