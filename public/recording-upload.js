(function (root) {
  async function uploadRecording(roomId, blob, request = fetch) {
    if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error('No recording data was captured');
    if (blob.size > 50 * 1024 * 1024) throw new Error('Recording exceeds the 50 MB limit');
    const path = `/api/rooms/${encodeURIComponent(roomId)}/recordings`;
    const prepare = await request(`${path}/upload-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: blob.type || 'video/webm', size: blob.size })
    });
    if (prepare.status === 404 || prepare.status === 405) {
      const response = await request(path, { method: 'POST', headers: { 'Content-Type': blob.type || 'video/webm' }, body: blob });
      if (!response.ok) throw new Error('Upload failed');
      return response.json();
    }
    if (!prepare.ok) throw new Error('Could not prepare recording upload');
    const { uploadUrl, url } = await prepare.json();
    const target = new URL(uploadUrl);
    const recordingPrefix = `/recordings/${roomId}/`;
    if (target.protocol !== 'https:' || typeof url !== 'string' || !url.startsWith(recordingPrefix) || !/^[a-f0-9]{32}$/.test(url.slice(recordingPrefix.length))) throw new Error('Invalid upload destination');
    const response = await request(target.href, { method: 'PUT', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': blob.type || 'video/webm' }, body: blob });
    if (!response.ok) throw new Error('Upload failed');
    return { url };
  }
  if (typeof module !== 'undefined') module.exports = { uploadRecording };
  else root.uploadRecording = uploadRecording;
})(typeof window === 'undefined' ? globalThis : window);
