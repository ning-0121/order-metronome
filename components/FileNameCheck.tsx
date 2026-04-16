'use client';

/**
 * 文件命名检查徽章 — 用在所有上传文件的地方
 *
 * 用法：
 *   <FileNameCheck
 *     file={selectedFile}
 *     stepKey="procurement_order_placed"
 *     orderNo="QM-20260415-001"
 *     onRename={renamedFile => setFile(renamedFile)}
 *   />
 *
 * 行为：
 *   - 文件名符合规范 → 显示绿色"✓ 命名规范"
 *   - 不符合 → 显示黄色提示 + 推荐命名 + [应用推荐]/[保持原名] 按钮
 *   - 用户点"应用推荐"后调用 onRename，返回一个重命名后的新 File
 *   - 软提示，不阻塞上传
 */

import { useState, useMemo } from 'react';
import { validateFileName, renameFile } from '@/lib/domain/fileNaming';

interface Props {
  /** 待校验的文件（如已上传或已选） */
  file: File | { name: string } | null;
  /** 节点 step_key — 用于判断推荐命名 */
  stepKey: string;
  /** 订单号 — 用于生成推荐命名 */
  orderNo?: string | null;
  /**
   * 重命名回调 — 仅当 file 是真实的 File 对象时才能重命名
   * 如果 file 是只读信息（如已上传的附件），可以省略此回调
   */
  onRename?: (renamedFile: File) => void;
  /** 紧凑模式 — 只显示一行，不显示建议 */
  compact?: boolean;
}

export function FileNameCheck({ file, stepKey, orderNo, onRename, compact }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const check = useMemo(() => {
    if (!file?.name) return null;
    return validateFileName(file.name, stepKey, orderNo);
  }, [file?.name, stepKey, orderNo]);

  if (!file || !check) return null;

  // 已通过 — 紧凑提示
  if (check.ok) {
    if (compact) return null;
    return (
      <div className="mt-1 text-[11px] text-green-600 flex items-center gap-1">
        <span>✓</span>
        <span>命名规范</span>
      </div>
    );
  }

  if (dismissed) return null;

  const isRealFile = file instanceof File;
  const canRename = isRealFile && !!onRename;

  const handleApply = () => {
    if (canRename && onRename) {
      const newName = editing ? editValue.trim() : check.suggestion;
      if (!newName) return;
      onRename(renameFile(file as File, newName));
      setEditing(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px]">
      <div className="flex items-start gap-1.5 text-amber-800">
        <span className="flex-shrink-0">⚠️</span>
        <div className="flex-1 min-w-0">
          <p className="font-medium">文件名不符合规范</p>
          <ul className="mt-0.5 space-y-0.5 text-amber-700">
            {check.issues.map((issue, i) => (
              <li key={i}>· {issue.message}</li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 text-amber-500 hover:text-amber-700"
          title="忽略"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-amber-700">推荐：</span>
        {editing ? (
          <input
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            className="flex-1 min-w-0 px-1.5 py-0.5 border border-amber-300 rounded text-amber-900 bg-white font-mono text-[11px]"
            autoFocus
          />
        ) : (
          <code className="px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-900 font-mono break-all">
            {check.suggestion}
          </code>
        )}
      </div>

      {canRename && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={handleApply}
            className="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700 font-medium"
          >
            {editing ? '应用' : '应用推荐命名'}
          </button>
          {!editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setEditValue(check.suggestion);
              }}
              className="px-2 py-0.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-100"
            >
              手动改名
            </button>
          )}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-2 py-0.5 rounded text-amber-600 hover:underline"
          >
            保持原名
          </button>
        </div>
      )}

      {!canRename && (
        <p className="mt-1.5 text-amber-600">
          * 建议改名后重新上传
        </p>
      )}
    </div>
  );
}
