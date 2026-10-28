// SPDX-License-Identifier: AGPL-3.0-only
// One process, atomic files; no packages or database.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const directory = process.env.CLOUD_DATA_DIR || '/data';
const maxBytes = 5 * 1024 * 1024;
const buckets = new Map();
fs.mkdirSync(directory, { recursive: true });

function validBlob(blob) {
  if (!blob || blob.version !== 1 || !Number.isSafeInteger(blob.updatedAt) ||
      blob.updatedAt <= 0 || blob.updatedAt > Date.now() + 300000 ||
      !blob.data || typeof blob.data !== 'object' || Array.isArray(blob.data)) return false;
  const keys = Object.keys(blob.data);
  if (!keys.includes('PvZ2_PlayerProperties') ||
      keys.some(key => !['PvZ2_PlayerProperties', 'PvZ2_Settings'].includes(key))) return false;
  try {
    if (keys.some(key => typeof blob.data[key] !== 'string')) return false;
    if (!Array.isArray(JSON.parse(blob.data.PvZ2_PlayerProperties))) return false;
    if (blob.data.PvZ2_Settings !== undefined) {
      const settings = JSON.parse(blob.data.PvZ2_Settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
    }
  } catch { return false; }
  return true;
}

export const server = http.createServer(async (req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const match = /^\/api\/cloud\/([0-9]{6})$/.exec(req.url);
  if (!match) return send(404, { error: 'NOT_FOUND' });
  // nginx overwrites this header; the service has no published host port.
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  const now = Date.now();
  const bucket = buckets.get(ip) || { tokens: 60, time: now };
  bucket.tokens = Math.min(60, bucket.tokens + (now - bucket.time) / 250); // 240/min, burst 60
  bucket.time = now;
  buckets.set(ip, bucket);
  if (bucket.tokens < 1) {
    res.setHeader('Retry-After', '5');
    req.resume();
    return send(429, { error: 'RATE_LIMIT' });
  }
  bucket.tokens--;
  const file = path.join(directory, match[1] + '.json');
  try {
    if (req.method === 'GET') {
      try { return send(200, JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return send(404, { error: 'EMPTY' }); throw error; }
    }
    if (req.method !== 'PUT') {
      req.resume();
      res.setHeader('Allow', 'GET, PUT');
      return send(405, { error: 'METHOD' });
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      return send(415, { error: 'JSON_REQUIRED' });
    }
    if (Number(req.headers['content-length']) > maxBytes) {
      req.resume();
      return send(413, { error: 'TOO_LARGE' });
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > maxBytes) { send(413, { error: 'TOO_LARGE' }); req.destroy(); return; }
      chunks.push(chunk);
    }
    let blob;
    try { blob = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(400, { error: 'INVALID_JSON' }); }
    if (!validBlob(blob)) return send(400, { error: 'INVALID_SAVE' });
    // Store only the supported envelope, with a deterministic key order.
    blob = { version: 1, updatedAt: blob.updatedAt, data: Object.fromEntries(
      ['PvZ2_PlayerProperties', 'PvZ2_Settings'].filter(key => key in blob.data).map(key => [key, blob.data[key]])) };
    const text = JSON.stringify(blob);
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && (previous.updatedAt > blob.updatedAt ||
        (previous.updatedAt === blob.updatedAt && JSON.stringify(previous) !== text))) {
      return send(409, previous);
    }
    // ponytail: bounded 5 MiB synchronous I/O serializes writers; use async per-code locks if load grows.
    fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    return send(200, { updatedAt: blob.updatedAt });
  } catch (error) {
    console.error('cloud storage error:', error.code || error.name);
    if (!res.headersSent) send(500, { error: 'STORAGE_ERROR' });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
setInterval(() => {
  for (const [ip, bucket] of buckets) if (Date.now() - bucket.time > 120000) buckets.delete(ip);
}, 60000).unref();
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
