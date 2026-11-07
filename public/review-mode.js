/* Focused review controller. Existing room/auth/upload paths stay authoritative. */
(() => {
  'use strict';
  let ownedMic = false;
  let active = false, shift = false, startedAt = 0, reviewId = null, timer, fadeFrame, recognition, speechFailed = false, finishing = false, pending = [], lastStroke = null, resultBlob = null, resultText = '', resultUrl = null;
  const completed = new Map(), sessionStrokes = [], frames = window.reviewFrames = new Map();
  const el = (tag, attrs = {}) => Object.assign(document.createElement(tag), attrs);
  const options = el('div', { className: 'review-options' });
  options.innerHTML = '<label><input id="reviewSaveVideo" type="checkbox" checked> Save screen recording</label><label title="Uses your browser’s speech recognition service, when available"><input id="reviewSpeech" type="checkbox" checked> Microphone + transcript</label><span>Shift to draw · clicks become markers</span>';
  document.querySelector('.below-stage').after(options);
  const pill = el('div', { className: 'review-pill hidden' });
  pill.setAttribute('role', 'toolbar'); pill.setAttribute('aria-label', 'Review controls');
  pill.innerHTML = '<i class="live-dot"></i><time id="reviewTimer">0:00</time><span class="review-divider"></span><button id="undoReview" type="button">Undo</button><button id="cancelReview" type="button">Cancel</button><button id="finishReview" type="button">Finish ↗</button>';
  const note = el('div', { className: 'review-note hidden' });
  note.innerHTML = '<div class="review-hint"><span>Hold <kbd>Shift</kbd> + move to draw · click to mark</span><span id="reviewSpeechStatus">Typed notes ready</span></div><form id="reviewNoteForm"><input id="reviewNoteInput" aria-label="Review note" placeholder="Say it out loud, or type a note…" maxlength="500"><button type="submit">Add note ↵</button></form><div id="speechPreview" aria-live="polite"></div>';
  const result = el('section', { className: 'review-result hidden' });
  result.setAttribute('aria-label', 'Finished review package');
  result.innerHTML = '<header class="result-head"><div><span class="section-kicker">REVIEW COMPLETE</span><h2>Every detail, ready to hand off.</h2><p id="resultSummary">Collage + timestamped transcript</p></div><div class="result-actions"><button class="button subtle" id="closeReviewResult">Back to room</button><button class="button subtle" id="saveReviewResult">Download</button><button class="button dark" id="copyReviewResult">Copy package ↗</button></div></header><div class="result-body"><p class="result-intro">Paste into your coding agent. Numbered frames and matching transcript lines give every change a place and a moment. Your agent proposes the change; you review the preview.</p><div id="resultStatus" class="result-status" role="status"></div><div class="result-grid"><section class="result-frames"><div class="result-section-label"><span>01 / THE MOMENTS</span><span>NUMBERED + MARKED</span></div><img id="reviewCollage" alt="Vertical collage of review crops with permanent red ink and numbered red badges"></section><section class="result-words"><div class="result-section-label"><span>02 / THE CONTEXT</span><span>TIMESTAMPED</span></div><h3>In your words.</h3><pre id="reviewTranscript" class="result-transcript"></pre><div class="result-next"><span>WHAT HAPPENS NEXT</span><h3>Give your agent the full picture.</h3><p>Copy this package into your coding agent, or return to the room to request a Switch revision. Review the proposal before you approve its matching preview.</p></div></section></div></div>';
  document.body.append(pill, note, result);
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function saveEvent(type, data) { const promise = postEvent(type, { ...data, reviewId, reviewStartedAt: startedAt }).then(e => { receive(e); return e; }).catch(error => { toast(`Could not save feedback: ${error.message}`); throw error; }); pending.push(promise); return promise; }
  function capture(stroke) {
    const v = $('sharedVideo'); if (!v.videoWidth || !v.videoHeight) return;
    try { const c = document.createElement('canvas'); const ratio = Math.min(1, 1600 / v.videoWidth); c.width = Math.round(v.videoWidth * ratio); c.height = Math.round(v.videoHeight * ratio); c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); frames.set(stroke.strokeId, c.toDataURL('image/jpeg', .85)); } catch { /* package will use saved recording frame, if available */ }
  }
  function begin(e, kind) { const p = point(e); state.drawing = { strokeId: crypto.randomUUID(), color: '#FF453A', seq: 0, points: [p], reviewId, reviewStartedAt: startedAt, kind, startedAt: Date.now() }; capture(state.drawing); redraw(); }
  function endStroke() {
    if (!state.drawing) return; const stroke = state.drawing; state.drawing = null;
    if (stroke.points.length > 5000) stroke.points = stroke.points.filter((_, i) => i % Math.ceil(stroke.points.length / 5000) === 0);
    stroke.endedAt = Date.now(); completed.set(stroke.strokeId, stroke.endedAt); sessionStrokes.push(stroke); lastStroke = stroke; state.localStrokes.set(stroke.strokeId, stroke); pending.push(sendStroke(stroke)); redraw();
  }
  const old = { down: canvas.onpointerdown, move: canvas.onpointermove, up: canvas.onpointerup, cancel: canvas.onpointercancel };
  canvas.onpointerdown = e => { if (!active) return old.down(e); if (shift || e.shiftKey) { if (!state.drawing) begin(e, 'drawing'); } else { begin(e, 'clicked'); endStroke(); } };
  canvas.onpointermove = e => { if (!active) return old.move(e); if (!(shift || e.shiftKey)) return; if (!state.drawing) begin(e, 'drawing'); else { const p = point(e), last = state.drawing.points.at(-1); if (Math.hypot(p.x-last.x,p.y-last.y) < .001) return; state.drawing.points.push(p); redraw(); } };
  canvas.onpointerup = e => { if (!active) return old.up(e); if (!shift && !e.shiftKey) endStroke(); };
  canvas.onpointercancel = e => { if (!active) return old.cancel(e); endStroke(); };
  document.addEventListener('keydown', e => { if (active && e.key === 'Shift' && !e.target.closest('input,textarea')) { shift = true; document.body.classList.add('shift-ink'); } if (active && e.key === 'Escape') $('cancelReview').click(); });
  document.addEventListener('keyup', e => { if (e.key === 'Shift') { shift = false; document.body.classList.remove('shift-ink'); if (active) endStroke(); } });
  window.addEventListener('blur', () => { shift = false; document.body.classList.remove('shift-ink'); if (active) endStroke(); });
  function animate() { if (!active) return; redraw(); fadeFrame = requestAnimationFrame(animate); }
  function strokeOpacity(stroke) {
    if (stroke.undone) return 0; if (!active && !completed.has(stroke.strokeId) && !stroke.reviewId) return 1;
    if (state.drawing?.strokeId === stroke.strokeId) return 1;
    const ended = completed.get(stroke.strokeId) || stroke.endedAt;
    if (!ended) return active ? 0 : 1;
    return Math.max(0, 1 - Math.max(0, Date.now() - ended - 500) / 1800);
  }
  function stopSpeech() {
    const current = recognition; recognition = null; if (!current) return Promise.resolve();
    return new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; clearTimeout(timeout); resolve(); } }; const timeout = setTimeout(finish, 1000); current.onend = finish; try { current.stop(); } catch { finish(); } });
  }
  function releaseCapture() {
    if (state.screen) { state.screen.getTracks().forEach(t=>t.stop()); stopShare(); }
    if (ownedMic && state.stream) { const tracks = state.stream.getTracks(); for (const {pc} of state.peers.values()) for (const sender of pc.getSenders()) if (tracks.includes(sender.track)) pc.removeTrack(sender); tracks.forEach(t=>t.stop()); state.stream = null; $('micButton').classList.remove('on'); $('micButton').title='Join audio'; }
    ownedMic = false;
  }
  function startSpeech() {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!$('reviewSpeech').checked) { $('reviewSpeechStatus').textContent = 'Typed notes · microphone off'; return; }
    if (!Speech) { $('reviewSpeechStatus').textContent = 'Speech unavailable · type a note'; return; }
    speechFailed = false; recognition = new Speech(); recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language || 'en-US';
    recognition.onstart = () => { $('reviewSpeechStatus').textContent = 'Listening…'; };
    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.trim().slice(0, 500); if (!text) continue;
        if (event.results[i].isFinal) {
          if (lastStroke && Date.now() - lastStroke.endedAt < 10000 && !lastStroke.undone) { lastStroke.text = text; lastStroke.source = 'speech'; pending.push(sendStroke(lastStroke)); }
          else saveEvent('note', { text, source: 'speech' }).catch(() => {});
          $('speechPreview').textContent = text;
        } else interim += text;
      }
      if (interim) $('speechPreview').textContent = interim;
    };
    recognition.onerror = event => { if (event.error === 'no-speech' || event.error === 'aborted') return; speechFailed = true; $('reviewSpeechStatus').textContent = `Speech unavailable (${event.error}) · type a note`; };
    recognition.onend = () => { if (active && !speechFailed && recognition) { setTimeout(() => { if (active && recognition) try { recognition.start(); } catch {} }, 300); } };
    try { recognition.start(); } catch { $('reviewSpeechStatus').textContent = 'Speech unavailable · type a note'; }
  }
  function leaveFocus() { active = false; shift = false; document.body.classList.remove('reviewing','shift-ink'); pill.classList.add('hidden'); note.classList.add('hidden'); clearInterval(timer); cancelAnimationFrame(fadeFrame); stopSpeech(); redraw(); }
  $('startReview').onclick = async () => {
    if (!state.room || active) return; const button = $('startReview'); button.disabled = true;
    try {
      if (!state.screen?.getVideoTracks().some(t => t.readyState === 'live')) await $('shareScreen').onclick();
      if (!state.screen?.getVideoTracks().some(t => t.readyState === 'live')) return;
      ownedMic = $('reviewSpeech').checked && !state.stream; if (ownedMic) await $('micButton').onclick();
      if ($('reviewSaveVideo').checked) { await $('recordButton').onclick(); if (state.recorder?.state !== 'recording') return; }
      startedAt = Date.now(); reviewId = crypto.randomUUID(); sessionStrokes.length = 0; pending = []; lastStroke = null; state.color = '#FF453A'; active = true; finishing = false;
      document.body.classList.add('reviewing'); pill.classList.remove('hidden'); note.classList.remove('hidden'); $('reviewTimer').textContent = '0:00'; $('speechPreview').textContent = ''; $('finishReview').disabled = false;
      timer = setInterval(() => { $('reviewTimer').textContent = clock(Date.now()-startedAt); if (state.screen && !state.screen.getVideoTracks().some(t => t.readyState === 'live')) $('finishReview').click(); }, 200);
      startSpeech(); requestAnimationFrame(animate); toast('Hold Shift and move to draw. Release to fade. Click for a marker.');
    } finally { button.disabled = false; }
  };
  $('reviewNoteForm').onsubmit = async e => { e.preventDefault(); const input = $('reviewNoteInput'), text = input.value.trim(); if (!text) return; input.value = ''; await saveEvent('note', { text, source: 'typed' }).catch(() => {}); $('speechPreview').textContent = `Note added: ${text}`; };
  $('undoReview').onclick = async () => { endStroke(); const stroke = [...sessionStrokes].reverse().find(s => !s.undone); if (!stroke) return toast('No drawing or click to undo'); stroke.undone = true; state.localStrokes.set(stroke.strokeId,stroke); pending.push(sendStroke(stroke)); redraw(); };
  $('cancelReview').onclick = async () => { if (finishing) return; endStroke(); for (const stroke of sessionStrokes) { stroke.undone = true; pending.push(sendStroke(stroke)); } if (state.recorder?.state === 'recording') { state.cancelReviewRecording = true; state.recorder.stop(); } leaveFocus(); releaseCapture(); toast('Review cancelled. No package created. Typed notes remain in the room.'); };
  function packageEvents() { return [...state.events.values()].filter(e => e.data?.reviewId === reviewId || (e.type === 'recording' && e.data.startedAt <= startedAt && e.data.endedAt >= startedAt)); }
  async function copyPackage() {
    if (!resultBlob) return;
    const status = $('resultStatus');
    try {
      if (navigator.clipboard.write && window.ClipboardItem) {
        const html = `<img src="${resultUrl}" alt="Numbered review collage"><pre>${resultText.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</pre>`;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png':resultBlob, 'text/plain':new Blob([resultText],{type:'text/plain'}), 'text/html':new Blob([html],{type:'text/html'}) })]); status.textContent = 'Copied collage + transcript. Paste into your agent.'; status.dataset.copied = 'true';
      } else { await navigator.clipboard.writeText(resultText); status.textContent = 'Transcript copied. This browser cannot copy images; download the collage to attach it.'; }
      $('copyReviewResult').textContent = 'Copied ✓';
    } catch { status.textContent = 'Browser blocked automatic clipboard access. Click Copy package, or Download both files.'; $('copyReviewResult').textContent = 'Copy package ↗'; }
  }
  $('finishReview').onclick = async () => {
    if (!active || finishing) return; const reviewDuration = Date.now()-startedAt; finishing = true; $('finishReview').disabled = true; $('finishReview').textContent = 'Finishing…'; endStroke(); await stopSpeech();
    try {
      const remaining = $('reviewNoteInput').value.trim(); if (remaining) { await saveEvent('note', { text:remaining,source:'typed' }); $('reviewNoteInput').value=''; }
      await Promise.all(pending); await strokeQueue;
      if (state.recorder?.state === 'recording') state.recorder.stop();
      leaveFocus(); document.body.classList.add('review-result-open'); window.scrollTo(0,0); result.classList.remove('hidden'); $('resultStatus').textContent = 'Building your collage and transcript…'; delete $('resultStatus').dataset.copied; $('reviewCollage').removeAttribute('src'); $('reviewTranscript').textContent = ''; $('copyReviewResult').disabled = true; $('saveReviewResult').disabled = true;
      const deadline = Date.now()+45000; while (state.activeRecordingId && Date.now()<deadline) await new Promise(r=>setTimeout(r,150));
      releaseCapture();
      const events = packageEvents(); const c = await window.reviewPackage.collage(state.room,events); resultText = window.reviewPackage.transcript(state.room,events,location.href);
      if (c.reviewWarnings.length) resultText += '\nFrame warnings:\n'+c.reviewWarnings.join('\n');
      resultBlob = await new Promise(resolve=>c.toBlob(resolve,'image/png')); if (!resultBlob) throw new Error('Could not create collage');
      resultUrl = c.toDataURL('image/png'); $('reviewCollage').src = resultUrl; $('reviewTranscript').textContent = resultText;
      const markers = window.reviewPackage.markers(events); $('resultSummary').textContent = `${markers.length} moments · ${clock(reviewDuration)} · collage + transcript`;
      $('copyReviewResult').disabled = false; $('saveReviewResult').disabled = false; $('copyReviewResult').textContent='Copy package ↗'; await copyPackage();
    } catch (error) { toast(`Could not finish: ${error.message}`); $('resultStatus').textContent = `Could not finish: ${error.message}. Room events and recording recovery are retained.`; }
    finally { finishing = false; $('finishReview').textContent='Finish ↗'; $('finishReview').disabled=false; }
  };
  $('copyReviewResult').onclick = copyPackage;
  $('saveReviewResult').onclick = () => { const save = (name,blob) => { const link=el('a',{href:URL.createObjectURL(blob),download:name});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),60000); }; save('review-collage.png',resultBlob); save('review-transcript.md',new Blob([resultText],{type:'text/markdown'})); };
  $('closeReviewResult').onclick = () => { result.classList.add('hidden'); document.body.classList.remove('review-result-open'); $('startReview').focus(); };
  window.reviewMode = { strokeOpacity, get active(){return active;}, get reviewId(){return reviewId;} };
})();
