// @ts-check

import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @typedef {import('./miniapp-api.js').MiniAppLifecycle} MiniAppLifecycle */

/** @param {string} dir */
async function isDirectory(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the active MiniMax Code data root's `v2/sessions` directory.
 * The Host-injected `dataDir` lives inside the active data root (for example
 * `<dataRoot>/v2/plugin-data/...`), so walk up its ancestors and use the first
 * one that contains `v2/sessions`. Fall back to the default `~/.minimax`.
 * @param {MiniAppContext} context
 */
async function resolveSessionsRoot(context) {
  let dir = context.dataDir;
  for (let i = 0; i < 10 && dir; i += 1) {
    const candidate = join(dir, 'v2', 'sessions');
    if (await isDirectory(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(homedir(), '.minimax', 'v2', 'sessions');
}
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Per-file parse cache. Key: absolute messages.jsonl path.
 * Value: { mtimeMs, size, file } where file is the parsed summary.
 * @type {Map<string, { mtimeMs: number, size: number, file: ParsedFile }>}
 */
const fileCache = new Map();

/**
 * @typedef {Object} ParsedFile
 * @property {string} sessionId
 * @property {string} title
 * @property {Map<string, UsageBucket>} buckets key: `${model}\u0000${day}`
 * @property {number} assistantSeen
 * @property {number} parsedMessages
 * @property {number} badLines
 */

/**
 * @typedef {Object} UsageBucket
 * @property {number} calls
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 */

/** Format a millisecond timestamp as a local-time YYYY-MM-DD day key. */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/** @param {unknown} v */
function asNonNegativeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Derive the session id from the session directory name
 * (`...-session_<base64(sessionId)>`) as a fallback when manifest.json is absent.
 * @param {string} dirName
 */
function sessionIdFromDirName(dirName) {
  const marker = dirName.lastIndexOf('session_');
  if (marker < 0) return null;
  const encoded = dirName.slice(marker + 'session_'.length);
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return /^[\x20-\x7e]+$/.test(decoded) && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Extract a short human-readable session title from the first meaningful user message.
 * @param {any} message
 */
function titleFromUserMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const cleaned = block.text.replace(SYSTEM_REMINDER_RE, '').replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
  }
  return null;
}

/**
 * Parse one session's messages.jsonl into per-(model, day) usage buckets.
 * @param {string} sessionDir
 * @param {string} messagesPath
 * @returns {Promise<ParsedFile>}
 */
async function parseSessionFile(sessionDir, messagesPath) {
  /** @type {ParsedFile} */
  const result = {
    sessionId: '',
    title: '',
    buckets: new Map(),
    assistantSeen: 0,
    parsedMessages: 0,
    badLines: 0,
  };

  try {
    const manifestRaw = await readFile(join(sessionDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    if (typeof manifest?.sessionId === 'string' && manifest.sessionId) {
      result.sessionId = manifest.sessionId;
    }
  } catch {
    // fall back to directory-name decoding below
  }
  if (!result.sessionId) {
    result.sessionId =
      sessionIdFromDirName(sessionDir.split('/').pop() ?? '') ?? `unknown:${sessionDir.split('/').pop()}`;
  }

  const raw = await readFile(messagesPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    /** @type {any} */
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      result.badLines += 1;
      continue;
    }
    const message = record?.message;
    if (!message || typeof message !== 'object') continue;

    if (message.role === 'user' && !result.title) {
      const title = titleFromUserMessage(message);
      if (title) result.title = title;
      continue;
    }

    if (message.role !== 'assistant') continue;
    result.assistantSeen += 1;

    const usage = message.usage;
    const ts = message.timestamp;
    if (!usage || typeof usage !== 'object' || typeof ts !== 'number' || !Number.isFinite(ts)) {
      continue;
    }

    const model = typeof message.model === 'string' && message.model ? message.model : 'unknown';
    const key = `${model}\u0000${dayKey(ts)}`;
    let bucket = result.buckets.get(key);
    if (!bucket) {
      bucket = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      result.buckets.set(key, bucket);
    }
    bucket.calls += 1;
    bucket.input += asNonNegativeNumber(usage.input);
    bucket.output += asNonNegativeNumber(usage.output);
    bucket.cacheRead += asNonNegativeNumber(usage.cacheRead);
    bucket.cacheWrite += asNonNegativeNumber(usage.cacheWrite);
    result.parsedMessages += 1;
  }

  if (!result.title) result.title = result.sessionId;
  return result;
}

/**
 * List subdirectory names of a directory, returning [] when it does not exist.
 * @param {string} dir
 */
async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Walk <root>/YYYY/MM/DD/<session>/messages.jsonl and collect session file paths.
 * @param {string} root
 */
async function collectSessionFiles(root) {
  /** @type {{ sessionDir: string, messagesPath: string }[]} */
  const found = [];
  for (const year of await listDirs(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await listDirs(join(root, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await listDirs(join(root, year, month))) {
        if (!/^\d{2}$/.test(day)) continue;
        for (const session of await listDirs(join(root, year, month, day))) {
          const sessionDir = join(root, year, month, day, session);
          found.push({ sessionDir, messagesPath: join(sessionDir, 'messages.jsonl') });
        }
      }
    }
  }
  return found;
}

/**
 * Scan every session file (using the mtime/size cache) and build the flat
 * per-(session, model, day) usage record list served to the Client.
 * @param {MiniAppContext} context
 * @param {string} sessionsRoot
 */
async function buildUsageSnapshot(context, sessionsRoot) {
  if (!(await isDirectory(sessionsRoot))) {
    return { error: 'data_root_missing', status: 500 };
  }

  const candidates = await collectSessionFiles(sessionsRoot);
  const liveKeys = new Set();
  /** @type {ParsedFile[]} */
  const parsedFiles = [];
  let scannedFiles = 0;
  let failedFiles = 0;

  for (const { sessionDir, messagesPath } of candidates) {
    /** @type {import('node:fs').Stats} */
    let fileStat;
    try {
      fileStat = await stat(messagesPath);
    } catch {
      continue; // session dir without messages.jsonl
    }
    if (!fileStat.isFile()) continue;
    scannedFiles += 1;
    liveKeys.add(messagesPath);

    const cached = fileCache.get(messagesPath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      parsedFiles.push(cached.file);
      continue;
    }
    try {
      const file = await parseSessionFile(sessionDir, messagesPath);
      fileCache.set(messagesPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, file });
      parsedFiles.push(file);
    } catch (error) {
      failedFiles += 1;
      context.logger.warn('tokenboard.scan.file_error', {
        code: /** @type {any} */ (error)?.code ?? 'parse_error',
      });
    }
  }

  for (const key of fileCache.keys()) {
    if (!liveKeys.has(key)) fileCache.delete(key);
  }

  const records = [];
  let assistantSeen = 0;
  let parsedMessages = 0;
  let badLines = 0;
  for (const file of parsedFiles) {
    assistantSeen += file.assistantSeen;
    parsedMessages += file.parsedMessages;
    badLines += file.badLines;
    for (const [key, bucket] of file.buckets) {
      const sep = key.indexOf('\u0000');
      records.push({
        sessionId: file.sessionId,
        title: file.title,
        model: key.slice(0, sep),
        day: key.slice(sep + 1),
        calls: bucket.calls,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
      });
    }
  }

  // Source data is present but nothing could be interpreted: fail as a parse
  // error rather than presenting an empty board.
  if (assistantSeen > 0 && parsedMessages === 0) {
    return { error: 'parse_empty', status: 500 };
  }

  context.logger.info('tokenboard.scan.complete', {
    scannedFiles,
    failedFiles,
    records: records.length,
    badLines,
  });

  return {
    status: 200,
    body: {
      generatedAt: Date.now(),
      scannedFiles,
      failedFiles,
      parsedMessages,
      records,
    },
  };
}

/**
 * @param {MiniAppContext} context
 * @returns {Promise<MiniAppLifecycle>}
 */
export async function start(context) {
  const clientEntry = await readFile(join(context.pluginRoot, 'miniapp/client/index.html'));
  const sessionsRoot = await resolveSessionsRoot(context);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');

    if (request.method === 'GET' && url.pathname === '/dashboard') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(clientEntry);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      buildUsageSnapshot(context, sessionsRoot)
        .then((result) => {
          if ('error' in result && result.error) {
            response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: result.error }));
            return;
          }
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(JSON.stringify(result.body));
        })
        .catch((error) => {
          context.logger.warn('tokenboard.api.error', {
            code: /** @type {any} */ (error)?.code ?? 'internal_error',
          });
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'internal_error' }));
        });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });
  context.logger.info('tokenboard.listening');

  /** @type {Promise<void> | undefined} */
  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    context.signal.removeEventListener('abort', onAbort);
    disposal = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
    return disposal;
  };
  const onAbort = () => {
    void dispose();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}
