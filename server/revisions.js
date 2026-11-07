const crypto = require('node:crypto');

const MAX_HTML = 150 * 1024;
const MAX_FRAME = 220 * 1024;
const validId = /^[a-f0-9]{32}$/;
const validHash = /^[a-f0-9]{64}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const nonempty = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const milliseconds = value => Number.isSafeInteger(value) && value >= 0;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function html(value) {
  if (!nonempty(value, MAX_HTML) || Buffer.byteLength(value, 'utf8') > MAX_HTML || !/<html(?:\s|>)/i.test(value) || !/<\/html\s*>/i.test(value) || value.includes('\0')) throw fail(400, 'Provide an HTML document of at most 150 KiB');
  return value;
}

function parseRequest(value) {
  if (!value || !nonempty(value.requestId, 100) || !/^[A-Za-z0-9_-]+$/.test(value.requestId)) throw fail(400, 'A valid requestId is required');
  if (!validId.test(value.recordingId || '')) throw fail(400, 'Select a saved recording');
  if (!milliseconds(value.fromMs) || !milliseconds(value.toMs) || value.toMs <= value.fromMs || value.toMs - value.fromMs > 120000) throw fail(400, 'Select a positive interval of at most 120 seconds');
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 4000 || value.note.includes('\0'))) throw fail(400, 'The note must be at most 4000 characters');
  const frameTimes = value.frameTimes === undefined ? [] : value.frameTimes;
  if (!Array.isArray(frameTimes) || frameTimes.length < 1 || frameTimes.length > 3 || new Set(frameTimes).size !== frameTimes.length || !frameTimes.every(at => milliseconds(at) && at >= value.fromMs && at < value.toMs)) throw fail(400, 'Choose one to three distinct frame times inside the interval');
  const sourceHtml = html(value.sourceHtml);
  return { requestId: value.requestId, input: { sourceHtml, sourceHash: digest(sourceHtml), recordingId: value.recordingId, fromMs: value.fromMs, toMs: value.toMs, note: (value.note || '').trim(), frameTimes: [...frameTimes].sort((a, b) => a - b) } };
}

function parseProposal(value, input) {
  if (!value || !nonempty(value.summary, 4000) || !nonempty(value.diff, 350 * 1024) || Buffer.byteLength(value.diff, 'utf8') > 350 * 1024 || value.baseHash !== input.sourceHash) throw fail(400, 'The proposal needs a summary, source diff, and matching baseHash');
  const output = html(value.html);
  if (output === input.sourceHtml) throw fail(400, 'The proposal must change the source');
  if (!Array.isArray(value.transcript) || !value.transcript.length || value.transcript.length > 500) throw fail(400, 'A real transcript is required');
  let previous = input.fromMs, characters = 0;
  const transcript = value.transcript.map(segment => {
    if (!segment || !milliseconds(segment.fromMs) || !milliseconds(segment.toMs) || segment.fromMs < previous || segment.toMs <= segment.fromMs || segment.toMs > input.toMs || !nonempty(segment.text, 16000)) throw fail(400, 'Transcript offsets must be ordered and inside the selected interval');
    previous = segment.toMs; characters += segment.text.length;
    return { fromMs: segment.fromMs, toMs: segment.toMs, text: segment.text };
  });
  if (characters > 16000) throw fail(400, 'The transcript is too long');
  if (!Array.isArray(value.frames) || value.frames.length !== input.frameTimes.length) throw fail(400, 'Provide every requested frame');
  const frames = value.frames.map((frame, index) => {
    if (!frame || frame.atMs !== input.frameTimes[index] || typeof frame.image !== 'string' || Buffer.byteLength(frame.image) > MAX_FRAME || !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.image)) throw fail(400, 'Frames must be JPEG data URLs at the requested times and at most 220 KiB');
    const bytes = Buffer.from(frame.image.slice(23), 'base64');
    if (bytes.length < 8 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw fail(400, 'A frame is not a JPEG image');
    return { atMs: frame.atMs, image: frame.image };
  });
  const proposal = { summary: value.summary.trim(), html: output, baseHash: value.baseHash, transcript, frames, diff: value.diff };
  return { ...proposal, proposalHash: digest(canonical({ input, proposal })) };
}

function parseResult(value, proposal) {
  if (!value || !proposal || value.html !== proposal.html || value.hash !== digest(proposal.html) || !nonempty(value.verification, 4000)) throw fail(400, 'The result must contain the exact approved HTML, its SHA-256 hash, and verification');
  return { html: value.html, hash: value.hash, verification: value.verification.trim() };
}

function publicRevision(row, detail = true) {
  const result = { id: row.id, roomId: row.room_id, state: row.state, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
  if (detail) return { ...result, input: row.input, proposal: row.proposal, result: row.result };
  if (row.proposal) { result.proposalHash = row.proposal.proposalHash; result.summary = row.proposal.summary; }
  return result;
}

function sendHtml(res, row, download) {
  if (row.state !== 'ready' || !row.result?.html) throw fail(409, 'The approved revision is not ready');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
  if (download) res.setHeader('Content-Disposition', `attachment; filename="revision-${row.id}.html"`);
  res.end(row.result.html);
}

module.exports = { MAX_HTML, validId, validHash, fail, digest, canonical, nonempty, parseRequest, parseProposal, parseResult, publicRevision, sendHtml };
