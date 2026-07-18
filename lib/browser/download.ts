const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function base64ToBlob(base64: string, mimeType = XLSX_MIME) {
  const normalized = String(base64 || '').replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function triggerBlobDownload(blob: Blob, fileName: string, revokeDelayMs = 250) {
  if (typeof document === 'undefined') throw new Error('DOWNLOAD_NOT_SUPPORTED');
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('DOWNLOAD_NOT_SUPPORTED');

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
  }

  return url;
}

