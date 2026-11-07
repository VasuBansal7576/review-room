(function (root) {
  'use strict';
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function latestStrokes(events) {
    const strokes = new Map();
    for (const event of events) if (event.type === 'stroke') {
      const key = event.data?.strokeId || event.id || event, old = strokes.get(key), at = event.data?.reviewId && Number.isFinite(event.data.startedAt) ? event.data.startedAt : Date.parse(event.at);
      const firstAt = Math.min(...[old?.at, at].filter(Number.isFinite));
      if (!old || (event.data?.seq || 0) >= (old.seq || 0)) strokes.set(key, { ...event.data, author: event.author, at: firstAt });
      else old.at = firstAt;
    }
    return [...strokes.values()].filter(s => !s.undone);
  }
  function recordings(events) {
    const deleted = new Set(events.filter(e => e.type === 'recording_deleted').map(e => e.data?.url));
    return events.filter(e => e.type === 'recording' && e.data?.url && !deleted.has(e.data.url) && Number.isFinite(e.data.startedAt))
      .sort((a, b) => b.data.startedAt - a.data.startedAt);
  }
  function eventsForRecording(events, recordingId) {
    const recording = recordings(events).find(e => e.id === recordingId);
    if (!recording) throw new Error('Recording is unavailable');
    const start = recording.data.startedAt;
    const end = Number.isFinite(recording.data.endedAt) ? recording.data.endedAt : Date.parse(recording.at);
    if (!Number.isFinite(end) || end < start) throw new Error('Recording timing is unavailable');
    return events.filter(e => e === recording || (['stroke', 'note'].includes(e.type) && Date.parse(e.at) >= start && Date.parse(e.at) <= end));
  }
  function recordingAt(live, at) { return live.find(r => at >= r.data.startedAt && at <= (Number.isFinite(r.data.endedAt) ? r.data.endedAt : Date.parse(r.at))); }
  function markers(events) {
    const live = recordings(events);
    const origin = Math.min(...live.map(r => r.data.startedAt), ...events.map(e => e.data?.reviewStartedAt).filter(Number.isFinite), ...events.map(e => Date.parse(e.at)).filter(Number.isFinite));
    const items = latestStrokes(events).filter(s => s.points?.length && Number.isFinite(s.at)).map(s => ({ kind: s.kind || (s.points.length <= 2 ? 'clicked' : 'drawing'), at: s.at, author: s.author || 'Someone', points: s.points, color: s.color, strokeId: s.strokeId, reviewId: s.reviewId, source: s.source, text: s.text || (s.points.length <= 2 ? `at ${Math.round(s.points[0].x * 100)}%, ${Math.round(s.points[0].y * 100)}%` : `${s.points.length}-point mark`) }));
    for (const e of events) if (e.type === 'note' && Number.isFinite(Date.parse(e.at))) items.push({ kind: 'note', at: Date.parse(e.at), author: e.author || 'Someone', text: e.data?.text || '', source: e.data?.source, reviewId: e.data?.reviewId });
    items.sort((a, b) => a.at - b.at);
    for (const item of items) { const rec = recordingAt(live, item.at); item.recording = rec?.data.url || null; item.t = clock(item.at - (rec ? rec.data.startedAt : origin)); }
    return items;
  }
  function transcript(room, events, href = '') {
    const list = markers(events);
    if (events.some(e => e.data?.reviewId)) return reviewTranscript(room, list, href);
    const lines = list.map(m => `- ${m.t} [${m.kind}] ${m.author}: ${m.text}${m.recording ? ` (${m.recording})` : ''}`);
    return `# ${room?.name || 'Review'} · review package\n${room?.url || ''}\n\nMarkers: ${list.filter(m => m.kind === 'clicked').length} clicked · ${list.filter(m => m.kind === 'drawing').length} drawing · ${list.filter(m => m.kind === 'note').length} note\n\nTimes beside a recording link are relative to that recording. Other times are relative to the room timeline. This is a marker transcript, not speech transcription. [clicked] means a short drawing mark, not a captured page click.\n\n${lines.join('\n') || '- No markers yet'}\n${href ? `\nReview room: ${href}\n` : ''}`;
  }
  function releaseVideo(video) { video.pause(); video.removeAttribute('src'); video.load(); }
  function waitForVideo(video, event, action) {
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); video.removeEventListener(event, ready); video.removeEventListener('error', failed); error ? reject(error) : resolve(); };
      const ready = () => finish(), failed = () => finish(new Error('Recording could not be loaded'));
      const timer = setTimeout(() => finish(new Error('Recording frame timed out')), 5000);
      video.addEventListener(event, ready, { once: true }); video.addEventListener('error', failed, { once: true });
      try { action(); } catch (error) { finish(error); }
    });
  }
  async function frameAt(url, ms) {
    const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.crossOrigin = 'anonymous';
    try {
      await waitForVideo(video, 'loadeddata', () => { video.src = url; });
      const target = Math.max(0, Math.min(ms / 1000, Number.isFinite(video.duration) ? Math.max(0, video.duration - .001) : Infinity));
      if (Math.abs(video.currentTime - target) > .001) await waitForVideo(video, 'seeked', () => { video.currentTime = target; });
      if (Math.abs(video.currentTime - target) > .1) throw new Error('Recording frame could not be sought');
      if (!video.videoWidth || !video.videoHeight) throw new Error('Recording has no video frame');
      return video;
    } catch (error) { releaseVideo(video); throw error; }
  }
  function reviewTranscript(room, list, href) {
    const lines = list.map((m, i) => `#${i + 1} (${m.t}) [${m.kind}] ${JSON.stringify(m.text || '')}`);
    const speech = list.some(m => m.source === 'speech');
    return `# ${room?.name || 'Review'}\n${room?.url || ''}\n\n${lines.join('\n') || 'No feedback captured.'}\n\n${speech ? 'Speech: browser speech recognition; verify names and wording.' : 'Speech: no recognized speech. Text comes from typed notes and drawing/click markers.'}\nClicks mark the review surface; they do not click through to the shared tab. Ink is preserved in this collage, not baked into the optional screen recording.\n${href ? `\nReview room: ${href}\n` : ''}`;
  }
  function cropBox(points, width, height) {
    const xs = points.map(p => p.x * width), ys = points.map(p => p.y * height);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const aspect = 2.5;
    let w = Math.max(width * .45, maxX - minX + width * .12, (maxY - minY + height * .16) * aspect);
    w = Math.min(width, w); let h = Math.min(height, w / aspect);
    if (maxY - minY > h - 20) { h = Math.min(height, maxY - minY + height * .12); w = Math.min(width, h * aspect); }
    return { x: Math.max(0, Math.min(width - w, (minX + maxX - w) / 2)), y: Math.max(0, Math.min(height - h, (minY + maxY - h) / 2)), width: w, height: h };
  }
  async function collage(room, events, extraImages = []) {
    const all = markers(events), list = all.map((m, i) => ({ ...m, number: i + 1 })).filter(m => m.kind !== 'note').slice(-20), recs = recordings(events);
    const W = 896, H = 340, pad = 32, head = 108, gap = 58;
    const canvas = document.createElement('canvas'); canvas.width = W + pad * 2; canvas.height = head + Math.max(1, list.length + extraImages.length) * (H + gap) + pad; canvas.reviewWarnings = [];
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#171717'; ctx.font = '600 26px -apple-system, sans-serif'; ctx.fillText(room?.name || 'Review', pad, 44); ctx.font = '13px -apple-system, sans-serif'; ctx.fillStyle = '#777777'; ctx.fillText((room?.url || '').slice(0, 115), pad, 70);
    if (!list.length && !extraImages.length) { ctx.fillStyle = '#fafafa'; ctx.fillRect(pad, head, W, H); ctx.fillStyle = '#777'; ctx.font = '16px -apple-system, sans-serif'; ctx.fillText('No drawings or clicks. Your notes are in the transcript.', pad + 28, head + H / 2); }
    for (let i = 0; i < list.length; i++) {
      const m = list[i], x = pad, y = head + i * (H + gap); let frame, video, warning;
      ctx.fillStyle = '#f6f6f6'; ctx.fillRect(x, y, W, H);
      try {
        const captured = root.reviewFrames?.get(m.strokeId);
        if (captured) { frame = new Image(); frame.src = captured; await frame.decode(); }
        else { const rec = m.recording && recordingAt(recs, m.at); if (rec) frame = video = await frameAt(m.recording, m.at - rec.data.startedAt); }
        if (!frame) throw new Error('No captured frame for this marker');
        const fw = frame.videoWidth || frame.naturalWidth, fh = frame.videoHeight || frame.naturalHeight;
        const crop = cropBox(m.points, fw, fh), scale = Math.min(W / crop.width, H / crop.height), dx = x + (W - crop.width * scale) / 2, dy = y + (H - crop.height * scale) / 2;
        ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, dx, dy, crop.width * scale, crop.height * scale);
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, W, H); ctx.clip(); ctx.strokeStyle = '#FF453A'; ctx.lineWidth = 5; ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath();
        m.points.forEach((p, j) => ctx[j ? 'lineTo' : 'moveTo'](dx + (p.x * fw - crop.x) * scale, dy + (p.y * fh - crop.y) * scale)); ctx.stroke();
        if (m.kind === 'clicked') { ctx.beginPath(); ctx.arc(dx + (m.points[0].x * fw - crop.x) * scale, dy + (m.points[0].y * fh - crop.y) * scale, 14, 0, Math.PI * 2); ctx.stroke(); } ctx.restore();
      } catch (error) { warning = error.message; canvas.reviewWarnings.push(`#${m.number}: ${warning}`); ctx.fillStyle = '#888'; ctx.font = '14px -apple-system, sans-serif'; ctx.fillText('Frame unavailable — see the timestamped marker below.', x + 24, y + H / 2); }
      finally { if (video) releaseVideo(video); }
      ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, W - 1, H - 1);
      ctx.fillStyle = '#FF453A'; ctx.beginPath(); ctx.arc(x + 26, y + 26, 18, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 16px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(m.number), x + 26, y + 26); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#555'; ctx.font = '13px -apple-system, sans-serif'; ctx.fillText(`#${m.number}  (${m.t})  [${m.kind}]  ${(m.text || '').slice(0, 105)}`, x, y + H + 26);
    }
    for (let i = 0; i < extraImages.length; i++) { const y = head + (list.length + i) * (H + gap); ctx.drawImage(extraImages[i], pad, y, W, H); }
    return canvas;
  }
  function save(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  async function download(room, events, href, options = {}) {
    if (options.recordingId) events = eventsForRecording(events, options.recordingId);
    const slug = (room?.name || 'review').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'review';
    const extra = options.recordingId ? [] : [...document.querySelectorAll('.revision-frames img')].filter(i => i.complete && i.naturalWidth).slice(-3);
    const canvas = await collage(room, events, extra);
    const text = transcript(room, events, href) + (canvas.reviewWarnings.length ? `\nFrame warnings:\n${canvas.reviewWarnings.map(w => `- ${w}`).join('\n')}\n` : '');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Collage could not be exported');
    save(`${slug}-review-package.md`, new Blob([`${text}\n![collage](${slug}-collage.png)\n`], { type: 'text/markdown' }));
    save(`${slug}-collage.png`, blob);
    return text;
  }
  const api = { markers, transcript, collage, download, eventsForRecording, cropBox };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.reviewPackage = api;
})(typeof window === 'undefined' ? globalThis : window);
