(function (root) {
  'use strict';
  function element(bytes, offset, limit) {
    const start = offset;
    function vint(id) {
      if (offset >= limit || !bytes[offset]) throw new Error('Invalid WebM element');
      let width = 1, mask = 128;
      while (!(bytes[offset] & mask)) { width++; mask >>= 1; }
      if (width > (id ? 4 : 8) || offset + width > limit) throw new Error('Invalid WebM element length');
      let value = BigInt(id ? bytes[offset] : bytes[offset] & (mask - 1));
      for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
      offset += width;
      return { value, width, unknown: !id && value === (1n << BigInt(7 * width)) - 1n };
    }
    const id = Number(vint(true).value), size = vint(false), data = offset;
    if (!size.unknown && size.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebM element too large');
    const end = size.unknown ? limit : data + Number(size.value);
    if (end > limit) throw new Error('Truncated WebM element');
    return { id, start, data, end, sizeWidth: size.width, unknown: size.unknown, sizeStart: data - size.width };
  }
  function sizeBytes(value, minimum) {
    const n = BigInt(value); let width = minimum;
    while (n >= (1n << BigInt(7 * width)) - 1n && width < 8) width++;
    if (width > 8 || n >= (1n << BigInt(7 * width)) - 1n) throw new Error('WebM size overflow');
    const bytes = new Uint8Array(width); let rest = n;
    for (let i = width - 1; i >= 0; i--) { bytes[i] = Number(rest & 255n); rest >>= 8n; }
    bytes[0] |= 1 << (8 - width); return bytes;
  }
  function join(...parts) {
    const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  async function fixDuration(blob, elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error('Recording duration is unavailable');
    const bytes = new Uint8Array(await blob.arrayBuffer()); let segment;
    for (let offset = 0; offset < bytes.length;) { const e = element(bytes, offset, bytes.length); if (e.id === 0x18538067) { segment = e; break; } offset = e.end; }
    if (!segment) throw new Error('WebM Segment is missing');
    let info, indexed = false;
    for (let offset = segment.data; offset < segment.end;) { const e = element(bytes, offset, segment.end); if (e.id === 0x1549a966) info = e; if (e.id === 0x114d9b74 || e.id === 0x1c53bb6b) indexed = true; if (e.unknown) break; offset = e.end; }
    if (!info || info.unknown) throw new Error('WebM Segment Info is missing');
    let scale = 1000000, duration;
    for (let offset = info.data; offset < info.end;) {
      const e = element(bytes, offset, info.end); if (e.unknown) throw new Error('Invalid WebM Info');
      if (e.id === 0x2ad7b1) { scale = 0; for (let i = e.data; i < e.end; i++) scale = scale * 256 + bytes[i]; }
      if (e.id === 0x4489) duration = e;
      offset = e.end;
    }
    if (!Number.isSafeInteger(scale) || scale <= 0) throw new Error('Invalid WebM timecode scale');
    const ticks = elapsedMs * 1000000 / scale;
    if (!Number.isFinite(ticks) || ticks <= 0) throw new Error('Invalid WebM duration');
    if (duration) {
      const length = duration.end - duration.data;
      const existing = new DataView(bytes.buffer, bytes.byteOffset + duration.data, length);
      const value = length === 8 ? existing.getFloat64(0) : length === 4 ? existing.getFloat32(0) : NaN;
      if (Number.isFinite(value) && value > 0) return blob;
      if (length === 8) existing.setFloat64(0, ticks);
      else if (length === 4) existing.setFloat32(0, ticks);
      else throw new Error('Invalid WebM Duration');
      return new Blob([bytes], { type: blob.type || 'video/webm' });
    }
    // Raw MediaRecorder output has no position indexes. Never shift indexed media offsets.
    if (indexed) throw new Error('Cannot insert duration into indexed WebM');
    const entry = new Uint8Array(11); entry.set([0x44, 0x89, 0x88]); new DataView(entry.buffer).setFloat64(3, ticks);
    const infoData = join(bytes.slice(info.data, info.end), entry);
    const newInfo = join(bytes.slice(info.start, info.sizeStart), sizeBytes(infoData.length, info.sizeWidth), infoData);
    const payload = join(bytes.slice(segment.data, info.start), newInfo, bytes.slice(info.end, segment.end));
    const segmentSize = segment.unknown ? bytes.slice(segment.sizeStart, segment.data) : sizeBytes(payload.length, segment.sizeWidth);
    return new Blob([bytes.slice(0, segment.sizeStart), segmentSize, payload, bytes.slice(segment.end)], { type: blob.type || 'video/webm' });
  }
  const api = { fixDuration };
  if (typeof module !== 'undefined') module.exports = api;
  else root.webmDuration = api;
})(typeof window === 'undefined' ? globalThis : window);
