(function () {
  'use strict';
  const labels = { queued: 'Waiting for the agent', preparing: 'Listening and preparing a change', proposed: 'Your approval is needed', approved: 'Approved and waiting to apply', applying: 'Creating your preview', ready: 'Revision ready', failed: 'Revision needs attention' };
  const pending = new Set(['queued', 'preparing', 'approved', 'applying']);
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };

  function mount({ room, getEvents, api, toast }) {
    const owner = document.documentElement.dataset.reviewOwner === 'true';
    const base = `/api/rooms/${room.id}/revisions`;
    let sourceHtml = '', selectedId = null, current = null, timer, requestId = crypto.randomUUID(), lastStamp = '';
    const section = element('section', undefined, 'revision-section'); section.id = 'revisions';
    section.innerHTML = `<div class="revision-heading"><div><span class="section-kicker">02 / AGENT REVIEW</span><h2>Your feedback. Their proposal. Your call.</h2><p>Send a selected clip to the Switch agent. Inspect its proposal, approve the exact source, then open the matching private preview.</p></div><button type="button" class="button subtle" id="refreshRevisions">Refresh</button></div>
      <p id="workerStatus" class="worker-status" role="status">Checking agent availability…</p>
      <ol class="revision-flow" aria-label="Revision workflow"><li><b>1</b><span>You select the context</span></li><li><b>2</b><span>Switch proposes a change</span></li><li><b>3</b><span>You approve exact source</span></li><li><b>4</b><span>Open the matching preview</span></li></ol><div class="revision-layout"><form id="revisionForm" class="revision-form">
        <h3>Choose your feedback</h3><label>Session recording<select id="revisionRecording" required><option value="">Choose a recording</option></select></label>
        <div class="clip-range"><label>Start, seconds<input id="revisionFrom" type="number" min="0" step="0.1" value="0" required></label><label>End, seconds<input id="revisionTo" type="number" min="0.1" step="0.1" value="10" required></label></div>
        <label>Website source<input id="revisionSource" type="file" accept=".html,text/html"></label><div class="source-choice"><button type="button" id="useDemoSource" class="button subtle">Use North Studio example</button><span id="sourceStatus">Connect one self-contained HTML file.</span></div>
        <label>Anything else the agent should know?<textarea id="revisionNote" maxlength="2000" rows="3" placeholder="Optional context or a correction…"></textarea></label>
        <label class="revision-consent"><input type="checkbox" id="revisionConsent" required><span>Send this selected clip, its marked images, and the connected source to the Switch agent.</span></label>
        <button class="button dark" type="submit" id="requestRevision">Ask Switch for a revision</button><p class="revision-error" id="revisionError" role="alert"></p>
        <p class="revision-help">Only the selected clip is processed. Your live website stays unchanged. The result is a private HTML preview and downloadable source.</p>
      </form><div class="revision-results"><label>Revisions<select id="revisionPicker"><option value="">No revisions yet</option></select></label><div id="revisionDetail" aria-live="polite"><div class="revision-empty"><span>✧</span><h3>No proposal yet. You’re in control.</h3><p>Choose a recording and connect its source to request a proposal. You’ll see the transcript and exact change here before approving anything.</p></div></div></div></div>`;
    document.querySelector('.workspace').after(section);
    const byId = id => section.querySelector(`#${id}`);
    const form = byId('revisionForm'), detail = byId('revisionDetail'), picker = byId('revisionPicker');
    if (!owner) { form.hidden = true; section.querySelector('.revision-layout').classList.add('guest-revisions'); }

    function recordings() {
      const events = getEvents();
      return events.filter(e => e.type === 'recording' && !events.some(d => d.type === 'recording_deleted' && d.data.url === e.data.url));
    }
    function refreshRecordings() {
      const select = byId('revisionRecording'), old = select.value;
      const rows = recordings();
      if (rows.map(e => e.id).join(',') === select.dataset.rows) return;
      select.dataset.rows = rows.map(e => e.id).join(',');
      select.replaceChildren(new Option('Choose a recording', ''));
      rows.forEach((row, i) => select.add(new Option(`Recording ${i + 1} · ${new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, row.id)));
      select.value = old;
    }
    byId('revisionRecording').onchange = () => {
      const recording = recordings().find(e => e.id === byId('revisionRecording').value);
      if (!recording) return;
      byId('revisionFrom').value = 0;
      byId('revisionTo').value = Math.max(.1, Math.min(120, (recording.data.endedAt - recording.data.startedAt) / 1000)).toFixed(1);
      const video = document.querySelector(`[data-recording-url="${recording.data.url}"] video`);
      if (video && Number.isFinite(video.duration)) byId('revisionTo').value = Math.min(120, video.duration).toFixed(1);
    };
    byId('revisionSource').onchange = async () => {
      const file = byId('revisionSource').files[0];
      sourceHtml = '';
      if (!file) return;
      if (file.size > 150 * 1024) { byId('sourceStatus').textContent = 'Choose an HTML file smaller than 150 KB.'; return; }
      sourceHtml = await file.text(); byId('sourceStatus').textContent = file.name;
    };
    byId('useDemoSource').onclick = async () => {
      try { const response = await fetch('/demo.html'); if (!response.ok) throw new Error('Example unavailable'); sourceHtml = await response.text(); byId('sourceStatus').textContent = 'North Studio source connected'; byId('revisionSource').value = ''; }
      catch (error) { toast(error.message); }
    };
    async function mutation(path, data) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
    form.onsubmit = async event => {
      event.preventDefault();
      const error = byId('revisionError'), button = byId('requestRevision'); error.textContent = '';
      const recording = recordings().find(e => e.id === byId('revisionRecording').value);
      if (!recording || !sourceHtml) { error.textContent = 'Choose a recording and connect its website source first.'; return; }
      const fromMs = Math.round(Number(byId('revisionFrom').value) * 1000), toMs = Math.round(Number(byId('revisionTo').value) * 1000);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs <= fromMs || toMs - fromMs > 120000) { error.textContent = 'Choose a clip up to 120 seconds long.'; return; }
      const strokeTimes = getEvents().filter(e => e.type === 'stroke').map(e => Date.parse(e.at) - recording.data.startedAt).filter(t => t >= fromMs && t <= toMs);
      const frameTimes = strokeTimes.length ? [...new Set(strokeTimes.map(t => Math.min(toMs - 1, t + 300)))].slice(-3) : [Math.round((fromMs + toMs) / 2)];
      button.disabled = true;
      try {
        const revision = await mutation(base, { requestId, sourceHtml, recordingId: recording.data.url.split('/').at(-1), fromMs, toMs, note: byId('revisionNote').value.trim(), frameTimes });
        selectedId = revision.id; current = revision; requestId = crypto.randomUUID(); lastStamp = ''; render(revision); await refresh(); toast('The request is saved. Switch will prepare your proposal.');
      } catch (failure) { error.textContent = failure.message; }
      finally { button.disabled = false; }
    };
    function action(text, run) {
      const button = element('button', text, 'button dark'); button.type = 'button';
      button.onclick = async () => { button.disabled = true; try { await run(); lastStamp = ''; await refresh(); } catch (error) { toast(error.message); } finally { button.disabled = false; } };
      return button;
    }
    function render(revision) {
      detail.replaceChildren();
      detail.append(element('span', labels[revision.state] || revision.state, `revision-state state-${revision.state}`));
      detail.append(element('p', revision.input?.note || 'A change requested during your review.', 'revision-request'));
      if (revision.error) detail.append(element('p', revision.error, 'revision-error'));
      const proposal = revision.proposal;
      if (proposal) {
        detail.append(element('h3', proposal.summary));
        const transcript = element('details', undefined, 'revision-transcript'); transcript.open = true;
        transcript.append(element('summary', 'What the agent heard'));
        const words = (proposal.transcript || []).map(segment => segment.text).join(' ').trim();
        transcript.append(element('p', words));
        if (owner && revision.state === 'proposed') {
          const correction = element('textarea'); correction.value = words; correction.rows = 3; correction.maxLength = 16000; correction.setAttribute('aria-label', 'Correct transcript');
          const correctionDetails = element('details'); correctionDetails.append(element('summary', 'Correct a transcription mistake'), correction);
          correctionDetails.append(action('Regenerate with corrected words', () => mutation(`${base}/${revision.id}/correct`, { transcriptText: correction.value.trim() })));
          transcript.append(correctionDetails);
        }
        detail.append(transcript);
        const frames = element('div', undefined, 'revision-frames');
        for (const frame of proposal.frames || []) {
          if (!/^data:image\/jpeg;base64,/.test(frame.image || '')) continue;
          const figure = element('figure'), image = element('img'); image.src = frame.image; image.alt = `Marked review frame at ${(frame.atMs / 1000).toFixed(1)} seconds`;
          figure.append(image, element('figcaption', `Review context · ${(frame.atMs / 1000).toFixed(1)}s`)); frames.append(figure);
        }
        detail.append(frames);
        const changes = element('details', undefined, 'revision-diff'); changes.append(element('summary', 'Review the exact source change'), element('pre', proposal.diff)); detail.append(changes);
        if (revision.state === 'proposed' && owner) {
          detail.append(element('p', 'Approval creates a private preview of these exact changes. It does not publish to your live website.', 'revision-help'));
          detail.append(action('Approve this exact change', () => mutation(`${base}/${revision.id}/approve`, { proposalHash: proposal.proposalHash || proposal.hash })));
        } else if (revision.state === 'proposed') detail.append(element('p', 'The freelancer can approve this change.', 'revision-help'));
      }
      if (revision.state === 'ready') {
        const link = element('a', 'Download revised HTML', 'button subtle'); link.href = `${base}/${revision.id}/source`; link.download = 'revised-site.html'; detail.append(link);
        const preview = element('iframe'); preview.className = 'revision-preview'; preview.title = 'Approved website revision'; preview.setAttribute('sandbox', ''); preview.referrerPolicy = 'no-referrer'; detail.append(preview);
        const loading = element('p', 'Loading the approved website…', 'revision-help'); detail.append(loading);
        fetch(`${base}/${revision.id}/preview`, { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
          if (!response.ok) throw new Error('Could not load the private preview. Refresh this room to try again.');
          const html = await response.text();
          if (!detail.contains(preview)) return;
          preview.onload = () => loading.remove();
          preview.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'">${html}`;
        }).catch(error => { loading.textContent = error.message; loading.className = 'revision-error'; });
        if (revision.result?.verification) detail.append(element('p', revision.result.verification, 'revision-help'));
      } else if (pending.has(revision.state)) detail.append(element('p', revision.state === 'queued' ? 'Your request stays saved while the agent is offline. You can leave this room and return later.' : 'You can keep reviewing while the agent works.', 'revision-help'));
      if (owner && revision.state === 'failed') detail.append(action(revision.proposal ? 'Retry applying the approved change' : 'Retry preparing the proposal', () => mutation(`${base}/${revision.id}/retry`, {})));
    }
    async function refresh() {
      clearTimeout(timer); refreshRecordings();
      try {
        const response = await api(base);
        byId('workerStatus').textContent = response.workerOnline ? 'Switch agent is online.' : 'Switch agent is offline. Requests stay saved until it reconnects.';
        byId('workerStatus').classList.toggle('online', response.workerOnline === true);
        const rows = response.revisions || []; picker.replaceChildren(new Option(rows.length ? 'Choose a revision' : 'No revisions yet', ''));
        rows.forEach((r, i) => picker.add(new Option(`${labels[r.state] || r.state} · ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, r.id)));
        if (!selectedId && rows.length) selectedId = rows[0].id;
        picker.value = selectedId || '';
        const row = rows.find(r => r.id === selectedId);
        const stamp = row ? `${row.id}:${row.state}:${row.updatedAt}` : '';
        if (row && stamp !== lastStamp) { current = await api(`${base}/${row.id}`); render(current); lastStamp = stamp; }
        timer = setTimeout(refresh, current && pending.has(current.state) ? 4000 : 12000);
      } catch (error) {
        byId('workerStatus').textContent = error.message.includes('Not found') ? 'Revisions are available on the hosted workspace.' : `Could not refresh revisions. ${error.message}`;
        timer = setTimeout(refresh, 15000);
      }
    }
    picker.onchange = () => { selectedId = picker.value; lastStamp = ''; refresh(); };
    byId('refreshRevisions').onclick = refresh;
    const jump = element('button', 'Agent revisions ↓', 'button subtle'); jump.type = 'button'; jump.onclick = () => { section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); refreshRecordings(); }; document.querySelector('.heading-actions').prepend(jump);
    window.addEventListener('pagehide', () => clearTimeout(timer));
    refresh();
  }
  window.reviewRevisions = { mount };
})();
