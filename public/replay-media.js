(function (root) {
  function durationSeconds(data = {}, nativeDuration) {
    const { startedAt, endedAt } = data;
    if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt) return (endedAt - startedAt) / 1000;
    return Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : null;
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Duration unavailable';
    const whole = Math.max(1, Math.round(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }
  function showDuration(video, label, data) {
    const update = () => {
      const seconds = durationSeconds(data, video.duration);
      label.textContent = formatDuration(seconds);
      if (seconds !== null) label.dataset.durationSeconds = String(seconds);
      else delete label.dataset.durationSeconds;
    };
    video.addEventListener('loadedmetadata', update);
    video.addEventListener('durationchange', update);
    update();
  }
  async function downloadRecording(url, filename, options = {}) {
    const request = options.request || fetch;
    const doc = options.document || document;
    const urls = options.urls || URL;
    const schedule = options.schedule || setTimeout;
    const target = new URL(url, doc.baseURI);
    if (target.origin !== new URL(doc.baseURI).origin || !/^\/recordings\/[a-f0-9]{32}\/[a-f0-9]{32}$/.test(target.pathname) || target.search || target.hash) throw new Error('Invalid recording URL');
    const response = await request(target.href, { credentials: 'same-origin', redirect: 'follow' });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    let blob = await response.blob();
    if (!blob.size) throw new Error('Recording download was empty');
    if (!/^video\/webm(?:;|$)/i.test(blob.type) && blob.type !== 'application/octet-stream') throw new Error('Invalid recording download');
    if (Number.isFinite(options.durationMs) && options.durationMs > 0) {
      const fix = options.fixDuration || root.webmDuration?.fixDuration;
      if (!fix) throw new Error('Recording duration repair is unavailable');
      blob = await fix(blob, options.durationMs);
    }
    const objectUrl = urls.createObjectURL(blob);
    const anchor = doc.createElement('a');
    try {
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.hidden = true;
      doc.body.append(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      schedule(() => urls.revokeObjectURL(objectUrl), 60000);
    }
    return blob.size;
  }
  const api = { durationSeconds, formatDuration, showDuration, downloadRecording };
  if (typeof module !== 'undefined') module.exports = api;
  else root.replayMedia = api;
})(typeof window === 'undefined' ? globalThis : window);
