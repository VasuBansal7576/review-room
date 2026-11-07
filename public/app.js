const $ = (id) => document.getElementById(id);
const state = { room: null, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], recordingActive: false, name: localStorage.getItem('review-name') || '', client: crypto.randomUUID(), events: new Map(), peers: new Map(), participants: new Map(), failedPeers: new Set(), stream: null, screen: null, recorder: null, chunks: [], tool: 'pointer', color: '#FF453A', drawing: null, localStrokes: new Map(), source: null, recordingMix: null };
const roomId = location.pathname.match(/^\/rooms\/([^/]+)/)?.[1] || new URLSearchParams(location.search).get('room');
const api = (path, options) => fetch(path, options).then(async response => { if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`); return response.json(); });
let iceRefreshTimer, iceExpiry = 0, iceRefreshing = false;
function setIceConfig(config, refreshPeers = false) {
  state.iceServers = config.iceServers;
  iceExpiry = config.turnExpiresAt ? Date.parse(config.turnExpiresAt) : 0;
  clearTimeout(iceRefreshTimer);
  if (iceExpiry) iceRefreshTimer = setTimeout(refreshIceConfig, Math.max(30000, iceExpiry - Date.now() - 60000));
  if (refreshPeers) for (const { pc } of state.peers.values()) if (pc.signalingState !== 'closed') { pc.setConfiguration({ iceServers: state.iceServers }); pc.restartIce(); }
}
async function refreshIceConfig() {
  if (!state.room || iceRefreshing) return;
  iceRefreshing = true;
  try { setIceConfig(await api(`/api/rooms/${encodeURIComponent(state.room.id)}/ice-config`), true); }
  catch { iceRefreshTimer = setTimeout(refreshIceConfig, 30000); }
  finally { iceRefreshing = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && iceExpiry && Date.now() >= iceExpiry - 60000) refreshIceConfig(); });
const postEvent = (type, data) => api(`/api/rooms/${state.room.id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, author: state.name, data: { ...data, client: state.client } }) });
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3000); }
const blockedAudio = new Set();
function playRemoteAudio(audio) { audio.play().then(() => blockedAudio.delete(audio)).catch(() => { blockedAudio.add(audio); toast('Click anywhere to enable audio'); }); }
function retryRemoteAudio() { for (const audio of blockedAudio) playRemoteAudio(audio); }
document.addEventListener('pointerdown', retryRemoteAudio);
document.addEventListener('keydown', retryRemoteAudio);
function setName(name) { state.name = name.trim(); localStorage.setItem('review-name', state.name); $('profileButton').textContent = state.name[0]?.toUpperCase() || 'Y'; }
function safeUrl(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } }
$('createForm').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; $('createError').textContent = ''; try { setName($('yourName').value); const room = await api('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('projectName').value.trim(), url: $('projectUrl').value.trim() }) }); sessionStorage.setItem('review-created', room.id); location.href = `/?room=${encodeURIComponent(room.id)}`; } catch (error) { $('createError').textContent = error.message; button.disabled = false; } });
$('yourName').value = state.name;
$('nameForm').addEventListener('submit', event => { event.preventDefault(); setName($('joinName').value); $('nameModal').classList.add('hidden'); updatePeople(); connectRoom(); guestReady(true); });
const isGuest = () => document.documentElement.dataset.reviewOwner === 'false';
function setTool(tool) { document.querySelector(`[data-tool="${tool}"]`)?.click(); }
function guestReady(fromJoin) { if (!isGuest()) return; setTool('pen'); if (fromJoin && !state.stream && !localStorage.getItem('review-mic-asked')) { localStorage.setItem('review-mic-asked', '1'); $('micButton').click(); } toast('Talk and draw right on the page · press D to switch pen/pointer'); }
document.addEventListener('keydown', event => { if (event.key.toLowerCase() !== 'd' || event.metaKey || event.ctrlKey || event.altKey || !state.room || event.target.closest?.('input,textarea,[contenteditable]')) return; setTool(state.tool === 'pen' ? 'pointer' : 'pen'); });
$('profileButton').addEventListener('click', () => { $('joinName').value = state.name; $('nameModal').classList.remove('hidden'); $('joinName').focus(); });
async function copyInvite() { try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); } catch { toast('Could not copy. Share the URL in your address bar.'); } }
$('copyLink').onclick = copyInvite; $('inviteSmall').onclick = copyInvite;
function timeLabel(at) { const date = new Date(at); return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function noteStatus(noteId) { let status = 'open'; for (const event of state.events.values()) if (event.type === 'note_status' && event.data.noteId === noteId) status = event.data.status; return status; }
function updateNoteStatus(noteId) { const item = $('activityList').querySelector(`[data-note-id="${noteId}"]`); if (!item) return; const status = noteStatus(noteId); item.dataset.status = status; item.querySelector('.note-status').textContent = status === 'resolved' ? 'Resolved' : 'Open'; const button = item.querySelector('.note-status-action'); button.textContent = status === 'resolved' ? 'Reopen' : 'Mark resolved'; button.setAttribute('aria-label', `${button.textContent}: ${item.querySelector('p').textContent}`); }
function addActivity(event) { const list = $('activityList'); list.querySelector('.empty-state')?.remove(); const item = document.createElement('div'); item.className = 'activity-item'; const initial = document.createElement('div'); initial.className = 'initial'; initial.textContent = (event.author || '?')[0].toUpperCase(); const body = document.createElement('div'); const name = document.createElement('strong'); name.textContent = event.author || 'Someone'; const time = document.createElement('time'); time.textContent = timeLabel(event.at); const text = document.createElement('p'); text.textContent = event.data.text; body.append(name, time, text); if (event.type === 'note') { item.dataset.noteId = event.id; const controls = document.createElement('div'); controls.className = 'note-controls'; const status = document.createElement('span'); status.className = 'note-status'; const button = document.createElement('button'); button.type = 'button'; button.className = 'note-status-action'; button.onclick = async () => { button.disabled = true; try { await postEvent('note_status', { noteId: event.id, status: noteStatus(event.id) === 'open' ? 'resolved' : 'open' }); } catch { toast('Could not update note'); } finally { button.disabled = false; } }; controls.append(status, button); body.append(controls); } item.append(initial, body); list.append(item); if (event.type === 'note') updateNoteStatus(event.id); list.scrollTop = list.scrollHeight; }
function addRecording(event) { const url = event.data?.url; const prefix = `/recordings/${state.room.id}/`; if (typeof url !== 'string' || !url.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(url.slice(prefix.length))) return; const list = $('recordingsList'); list.querySelector('.empty-state')?.remove(); const item = document.createElement('div'); item.className = 'recording-item'; item.dataset.recordingUrl = url; const title = document.createElement('strong'); title.textContent = `Session recording · ${timeLabel(event.at)}`; const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; const duration = document.createElement('span'); duration.className = 'recording-duration'; duration.style.display = 'block'; duration.title = 'Elapsed recording time'; duration.setAttribute('aria-label', 'Recording duration'); window.replayMedia.showDuration(video, duration, event.data); video.src = url; const link = document.createElement('a'); link.href = url; link.download = `review-recording-${url.slice(prefix.length)}.webm`; link.textContent = 'Download recording'; let downloading = false; link.onclick = async click => { click.preventDefault(); if (downloading) return; downloading = true; link.setAttribute('aria-busy', 'true'); link.textContent = 'Downloading…'; try { await window.replayMedia.downloadRecording(url, link.download, { durationMs: Number.isFinite(event.data.endedAt) && Number.isFinite(event.data.startedAt) ? event.data.endedAt - event.data.startedAt : null }); } catch (error) { toast(error.message || 'Could not download recording'); } finally { downloading = false; link.removeAttribute('aria-busy'); link.textContent = 'Download recording'; } }; const timeline = document.createElement('div'); timeline.dataset.recordingId = event.id; const pack = document.createElement('button'); pack.type = 'button'; pack.className = 'package-link'; pack.textContent = 'Download collage + markers'; pack.onclick = () => downloadPackage(event.id, pack); item.append(title, duration, video, link, pack, timeline); if (document.documentElement.dataset.reviewOwner === 'true') { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-recording'; remove.textContent = 'Delete recording'; remove.onclick = async () => { if (!confirm('Permanently delete this recording from the room?')) return; remove.disabled = true; try { await api(url, { method: 'DELETE' }); } catch (error) { toast(`Could not delete recording: ${error.message}`); remove.disabled = false; } }; item.append(remove); } list.append(item); updateRecordingTimelines(); }
function updateRecordingTimelines() { for (const timeline of document.querySelectorAll('[data-recording-id]')) { const recording = state.events.get(timeline.dataset.recordingId); const start = recording?.data.startedAt; const end = recording?.data.endedAt; if (!Number.isFinite(start) || !Number.isFinite(end)) continue; timeline.replaceChildren(); const strokes = new Set(); for (const event of state.events.values()) { const at = Date.parse(event.at); if (at < start || at > end || !['note', 'stroke'].includes(event.type)) continue; if (event.type === 'stroke') { const id = event.data.strokeId || event.id; if (strokes.has(id)) continue; strokes.add(id); } const seconds = Math.max(0, (at - start) / 1000); const button = document.createElement('button'); button.type = 'button'; button.style.cssText = 'display:block;border:0;background:none;padding:6px 0;text-align:left;color:#718c57;font-size:11px'; button.textContent = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')} · ${event.type === 'note' ? event.data.text : `Drawing by ${event.author}`}`; button.onclick = () => { const video = timeline.parentElement.querySelector('video'); video.currentTime = seconds; video.play().catch(() => {}); }; timeline.append(button); } } }
function contentRect() { const rect = $('drawing').getBoundingClientRect(); const video = $('sharedVideo'); if (video.classList.contains('hidden') || !video.videoWidth || !video.videoHeight) return { x: 0, y: 0, width: rect.width, height: rect.height }; const fit = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight); const width = video.videoWidth * fit; const height = video.videoHeight * fit; return { x: (rect.width - width) / 2, y: (rect.height - height) / 2, width, height }; }
function redraw() { const canvas = $('drawing'); const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return; const ratio = devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; const area = contentRect(); let strokes = new Map(); for (const event of state.events.values()) { if (event.type === 'clear') strokes = new Map(); if (event.type === 'stroke') { const stroke = event.data; const key = stroke.strokeId || event.id; const old = strokes.get(key); if (!old || (stroke.seq || 0) >= (old.seq || 0)) strokes.set(key, stroke); } } for (const [id, stroke] of state.localStrokes) strokes.set(id, stroke); if (state.drawing) strokes.set(state.drawing.strokeId, state.drawing); for (const stroke of strokes.values()) { if (!stroke.points?.length) continue; ctx.globalAlpha = window.reviewMode?.strokeOpacity(stroke) ?? 1; if (stroke.undone || ctx.globalAlpha <= 0) continue; ctx.strokeStyle = stroke.color || '#FF453A'; ctx.lineWidth = 5; ctx.shadowColor = '#FF453A'; ctx.shadowBlur = 5; ctx.beginPath(); ctx.moveTo(area.x + stroke.points[0].x * area.width, area.y + stroke.points[0].y * area.height); for (const point of stroke.points.slice(1)) ctx.lineTo(area.x + point.x * area.width, area.y + point.y * area.height); if (stroke.points.length === 1) ctx.lineTo(area.x + stroke.points[0].x * area.width + 0.1, area.y + stroke.points[0].y * area.height); ctx.stroke(); } }
$('sharedVideo').addEventListener('loadedmetadata', redraw);
$('sharedVideo').addEventListener('resize', redraw);
function receive(event, historical = false) { if (!event) return; if (event.type === 'presence' || event.type === 'signal') { if (!historical && event.data?.client !== state.client) { if (event.type === 'presence') onPresence(event); if (event.type === 'signal' && event.data.recipient === state.client) onSignal(event); } return; } if (state.events.has(event.id)) return; state.events.set(event.id, event); if (event.type === 'clear') state.localStrokes.clear(); if (event.type === 'stroke' && event.data.client === state.client) { const pending = state.localStrokes.get(event.data.strokeId); if (pending && event.data.seq >= pending.seq) state.localStrokes.delete(event.data.strokeId); } if (event.type === 'note' || event.type === 'switch_reply') { addActivity(event); $('activityCount').textContent = [...state.events.values()].filter(e => e.type === 'note' || e.type === 'switch_reply').length; } if (event.type === 'note_status') updateNoteStatus(event.data.noteId); if (event.type === 'recording') { addRecording(event); $('replayCount').textContent = [...state.events.values()].filter(e => e.type === 'recording' && ![...state.events.values()].some(d => d.type === 'recording_deleted' && d.data.url === e.data.url)).length; } if (event.type === 'recording_deleted') { for (const item of $('recordingsList').querySelectorAll('[data-recording-url]')) if (item.dataset.recordingUrl === event.data.url) item.remove(); $('replayCount').textContent = [...state.events.values()].filter(e => e.type === 'recording' && ![...state.events.values()].some(d => d.type === 'recording_deleted' && d.data.url === e.data.url)).length; } if (event.type === 'stroke' || event.type === 'clear') redraw(); if (event.type === 'stroke' || event.type === 'note') updateRecordingTimelines(); if (!historical && event.data?.client !== state.client) { if (event.type === 'presence') onPresence(event); if (event.type === 'signal' && event.data.recipient === state.client) onSignal(event); } }
async function connectRoom() {
  if (state.source) return;
  const cursor = [...state.events.keys()].at(-1) || '0';
  const source = new EventSource(`/api/rooms/${state.room.id}/events?cursor=${encodeURIComponent(cursor)}`);
  state.source = source;
  function closePeers() {
    const peers = [...state.peers.values()];
    state.peers.clear();
    state.participants.clear();
    state.failedPeers.clear();
    for (const entry of peers) { clearTimeout(entry.retryTimer); entry.pc.close(); }
    updatePeople();
  }
  const guard = connectionGuard(closePeers);
  source.addEventListener('access-revoked', () => {
    source.close();
    clearInterval(heartbeat);
    guard.revoked();
    $('connectionText').textContent = 'Access revoked';
    toast('Guest access was revoked');
  });
  source.onmessage = e => { try { receive(JSON.parse(e.data)); } catch (error) { console.error(error); } };
  source.onopen = async () => {
    guard.connected();
    $('connectionText').textContent = 'Connected';
    try { await postEvent('presence', { action: 'join', recording: state.recordingActive }); } catch { toast('Could not sync the room'); }
  };
  source.onerror = () => {
    $('connectionText').textContent = 'Reconnecting...';
    guard.disconnected();
  };
  const heartbeat = setInterval(() => {
    if (source.readyState === EventSource.OPEN) postEvent('presence', { action: 'heartbeat', recording: state.recordingActive }).catch(console.error);
    const cutoff = Date.now() - 50000;
    for (const [id, participant] of state.participants) if (participant.seen < cutoff) { state.participants.delete(id); state.failedPeers.delete(id); const entry = state.peers.get(id); state.peers.delete(id); entry?.pc.close(); }
    updatePeople();
  }, 15000);
}
function updatePeople() { const list = $('peopleAvatars'); list.replaceChildren(); const names = [state.name, ...[...state.participants.values()].map(p => p.name)]; for (const name of names) { const avatar = document.createElement('span'); avatar.title = name; avatar.textContent = name[0]?.toUpperCase() || '?'; list.append(avatar); } $('peopleCount').textContent = names.length === 1 ? 'Just you for now' : `${names.length} people in the room`; if (names.length === 1) $('peopleDetail').textContent = 'Invite someone to join the review'; else { const recordingNames = [...state.participants.values()].filter(p => p.recording).map(p => p.name); const failed = state.failedPeers.size > 0; const connected = [...state.participants.keys()].every(id => state.peers.get(id)?.pc.connectionState === 'connected'); $('peopleDetail').textContent = recordingNames.length ? `${recordingNames.join(', ')} ${recordingNames.length === 1 ? 'is' : 'are'} recording` : failed ? 'Media connection interrupted. Retrying...' : connected ? 'Media connected' : 'Connecting media...'; } }
async function signal(recipient, payload) {
  const entry = state.peers.get(recipient);
  if (!entry) return;
  const delivery = entry.outgoingSignalQueue.then(() => postEvent('signal', { recipient, payload }));
  entry.outgoingSignalQueue = delivery.catch(() => {});
  return delivery;
}
function retryPeer(id, entry, delay = 1000) {
  if (entry.retryTimer || state.peers.get(id) !== entry || !state.participants.has(id)) return;
  state.failedPeers.add(id);
  updatePeople();
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (state.peers.get(id) !== entry || !state.participants.has(id) || entry.pc.connectionState === 'connected') return;
    if (entry.pc.signalingState === 'closed') return;
    entry.pc.restartIce();
    entry.retryDelay = Math.min((entry.retryDelay || 1000) * 2, 15000);
    retryPeer(id, entry, entry.retryDelay);
  }, delay);
}
function peer(id, name) { if (state.peers.has(id)) return state.peers.get(id); const pc = new RTCPeerConnection({ iceServers: state.iceServers }); const entry = { pc, name, pending: [], audio: null, makingOffer: false, ignoreOffer: false, settingAnswer: false, signalQueue: Promise.resolve(), outgoingSignalQueue: Promise.resolve(), retryTimer: null, retryDelay: 1000 }; state.peers.set(id, entry); updatePeople(); pc.onicecandidate = e => { if (e.candidate) signal(id, { candidate: e.candidate.toJSON() }).catch(console.error); }; pc.ontrack = e => { if (e.track.kind === 'video') { const stream = e.streams[0]; const show = () => { if (state.screen) return; $('sharedVideo').srcObject = stream; $('sharedVideo').muted = true; $('sharedVideo').classList.remove('hidden'); $('stageHint').classList.add('hidden'); $('stageStatus').textContent = `${entry.name} is sharing`; }; const hide = () => { if ($('sharedVideo').srcObject !== stream) return; $('sharedVideo').srcObject = null; $('sharedVideo').classList.add('hidden'); $('stageHint').classList.remove('hidden'); $('stageStatus').textContent = 'Website view'; }; e.track.onmute = hide; e.track.onunmute = show; e.track.onended = hide; show(); } else { entry.audio = e.streams[0]; addRecordingAudio(e.track); const audio = new Audio(); audio.srcObject = e.streams[0]; audio.autoplay = true; playRemoteAudio(audio); } }; pc.onnegotiationneeded = () => offer(id).catch(console.error); pc.onconnectionstatechange = () => { if (state.peers.get(id) !== entry) return; if (pc.connectionState === 'connected') { state.failedPeers.delete(id); clearTimeout(entry.retryTimer); entry.retryTimer = null; entry.retryDelay = 1000; } else if (pc.connectionState === 'failed') retryPeer(id, entry); else if (pc.connectionState === 'disconnected') retryPeer(id, entry, 8000); else if (pc.connectionState === 'closed') { clearTimeout(entry.retryTimer); state.peers.delete(id); if (state.participants.has(id)) state.failedPeers.add(id); } updatePeople(); }; if (state.stream) state.stream.getTracks().forEach(track => pc.addTrack(track, state.stream)); if (state.screen) state.screen.getVideoTracks().forEach(track => pc.addTrack(track, state.screen)); if (state.client < id) pc.createDataChannel('session'); return entry; }
async function offer(id) { const entry = state.peers.get(id); if (!entry) return; try { entry.makingOffer = true; await entry.pc.setLocalDescription(); await signal(id, { description: entry.pc.localDescription }); } finally { entry.makingOffer = false; } }
function onPresence(event) { if (event.data.action === 'hello' && event.data.recipient !== state.client) return; const id = event.data.client; if (!id) return; if (event.data.action === 'leave') { state.participants.delete(id); state.failedPeers.delete(id); const entry = state.peers.get(id); state.peers.delete(id); entry?.pc.close(); updatePeople(); return; } state.participants.set(id, { name: event.author, seen: Date.now(), recording: event.data.recording === true }); peer(id, event.author); if (event.data.action === 'join') postEvent('presence', { action: 'hello', recipient: id, recording: state.recordingActive }).catch(console.error); updatePeople(); }
function onSignal(event) { const id = event.data.client; const entry = peer(id, event.author); entry.signalQueue = entry.signalQueue.then(async () => { const { description, candidate } = event.data.payload; const pc = entry.pc; if (description) { const ready = !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingAnswer); const collision = description.type === 'offer' && !ready; entry.ignoreOffer = state.client < id && collision; if (entry.ignoreOffer) return; entry.settingAnswer = description.type === 'answer'; try { await pc.setRemoteDescription(description); } finally { entry.settingAnswer = false; } for (const ice of entry.pending.splice(0)) await pc.addIceCandidate(ice); if (description.type === 'offer') { await pc.setLocalDescription(); await signal(id, { description: pc.localDescription }); } } else if (candidate) { if (entry.ignoreOffer) return; if (pc.remoteDescription) await pc.addIceCandidate(candidate); else entry.pending.push(candidate); } }).catch(error => { console.error(error); toast('A connection could not be established'); }); }
async function renegotiate() {}

async function recoverRecording(session, button) {
  button.disabled = true;
  try {
    const saved = await recordingStore.chunks(session.id);
    if (!saved.length) throw new Error('No recording data was saved');
    if (!session.url) {
      const rawBlob = new Blob(saved.sort((a, b) => a.seq - b.seq).map(chunk => chunk.blob), { type: 'video/webm' });
      const blob = await window.webmDuration.fixDuration(rawBlob, session.endedAt - session.startedAt);
      session.url = (await uploadRecording(session.roomId, blob)).url;
      await recordingStore.put(session);
    }
    if (![...state.events.values()].some(event => event.type === 'recording' && event.data.url === session.url)) await postEvent('recording', { url: session.url, startedAt: session.startedAt, endedAt: session.endedAt || session.startedAt });
    await recordingStore.remove(session.id);
    button.closest('.recovery-item')?.remove();
    toast('Recording saved to replays');
  } catch (error) { toast(`Recording could not be saved: ${error.message}`); }
  finally { button.disabled = false; }
}
async function showRecoverableRecordings() {
  try {
    const sessions = (await recordingStore.sessions()).filter(session => session.roomId === state.room.id && session.id !== state.activeRecordingId);
    for (const session of sessions) {
      if ($('recordingsList').querySelector(`[data-recovery-id="${session.id}"]`)) continue;
      const chunks = await recordingStore.chunks(session.id);
      if (!chunks.length) continue;
      $('recordingsList').querySelector('.empty-state')?.remove();
      const item = document.createElement('div'); item.className = 'recording-item recovery-item'; item.dataset.recoveryId = session.id;
      const title = document.createElement('strong'); title.textContent = session.finished ? 'Recording waiting to upload' : 'Interrupted recording';
      const detail = document.createElement('p'); detail.textContent = 'Saved on this browser. An interrupted recording may be incomplete.';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Save to room'; button.onclick = () => recoverRecording(session, button);
      const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download'; download.onclick = async () => { download.disabled = true; try { const saved = await recordingStore.chunks(session.id); const raw = new Blob(saved.sort((a,b) => a.seq - b.seq).map(chunk => chunk.blob), { type: 'video/webm' }); const fixed = await window.webmDuration.fixDuration(raw, session.endedAt - session.startedAt); const url = URL.createObjectURL(fixed); const link = document.createElement('a'); link.href = url; link.download = 'review-recording.webm'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); } catch (error) { toast(`Could not download recovery: ${error.message}`); } finally { download.disabled = false; } };
      const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = 'Discard'; discard.onclick = async () => { if (!confirm('Delete this recording from this browser?')) return; try { await recordingStore.remove(session.id); item.remove(); toast('Local recording deleted'); } catch { toast('Could not delete local recording'); } };
      item.append(title, detail, button, download, discard); $('recordingsList').append(item);
    }
  } catch (error) { console.error('Recording recovery unavailable', error); }
}
function addRecordingAudio(track) { const mix = state.recordingMix; if (!mix || track.kind !== 'audio' || mix.tracks.has(track.id)) return; mix.tracks.add(track.id); mix.context.createMediaStreamSource(new MediaStream([track])).connect(mix.destination); }
$('micButton').onclick = async () => { try { if (state.stream) { const track = state.stream.getAudioTracks()[0]; track.enabled = !track.enabled; $('micButton').classList.toggle('on', track.enabled); $('micButton').title = track.enabled ? 'Mute microphone' : 'Unmute microphone'; toast(track.enabled ? 'Microphone on' : 'Microphone muted'); return; } state.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); state.stream.getAudioTracks().forEach(addRecordingAudio); for (const { pc } of state.peers.values()) { state.stream.getTracks().forEach(track => pc.addTrack(track, state.stream)); if (!['connected', 'closed'].includes(pc.connectionState)) pc.restartIce(); } $('micButton').classList.add('on'); $('micButton').title = 'Mute microphone'; await renegotiate(); toast('Microphone on'); } catch (error) { toast(`Microphone unavailable: ${error.message}`); } };
$('shareScreen').onclick = async () => { try { if (state.screen) { state.screen.getTracks().forEach(track => track.stop()); stopShare(); return; } state.screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); const track = state.screen.getVideoTracks()[0]; track.onended = stopShare; $('sharedVideo').srcObject = state.screen; $('sharedVideo').classList.remove('hidden'); $('sharedVideo').muted = true; $('stageHint').classList.add('hidden'); $('stageStatus').textContent = 'You are sharing'; $('shareScreen').querySelector('span').textContent = 'Stop sharing'; for (const { pc } of state.peers.values()) pc.addTrack(track, state.screen); await renegotiate(); } catch (error) { toast(`Screen sharing unavailable: ${error.message}`); } };
function stopShare() { if (!state.screen) return; if (state.recorder?.state === 'recording') state.recorder.stop(); const tracks = state.screen.getTracks(); for (const { pc } of state.peers.values()) for (const sender of pc.getSenders()) if (tracks.includes(sender.track)) pc.removeTrack(sender); state.screen = null; $('sharedVideo').srcObject = null; $('sharedVideo').muted = false; $('sharedVideo').classList.add('hidden'); $('stageHint').classList.remove('hidden'); $('stageStatus').textContent = 'Website view'; $('shareScreen').querySelector('span').textContent = 'Share screen'; renegotiate().catch(console.error); }
$('recordButton').onclick = async () => {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  let audioContext;
  const ownedTracks = [];
  const cleanup = () => {
    ownedTracks.forEach(track => track.stop());
    state.recordingMix = null;
    audioContext?.close().catch(console.error);
    state.recordingActive = false;
    postEvent('presence', { action: 'heartbeat', recording: false }).catch(console.error);
    $('recordButton').classList.remove('recording');
    $('recordButton').innerHTML = '<span class="record-dot"></span> Record session (50 MB max)';
  };
  try {
    const screenTrack = state.screen?.getVideoTracks().find(track => track.readyState === 'live');
    if (!screenTrack) { toast('Share your screen before recording'); return; }
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser cannot record WebM');
    // Resume during the Record click's activation, before IndexedDB/network awaits.
    audioContext = new AudioContext();
    const audioReady = audioContext.resume();
    const session = { id: crypto.randomUUID(), roomId: state.room.id, startedAt: Date.now(), endedAt: Date.now(), finished: false };
    await recordingStore.create(session);
    state.activeRecordingId = session.id;
    await postEvent('presence', { action: 'heartbeat', recording: true });
    state.recordingActive = true;
    // Record capture's native track, not a timer-driven canvas: hidden tabs can
    // suspend canvas painting. Drawings/markers remain in the review package.
    const videoTrack = screenTrack.clone();
    ownedTracks.push(videoTrack);
    const tracks = [videoTrack];
    const audioStreams = [state.screen, state.stream, ...[...state.peers.values()].map(p => p.audio)].filter(stream => stream?.getAudioTracks().length);
    await audioReady;
    const mixed = audioContext.createMediaStreamDestination();
    // An unconnected destination can produce no audio packets. Chrome then
    // waits forever for that audio track, even when the video track is live.
    // Drive silence so no-mic/no-tab-audio recordings and later mic joins work.
    const silence = audioContext.createConstantSource();
    silence.offset.value = 0;
    silence.connect(mixed);
    silence.start();
    state.recordingMix = { context: audioContext, destination: mixed, tracks: new Set() };
    for (const stream of audioStreams) stream.getAudioTracks().forEach(addRecordingAudio);
    tracks.push(...mixed.stream.getAudioTracks());
    ownedTracks.push(...mixed.stream.getAudioTracks());
    const chunks = [];
    let recordedBytes = 0, reachedLimit = false, chunkSeq = 0, storageError = null, recorderError = null;
    let writeQueue = Promise.resolve();
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType });
    state.recorder = recorder;
    recorder.onerror = event => { recorderError = event.error || new Error('Recorder failed'); console.error(recorderError); };
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      const chunk = event.data;
      chunks.push(chunk);
      const seq = chunkSeq++;
      session.endedAt = Date.now();
      const snapshot = { ...session };
      writeQueue = writeQueue.then(() => recordingStore.append(session.id, seq, chunk)).then(() => recordingStore.put(snapshot)).catch(error => { storageError = error; console.error(error); });
      recordedBytes += chunk.size;
      if (recordedBytes >= 40 * 1024 * 1024 && recorder.state === 'recording') { reachedLimit = true; recorder.stop(); }
    };
    recorder.onstop = async () => {
      const endedAt = Date.now();
      cleanup();
      let blob = new Blob(chunks, { type: 'video/webm' });
      try {
        await writeQueue;
        if (state.cancelReviewRecording) { state.cancelReviewRecording = false; await recordingStore.remove(session.id); return; }
        session.endedAt = endedAt;
        session.finished = true;
        if (!storageError) await recordingStore.put(session);
        if (!blob.size) throw new Error('No recording data was captured');
        if (recorderError) throw recorderError;
        blob = await window.webmDuration.fixDuration(blob, endedAt - session.startedAt);
        const result = await uploadRecording(session.roomId, blob);
        session.url = result.url;
        if (!storageError) await recordingStore.put(session);
        await postEvent('recording', { url: result.url, startedAt: session.startedAt, endedAt });
        if (!storageError) await recordingStore.remove(session.id);
        toast(reachedLimit ? 'Recording stopped near the size limit and saved to replays' : 'Recording saved to replays');
      } catch (error) {
        console.error('Recording not saved:', error.message);
        if (!blob.size) {
          toast('No recording data was captured. Nothing was saved; share the screen again and retry.');
        } else if (storageError) {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'review-recording.webm';
          link.textContent = 'Download unsaved recording';
          $('recordingsList').querySelector('.empty-state')?.remove();
          $('recordingsList').append(link);
          toast('Recording upload and local storage failed. Download it before leaving.');
        } else {
          toast('Upload failed. Recording saved in this browser; open Replays to retry or download.');
        }
      } finally {
        state.activeRecordingId = null;
        showRecoverableRecordings();
      }
    };
    session.startedAt = Date.now(); session.endedAt = session.startedAt;
    recorder.start(1000);
    $('recordButton').classList.add('recording');
    $('recordButton').innerHTML = '<span class="record-dot"></span> Stop recording';
    toast('Recording the shared screen. Drawings and notes are saved separately in the review package.');
  } catch (error) {
    cleanup();
    state.activeRecordingId = null;
    toast(`Recording unavailable: ${error.message}`);
    showRecoverableRecordings();
  }
};
$('noteForm').onsubmit = async event => { event.preventDefault(); const text = $('noteInput').value.trim(); if (!text) return; try { await postEvent('note', { text }); $('noteInput').value = ''; } catch { toast('Could not save note'); } };
document.querySelectorAll('.tab').forEach((button, index, tabs) => {
  button.onclick = () => {
    tabs.forEach(tab => { const selected = tab === button; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    $('activityPanel').classList.toggle('hidden', button.dataset.tab !== 'activity'); $('replaysPanel').classList.toggle('hidden', button.dataset.tab !== 'replays');
  };
  button.onkeydown = event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return; event.preventDefault(); tabs[next].click(); tabs[next].focus();
  };
});
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => { state.tool = button.dataset.tool; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b === button)); $('drawing').classList.toggle('drawing', state.tool === 'pen'); $('toolTip').textContent = state.tool === 'pen' ? 'Draw on the page to share your feedback · D for pointer' : 'Select draw (D) to mark up the page'; });
document.querySelectorAll('[data-color]').forEach(button => button.onclick = () => { state.color = button.dataset.color; document.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('selected', b === button)); });
$('clearDrawing').onclick = () => postEvent('clear', {}).catch(() => toast('Could not clear drawings'));
const canvas = $('drawing'); function point(e) { const rect = canvas.getBoundingClientRect(); const area = contentRect(); return { x: Math.max(0, Math.min(1, (e.clientX - rect.left - area.x) / area.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top - area.y) / area.height)) }; }
let strokeQueue = Promise.resolve(); let strokeTimer;
function sendStroke(stroke) { const snapshot = { ...stroke, seq: ++stroke.seq, points: stroke.points.slice() }; strokeQueue = strokeQueue.then(() => postEvent('stroke', snapshot)).then(saved => receive(saved)).catch(() => toast('Could not save drawing')); return strokeQueue; }
canvas.onpointerdown = e => { canvas.setPointerCapture(e.pointerId); state.drawing = { strokeId: crypto.randomUUID(), seq: 0, color: state.color, points: [point(e)] }; sendStroke(state.drawing); redraw(); }; canvas.onpointermove = e => { if (!state.drawing) return; state.drawing.points.push(point(e)); redraw(); if (!strokeTimer) strokeTimer = setTimeout(() => { strokeTimer = null; if (state.drawing) sendStroke(state.drawing); }, 100); }; canvas.onpointerup = canvas.onpointercancel = () => { if (!state.drawing) return; clearTimeout(strokeTimer); strokeTimer = null; const stroke = state.drawing; sendStroke(stroke); state.localStrokes.set(stroke.strokeId, stroke); state.drawing = null; redraw(); };
new ResizeObserver(redraw).observe($('stageContent'));
function makeHandoff() {
  const events = [...state.events.values()];
  const notes = events.filter(e => e.type === 'note').map(e => `- [${noteStatus(e.id) === 'resolved' ? 'Resolved' : 'Open'}] ${e.data.text} (${e.author}, ${e.at})`);
  const recordings = events.filter(e => e.type === 'recording' && !events.some(d => d.type === 'recording_deleted' && d.data.url === e.data.url)).map((recording, index) => {
    const { startedAt, endedAt, url } = recording.data;
    let recordingUrl = 'Link unavailable';
    try { if (typeof url === 'string' && url.startsWith(`/recordings/${state.room.id}/`)) recordingUrl = new URL(url, location.origin).href; } catch {}
    const lines = [`Recording ${index + 1}: ${recordingUrl}`];
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return [...lines, '- Timing unavailable'];
    const seenStrokes = new Set();
    for (const event of events) {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at) || at < startedAt || at > endedAt || !['note', 'stroke'].includes(event.type)) continue;
      if (event.type === 'stroke') {
        const id = event.data.strokeId || event.id;
        if (seenStrokes.has(id)) continue;
        seenStrokes.add(id);
      }
      const seconds = Math.floor((at - startedAt) / 1000);
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      lines.push(`- ${time} · ${event.type === 'note' ? `Note by ${event.author}: ${event.data.text}` : `Drawing by ${event.author}`}`);
    }
    if (lines.length === 1) lines.push('- No notes or drawing markers during this recording');
    return lines;
  }).flat();
  const mention = state.room.switchHandoffMention ? `${state.room.switchHandoffMention}\n\n` : '';
  return `${mention}${state.room.name}
${state.room.url}

Review notes
${notes.join('\n') || '- No notes yet'}

Recordings and review markers
${recordings.join('\n') || '- No recordings yet'}

Clicked / drawing / note markers
${window.reviewPackage ? window.reviewPackage.markers(events).map(m => `- ${m.t} [${m.kind}] ${m.author}: ${m.text}`).join('\n') || '- None' : '- Unavailable'}

Review room: ${location.href}`;
}
async function downloadPackage(recordingId = null, button = null) {
  if (!window.reviewPackage) return toast('Package unavailable');
  if (button?.disabled) return;
  const label = button?.textContent;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Building collage…'; }
  toast('Building collage and markers…');
  try { await window.reviewPackage.download(state.room, [...state.events.values()], location.href, recordingId ? { recordingId } : {}); toast('Collage + [clicked] transcript downloaded'); }
  catch (error) { toast(`Could not build package: ${error.message}`); }
  finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = label; } }
}
$('packageButton').onclick = () => downloadPackage(null, $('packageButton'));
$('handoffPackage').onclick = () => downloadPackage(null, $('handoffPackage'));
$('handoffButton').onclick = () => { $('handoffContent').value = makeHandoff(); $('handoffStatus').textContent = ''; $('sendHandoff').disabled = false; $('handoffModal').classList.remove('hidden'); $('handoffContent').focus(); };
$('cancelHandoff').onclick = () => $('handoffModal').classList.add('hidden');
$('copyHandoff').onclick = async () => { try { await navigator.clipboard.writeText($('handoffContent').value); $('handoffStatus').textContent = 'Handoff copied. Paste it into your workspace.'; } catch { $('handoffStatus').textContent = 'Could not copy. Select the text and copy it manually.'; } };
$('handoffForm').onsubmit = async event => { event.preventDefault(); const button = $('sendHandoff'); button.disabled = true; $('handoffStatus').textContent = 'Sending to Switch...'; try { const result = await api(`/api/rooms/${state.room.id}/switch-handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: $('handoffContent').value }) }); $('handoffStatus').textContent = result.message || 'Handoff sent to Switch.'; } catch (error) { $('handoffStatus').textContent = `Could not send to Switch: ${error.message}. You can copy the handoff instead.`; } finally { button.disabled = false; } };
window.addEventListener('pagehide', () => { if (state.room && state.source) navigator.sendBeacon(`/api/rooms/${state.room.id}/events`, new Blob([JSON.stringify({ type: 'presence', author: state.name, data: { client: state.client, action: 'leave' } })], { type: 'application/json' })); });
async function init() { if (!roomId) return; try { const [room, iceConfig] = await Promise.all([api(`/api/rooms/${encodeURIComponent(roomId)}`), api(`/api/rooms/${encodeURIComponent(roomId)}/ice-config`)]); state.room = room; setIceConfig(iceConfig); $('welcome').classList.add('hidden'); $('room').classList.remove('hidden'); $('roomName').textContent = room.name; $('roomUrl').textContent = room.url; $('address').textContent = room.url; const url = safeUrl(room.url); if (url) { $('website').src = url; $('openWebsite').href = url; } (room.events || []).forEach(e => receive(e, true)); window.reviewRevisions?.mount({ room, getEvents: () => [...state.events.values()], api, toast }); showRecoverableRecordings(); updatePeople(); if (!state.name) { $('nameModal').classList.remove('hidden'); $('joinName').focus(); } else { setName(state.name); connectRoom(); guestReady(false); } } catch (error) { $('createError').textContent = `Could not open room: ${error.message}`; } }
init();

const reviewModeScript = document.createElement('script'); reviewModeScript.src = '/review-mode.js'; document.body.append(reviewModeScript);
