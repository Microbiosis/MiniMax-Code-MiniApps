// @ts-check

/**
 * MCP OAuth domain service.
 *
 * This module owns every state mutation of the board: OAuth metadata discovery,
 * dynamic client registration, the PKCE authorization-code flow, credential
 * storage, and the surgical `mcp.json` patch.
 *
 * Token material never leaves this module. The Client only ever receives
 * metadata about a token (scope, expiry, fingerprint, status), never the token.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { serviceError } from './errors.mjs';

const CLIENT_NAME = 'MCP OAuth Console';
const CALLBACK_PATH = '/oauth/callback';
const REFRESH_WINDOW_MS = 30 * 60 * 1000;
/** How long a successful detection stays valid, and how long a failed one is
 *  remembered before a retry is allowed (a flaky network must not pin a wrong
 *  conclusion for ten minutes). */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const FAILED_DISCOVERY_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const GRANT_TTL_MS = 30 * 60 * 1000;

/** Short, non-reversible label for a token. Lets the user compare old vs new. */
export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Reads `exp` (ms epoch) from a JWT access token, when the token is a JWT. */
export function readTokenExpiry(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON text helpers - used to patch one field without reformatting   */
/* ------------------------------------------------------------------ */

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function readJsonString(text, index) {
  if (text[index] !== '"') throw new Error('expected_string');
  let i = index + 1;
  let value = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (next === 'u') {
        value += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      value += simple[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  throw new Error('unterminated_string');
}

function matchObjectSpan(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = readJsonString(text, i).end;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new Error('unterminated_object');
}

function findMemberObjectSpan(text, key, from = 0, to = text.length) {
  const needle = JSON.stringify(key);
  let index = text.indexOf(needle, from);
  while (index !== -1 && index < to) {
    let i = skipWhitespace(text, index + needle.length);
    if (text[i] === ':') {
      i = skipWhitespace(text, i + 1);
      if (text[i] === '{') {
        const end = matchObjectSpan(text, i);
        return { start: i, end };
      }
    }
    index = text.indexOf(needle, index + 1);
  }
  return null;
}

function findMemberStringSpan(text, key, from, to) {
  const needle = JSON.stringify(key);
  let index = text.indexOf(needle, from);
  while (index !== -1 && index < to) {
    let i = skipWhitespace(text, index + needle.length);
    if (text[i] === ':') {
      i = skipWhitespace(text, i + 1);
      if (text[i] === '"') {
        const parsed = readJsonString(text, i);
        return { start: i, end: parsed.end, value: parsed.value };
      }
    }
    index = text.indexOf(needle, index + 1);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Configuration + credential files                                    */
/* ------------------------------------------------------------------ */

/**
 * Locates the runtime `mcp.json`. The Host data dir normally lives inside the
 * MiniMax data dir, but the lookup walks up from several roots so a different
 * data-dir layout still resolves.
 */
export function resolveMcpConfigPath(startDir) {
  const override = process.env.MINIMAX_MCP_CONFIG;
  if (override && existsSync(override)) return resolve(override);

  const roots = [
    startDir,
    process.cwd(),
    dirname(process.execPath),
  ].filter(Boolean);

  for (const root of roots) {
    let dir = resolve(root);
    for (let depth = 0; depth < 10; depth += 1) {
      const candidate = join(dir, 'mcp.json');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return join(homedir(), '.minimax', 'mcp.json');
}

async function readConfigFile(path) {
  const text = await readFile(path, 'utf8');
  const config = JSON.parse(text);
  const servers = config && typeof config.mcpServers === 'object' && config.mcpServers ? config.mcpServers : {};
  return { text, config, servers };
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function backupConfig(path, backupPath) {
  try {
    const text = await readFile(path, 'utf8');
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFileAtomic(backupPath, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a file atomically: a temp file in the same directory, then a rename.
 * The original file mode is carried over, because the temp file starts with
 * the default mode and the file being replaced may be restricted.
 */
async function writeFileAtomic(path, text) {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const mode = await stat(path).then((info) => info.mode).catch(() => undefined);
  try {
    await writeFile(temp, text, 'utf8');
    if (mode !== undefined) await chmod(temp, mode).catch(() => undefined);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* OAuth protocol helpers                                              */
/* ------------------------------------------------------------------ */

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * HTTP helper with retry. The built-in fetch fails with a 10s connect timeout
 * on this network's proxied first connection, so transient connect failures are
 * retried instead of being reported as an empty or failed probe.
 */
async function httpJson(url, init, timeoutMs = PROBE_TIMEOUT_MS, attempts = 3, headersOnly = false) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (headersOnly) {
        // The body of an SSE stream never ends, so it must not be read.
        try {
          await response.body?.cancel();
        } catch {
          // the stream was already closed
        }
        return { status: response.status, ok: response.ok, headers: response.headers, text: '', json: null };
      }
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, ok: response.ok, headers: response.headers, text, json };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('request_failed');
}

/**
 * The MCP request used to test an endpoint: a real `initialize` handshake.
 * A plain GET is not a valid MCP call, and servers answer it with 405 before
 * any auth check, which would make an OAuth-protected endpoint look open.
 */
function buildInitializeRequest(token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: '1.0.0' },
      },
    }),
  };
}

/**
 * The request used to test an endpoint. It must match the declared transport:
 *  - streamable-http: a real `initialize` JSON-RPC call;
 *  - sse: a GET that opens the event stream. A POST to the /sse URL is not a
 *    valid call for that transport and answers 405.
 */
function probeRequest(url, { transport, token }) {
  if (transport === 'sse') {
    const headers = { accept: 'text/event-stream' };
    if (token) headers.authorization = `Bearer ${token}`;
    return { method: 'GET', headers };
  }
  return buildInitializeRequest(token);
}

/**
 * Validates a target before the process makes a request to it. The page is
 * untrusted input to the Node process, so a typed URL must not turn this Mini
 * App into an open proxy.
 */
export function assertTargetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw serviceError('target_url_invalid');
  }
  if (parsed.username || parsed.password) throw serviceError('target_url_contains_credentials');
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw serviceError('target_url_invalid');
  }
  // Instance metadata and link-local endpoints are never MCP servers.
  if (host === '169.254.169.254' || host.endsWith('.internal') || host.startsWith('169.254.')) {
    throw serviceError('target_url_blocked');
  }
  return parsed;
}

/**
 * Detects what an MCP endpoint demands and resolves the authorization server
 * metadata via the RFC 9728 protected-resource document.
 *
 * A 401 alone does NOT mean OAuth: the server may want an API key or another
 * scheme. Only a `WWW-Authenticate: Bearer resource_metadata="..."` challenge
 * is treated as a declaration of OAuth.
 */
export async function discoverAuthorization(url, options = {}) {
  const transport = options.transport === 'sse' ? 'sse' : 'streamable-http';
  const probe = await httpJson(url, probeRequest(url, { transport }), PROBE_TIMEOUT_MS, 3, transport === 'sse');
  if (probe.status !== 401) {
    // Only a 2xx proves the endpoint accepted an unauthenticated handshake.
    // 404 / 405 / 5xx say nothing about whether auth is required.
    if (probe.status >= 200 && probe.status < 300) {
      return { oauthProtected: false, authRequirement: 'none', status: probe.status, metadata: null, authorizationServer: null };
    }
    return {
      oauthProtected: null,
      authRequirement: 'unknown',
      status: probe.status,
      metadata: null,
      authorizationServer: null,
      reason: 'probe_indeterminate',
    };
  }
  const challenge = probe.headers.get('www-authenticate') || '';
  const resourceMatch = /resource_metadata="([^"]+)"/i.exec(challenge);
  if (!resourceMatch) {
    // No OAuth challenge: the endpoint rejected us, but it never said which
    // scheme it wants. Claiming "OAuth" here would be an over-assertion.
    const bearer = /^bearer/i.test(challenge.trim());
    return {
      oauthProtected: false,
      authRequirement: bearer ? 'bearer' : 'credential',
      status: 401,
      metadata: null,
      authorizationServer: null,
      reason: bearer ? 'bearer_without_resource_metadata' : 'credential_required_unknown_scheme',
    };
  }
  const resourceDoc = await httpJson(resourceMatch[1], { headers: { accept: 'application/json' } });
  const issuers = Array.isArray(resourceDoc.json?.authorization_servers) ? resourceDoc.json.authorization_servers : [];
  const metadata = await loadAuthorizationServerMetadata(issuers);
  return {
    oauthProtected: true,
    authRequirement: 'oauth',
    status: 401,
    metadata,
    authorizationServer: metadata?.issuer ?? issuers[0] ?? null,
    scopes: metadata?.scopes_supported ?? [],
    resource: resourceDoc.json?.resource ?? null,
  };
}

async function loadAuthorizationServerMetadata(issuers) {
  for (const issuer of issuers) {
    const base = String(issuer).replace(/\/+$/, '');
    for (const candidate of [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`]) {
      try {
        const response = await httpJson(candidate, { headers: { accept: 'application/json' } });
        if (response.ok && response.json?.token_endpoint) return response.json;
      } catch {
        // try the next well-known location
      }
    }
  }
  return null;
}

function pickAuthMethod(metadata) {
  const supported = Array.isArray(metadata?.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported
    : [];
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  return 'client_secret_post';
}

async function registerClient(metadata, { redirectUri, scope }) {
  const endpoint = metadata?.registration_endpoint;
  if (!endpoint) throw serviceError('dynamic_registration_unsupported');
  const supported = Array.isArray(metadata.grant_types_supported) ? metadata.grant_types_supported : [];
  const grantTypes = ['authorization_code'];
  if (supported.includes('refresh_token') || supported.length === 0) grantTypes.push('refresh_token');
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: pickAuthMethod(metadata),
  };
  if (scope) body.scope = scope;
  const response = await httpJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.json?.client_id) {
    throw serviceError(`dynamic_registration_failed_${response.status}`);
  }
  return response.json;
}

function buildAuthorizeUrl(metadata, { clientId, redirectUri, state, codeChallenge, scope }) {
  const endpoint = metadata?.authorization_endpoint;
  if (!endpoint) throw serviceError('authorization_endpoint_missing');
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}

function tokenRequestBody({ grantType, code, codeVerifier, redirectUri, refreshToken, clientId, clientSecret, authMethod }) {
  const form = new URLSearchParams();
  form.set('grant_type', grantType);
  if (code) form.set('code', code);
  if (codeVerifier) form.set('code_verifier', codeVerifier);
  if (redirectUri) form.set('redirect_uri', redirectUri);
  if (refreshToken) form.set('refresh_token', refreshToken);
  if (clientId) form.set('client_id', clientId);
  if (clientSecret && authMethod === 'client_secret_post') form.set('client_secret', clientSecret);
  return form;
}

async function requestToken(metadata, client, form) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.client_secret && client.auth_method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
  }
  const response = await httpJson(metadata.token_endpoint, {
    method: 'POST',
    headers,
    body: form.toString(),
  });
  if (!response.ok || !response.json?.access_token) {
    const code = response.json?.error || `http_${response.status}`;
    throw serviceError(`token_request_failed_${code}`);
  }
  return response.json;
}

/**
 * Verifies a token against the MCP endpoint with a handshake that matches the
 * declared transport.
 */
export async function probeMcpEndpoint(url, token, transport) {
  const isSse = transport === 'sse';
  try {
    const response = await httpJson(url, probeRequest(url, { transport, token }), PROBE_TIMEOUT_MS, 3, isSse);
    return { status: response.status, ok: response.status === 200 || response.status === 204 };
  } catch (error) {
    return { status: 0, ok: false, error: error instanceof Error ? error.message : 'probe_failed' };
  }
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function createOAuthService({ dataDir, baseUrl, logger }) {
  const mcpConfigPath = resolveMcpConfigPath(dataDir);
  // Durable state belongs in the Host-owned dataDir. A credential directory
  // left next to mcp.json by an earlier version is read once and imported;
  // it is never written to again.
  const credentialDir = join(dataDir, 'mcp-credentials');
  const legacyCredentialDir = join(dirname(mcpConfigPath), 'mcp-credentials');
  const backupPath = join(dataDir, 'mcp.json.bak');

  /** sessionId -> pending authorization state (server side only) */
  const pending = new Map();
  /** serverName -> discovery cache */
  const discoveryCache = new Map();
  /** serverName -> pending grant awaiting user confirmation */
  const awaitingConfirmation = new Map();

  const children = new Set();

  function log(level, message) {
    // Only the keys of `fields` leave the process, so diagnostics belong in
    // the message itself.
    logger[level](message);
  }

  /** Serializes writes to the configuration file so two of them cannot race. */
  let writeChain = Promise.resolve();
  const withWriteLock = (task) => {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function listConfiguredServers() {
    let parsed;
    try {
      parsed = await readConfigFile(mcpConfigPath);
    } catch (error) {
      return { servers: [], error: error instanceof Error ? error.message : 'config_unreadable' };
    }
    const servers = Object.entries(parsed.servers).map(([name, entry]) => {
      const headers = entry && typeof entry === 'object' && entry.headers && typeof entry.headers === 'object' ? entry.headers : {};
      const authorization = typeof headers.Authorization === 'string' ? headers.Authorization : '';
      const scheme = authorization ? authorization.split(/\s+/)[0] : '';
      const tokenPart = scheme ? authorization.slice(scheme.length).trim() : '';
      const otherHeaderCount = Object.keys(headers).filter((key) => key !== 'Authorization').length;
      return {
        name,
        type: typeof entry?.type === 'string' ? entry.type : '',
        url: typeof entry?.url === 'string' ? entry.url : '',
        enabled: entry?.enabled !== false,
        hasAuthorization: Boolean(authorization),
        authorizationScheme: scheme,
        otherHeaderCount,
        // Fingerprint only: the page never sees the credential itself.
        authorizationFingerprint: tokenPart ? fingerprint(tokenPart) : null,
      };
    });
    return { servers, error: null };
  }

  async function loadCredential(serverName) {
    const own = join(credentialDir, `${serverName}.json`);
    if (existsSync(own)) {
      try {
        return JSON.parse(await readFile(own, 'utf8'));
      } catch {
        return null;
      }
    }
    // One-time import from the legacy directory: read-only, and the copy that
    // lands in dataDir becomes the only copy this app maintains.
    const legacy = join(legacyCredentialDir, `${serverName}.json`);
    if (!existsSync(legacy)) return null;
    try {
      const data = JSON.parse(await readFile(legacy, 'utf8'));
      await saveCredential(serverName, data);
      log('info', `oauth.credential_imported server=${serverName}`);
      return data;
    } catch {
      return null;
    }
  }

  async function saveCredential(serverName, data) {
    const path = join(credentialDir, `${serverName}.json`);
    await writeJsonFile(path, data);
    return path;
  }

  async function probeDiscovery(serverName, url, transport) {
    const cached = discoveryCache.get(serverName);
    if (cached && Date.now() - cached.at < cached.ttlMs) return cached.value;
    try {
      const value = await discoverAuthorization(url, { transport });
      discoveryCache.set(serverName, { at: Date.now(), ttlMs: DISCOVERY_TTL_MS, value });
      return value;
    } catch (error) {
      // A failed probe means "unknown", not "no OAuth required". Reporting it as
      // `oauthProtected: false` would tell the page the endpoint is open.
      const value = {
        oauthProtected: null,
        authRequirement: 'unknown',
        status: 0,
        metadata: null,
        authorizationServer: null,
        scopes: [],
        reason: 'probe_failed',
        error: error instanceof Error ? error.message : 'probe_failed',
      };
      discoveryCache.set(serverName, { at: Date.now(), ttlMs: FAILED_DISCOVERY_TTL_MS, value });
      return value;
    }
  }

  /** Public, credential-free snapshot for the Client. */
  async function buildState() {
    const { servers, error: configError } = await listConfiguredServers();
    const items = [];
    for (const server of servers) {
      const credential = await loadCredential(server.name);
      const cachedDiscovery = discoveryCache.get(server.name);
      const expiresAt =
        credential?.access_token
          ? readTokenExpiry(credential.access_token) ??
            (credential.obtained_at && credential.expires_in
              ? Date.parse(credential.obtained_at) + Number(credential.expires_in) * 1000
              : null)
          : null;
      const grant = awaitingConfirmation.get(server.name);
      const credentialFingerprint = credential?.access_token ? fingerprint(credential.access_token) : null;
      const configFingerprint = server.authorizationFingerprint;

      // Two orthogonal facts, kept apart on purpose:
      //   * what the SERVER requires  -> oauthProtected / authorizationServer
      //   * what THIS MACHINE holds  -> credentialState
      // A server can require OAuth and still be satisfied by a local token, and
      // a machine can hold a token that the configuration does not actually use.
      const warnings = [];
      if (credential?.access_token && !server.hasAuthorization) {
        warnings.push('凭据文件里有令牌，但 mcp.json 中未配置 Authorization，实际不会生效');
      }
      if (server.hasAuthorization && credentialFingerprint && configFingerprint && credentialFingerprint !== configFingerprint) {
        warnings.push('mcp.json 中的令牌与凭据文件不一致，续期后两者会同步');
      }
      if (credential?.refresh_token && !credential?.client_id) {
        warnings.push('凭据缺少 client_id，无法自动续期');
      }

      let credentialState;
      if (grant) credentialState = 'pending';
      else if (!server.hasAuthorization) {
        credentialState = server.otherHeaderCount > 0 ? 'other_scheme' : 'not_configured';
      } else if (Number.isFinite(expiresAt)) {
        credentialState = expiresAt - Date.now() <= 0 ? 'expired' : expiresAt - Date.now() < REFRESH_WINDOW_MS ? 'expiring' : 'valid';
      } else credentialState = 'configured_unknown';

      items.push({
        name: server.name,
        type: server.type,
        url: server.url,
        enabled: server.enabled,
        hasAuthorization: server.hasAuthorization,
        authorizationScheme: server.authorizationScheme,
        oauthProtected: cachedDiscovery?.value?.oauthProtected ?? null,
        authRequirement: cachedDiscovery?.value?.authRequirement ?? 'unknown',
        authorizationServer: cachedDiscovery?.value?.authorizationServer ?? null,
        supportedScopes: cachedDiscovery?.value?.scopes ?? [],
        dynamicRegistration: Boolean(cachedDiscovery?.value?.metadata?.registration_endpoint),
        oauthReason: cachedDiscovery?.value?.reason ?? null,
        scope: credential?.scope ?? null,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        obtainedAt: credential?.obtained_at ?? null,
        remainingMs: Number.isFinite(expiresAt) ? expiresAt - Date.now() : null,
        refreshable: Boolean(credential?.refresh_token && credential?.client_id),
        credentialState,
        configFingerprint,
        tokenFingerprint: credentialFingerprint,
        warnings,
        pendingGrant: Boolean(grant),
        pendingFingerprint: grant ? fingerprint(grant.token.access_token) : null,
        lastError: grant?.error ?? null,
      });
    }
    const now = Date.now();
    return {
      now,
      configError,
      servers: items,
      summary: {
        total: items.length,
        authorized: items.filter((item) => item.hasAuthorization).length,
        refreshable: items.filter((item) => item.refreshable).length,
        expiringSoon: items.filter((item) => Number.isFinite(item.remainingMs) && item.remainingMs > 0 && item.remainingMs < REFRESH_WINDOW_MS).length,
      },
    };
  }

  function openInBrowser(url) {
    try {
      // Arguments are passed as an argv array and never through a shell.
      const isWindows = process.platform === 'win32';
      const child = isWindows
        ? spawn('explorer.exe', [url], { stdio: 'ignore' })
        : spawn('open', [url], { stdio: 'ignore' });
      children.add(child);
      child.once('exit', () => children.delete(child));
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  async function startAuthorization({ serverName, url, scope }) {
    const { servers } = await listConfiguredServers();
    const existing = servers.find((item) => item.name === serverName);
    const targetUrl = existing?.url || url;
    if (!targetUrl) throw serviceError('target_url_required');
    assertTargetUrl(targetUrl);

    const transport = existing?.type === 'sse' ? 'sse' : 'streamable-http';
    const discovery = await probeDiscovery(serverName, targetUrl, transport);
    if (discovery.authRequirement !== 'oauth' || !discovery.metadata) {
      // The endpoint never declared OAuth, so there is no authorization server
      // to run a browser flow against. Say exactly what it wants instead.
      if (discovery.reason === 'bearer_without_resource_metadata') throw serviceError('bearer_without_resource_metadata');
      if (discovery.reason === 'credential_required_unknown_scheme') throw serviceError('credential_required_unknown_scheme');
      throw serviceError('authorization_server_not_resolved');
    }

    const metadata = discovery.metadata;
    const redirectUri = `${baseUrl}${CALLBACK_PATH}`;
    const client = await registerClient(metadata, { redirectUri, scope });
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
    const state = randomBytes(16).toString('hex');
    const sessionId = randomBytes(12).toString('hex');

    const resolvedScope = scope || discovery.scopes?.[0] || undefined;
    const authorizationUrl = buildAuthorizeUrl(metadata, {
      clientId: client.client_id,
      redirectUri,
      state,
      codeChallenge,
      scope: resolvedScope,
    });

    pending.set(sessionId, {
      sessionId,
      serverName,
      url: targetUrl,
      metadata,
      client: {
        client_id: client.client_id,
        client_secret: client.client_secret ?? null,
        auth_method: client.token_endpoint_auth_method ?? pickAuthMethod(metadata),
      },
      codeVerifier,
      redirectUri,
      state,
      scope: resolvedScope ?? null,
      createdAt: Date.now(),
    });

    const opened = openInBrowser(authorizationUrl);
    log('info', `oauth.authorization_started server=${serverName} browser_opened=${opened}`);
    return {
      sessionId,
      authorizationUrl,
      redirectUri,
      scope: resolvedScope ?? null,
      authorizationServer: metadata.issuer ?? null,
      browserOpened: opened,
    };
  }

  async function completeAuthorization({ sessionId, redirectUrl }) {
    const session = pending.get(sessionId);
    if (!session) throw serviceError('session_not_found');
    let code = null;
    let state = null;
    if (redirectUrl) {
      const url = new URL(redirectUrl);
      code = url.searchParams.get('code');
      state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) throw serviceError(`authorization_denied_${error}`);
    }
    if (!code) throw serviceError('authorization_code_missing');
    if (state && state !== session.state) throw serviceError('state_mismatch');

    const form = tokenRequestBody({
      grantType: 'authorization_code',
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
      clientId: session.client.client_id,
      clientSecret: session.client.client_secret,
      authMethod: session.client.auth_method,
    });
    const token = await requestToken(session.metadata, session.client, form);
    pending.delete(sessionId);

    const grant = {
      serverName: session.serverName,
      url: session.url,
      token,
      client: session.client,
      scope: session.scope,
      createdAt: Date.now(),
    };
    awaitingConfirmation.set(session.serverName, grant);
    log('info', `oauth.authorization_completed server=${session.serverName}`);
    return {
      serverName: session.serverName,
      fingerprint: fingerprint(token.access_token),
      scope: token.scope ?? session.scope ?? null,
      expiresIn: token.expires_in ?? null,
      hasRefreshToken: Boolean(token.refresh_token),
    };
  }

  /** Handles the browser redirect. The token stays in Node memory. */
  async function handleCallback(query) {
    const state = query.get('state');
    const error = query.get('error');
    let session = null;
    for (const candidate of pending.values()) {
      if (candidate.state === state) {
        session = candidate;
        break;
      }
    }
    if (!session) {
      return { ok: false, message: '未找到对应的授权会话，请回到 Mini App 重新发起授权。' };
    }
    if (error) {
      pending.delete(session.sessionId);
      return { ok: false, message: `授权被拒绝：${error}` };
    }
    const code = query.get('code');
    if (!code) return { ok: false, message: '回调缺少 authorization code。' };
    try {
      const form = tokenRequestBody({
        grantType: 'authorization_code',
        code,
        codeVerifier: session.codeVerifier,
        redirectUri: session.redirectUri,
        clientId: session.client.client_id,
        clientSecret: session.client.client_secret,
        authMethod: session.client.auth_method,
      });
      const token = await requestToken(session.metadata, session.client, form);
      pending.delete(session.sessionId);
      awaitingConfirmation.set(session.serverName, {
        serverName: session.serverName,
        url: session.url,
        token,
        client: session.client,
        scope: session.scope,
        createdAt: Date.now(),
      });
      log('info', `oauth.callback_received server=${session.serverName}`);
      return { ok: true, serverName: session.serverName, message: '授权成功，请回到 Mini App 确认写入配置。' };
    } catch (tokenError) {
      pending.delete(session.sessionId);
      const message = tokenError instanceof Error ? tokenError.message : 'token_exchange_failed';
      log('warn', `oauth.callback_failed server=${session.serverName} reason=${message}`);
      return { ok: false, message: `换取令牌失败：${message}` };
    }
  }

  /** Commits a pending grant: credential file first, then the mcp.json patch. */
  async function applyGrant(serverName) {
    const grant = awaitingConfirmation.get(serverName);
    if (!grant) throw serviceError('no_pending_grant');
    const token = grant.token;
    const expiresAt = readTokenExpiry(token.access_token);
    const credential = {
      server: serverName,
      url: grant.url,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      token_type: token.token_type ?? 'Bearer',
      scope: token.scope ?? grant.scope ?? null,
      expires_in: token.expires_in ?? null,
      client_id: grant.client.client_id,
      client_secret: grant.client.client_secret,
      obtained_at: new Date().toISOString(),
      note: 'Managed by MCP OAuth Console',
    };
    await saveCredential(serverName, credential);
    const patch = await patchMcpAuthorization(serverName, token.access_token, { url: grant.url });
    awaitingConfirmation.delete(serverName);
    const { servers: configured } = await listConfiguredServers();
    const transport = configured.find((item) => item.name === serverName)?.type;
    const probe = grant.url ? await probeMcpEndpoint(grant.url, token.access_token, transport) : null;
    log('info', `oauth.grant_applied server=${serverName} probe=${probe?.status ?? 'n/a'}`);
    return {
      serverName,
      fingerprint: fingerprint(token.access_token),
      expiresAt,
      created: patch.created,
      replaced: patch.replaced,
      previousFingerprint: patch.previousFingerprint,
      probe,
    };
  }

  /** Refreshes an existing token with the stored refresh token. */
  async function refreshServer(serverName) {
    const credential = await loadCredential(serverName);
    if (!credential?.refresh_token || !credential?.client_id) throw serviceError('refresh_token_unavailable');
    const { servers } = await listConfiguredServers();
    const server = servers.find((item) => item.name === serverName);
    const url = server?.url || credential.url;
    if (!url) throw serviceError('target_url_missing');

    const discovery = await probeDiscovery(serverName, url, server?.type);
    const metadata = discovery.metadata ?? (await loadAuthorizationServerMetadata([credential.url ?? '']));
    if (!metadata?.token_endpoint) throw serviceError('token_endpoint_unresolved');

    const client = {
      client_id: credential.client_id,
      client_secret: credential.client_secret ?? null,
      auth_method: 'client_secret_basic',
    };
    let form = tokenRequestBody({
      grantType: 'refresh_token',
      refreshToken: credential.refresh_token,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      authMethod: client.auth_method,
    });
    let token;
    try {
      token = await requestToken(metadata, client, form);
    } catch (error) {
      form = tokenRequestBody({
        grantType: 'refresh_token',
        refreshToken: credential.refresh_token,
        clientId: client.client_id,
        clientSecret: client.client_secret,
        authMethod: 'client_secret_post',
      });
      client.auth_method = 'client_secret_post';
      token = await requestToken(metadata, client, form);
    }

    const next = {
      ...credential,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? credential.refresh_token,
      token_type: token.token_type ?? 'Bearer',
      scope: token.scope ?? credential.scope,
      expires_in: token.expires_in ?? null,
      obtained_at: new Date().toISOString(),
    };
    await saveCredential(serverName, next);
    const patch = await patchMcpAuthorization(serverName, token.access_token, { url });
    const probe = await probeMcpEndpoint(url, token.access_token, server?.type);
    log('info', `oauth.token_refreshed server=${serverName} probe=${probe.status}`);
    return {
      serverName,
      fingerprint: fingerprint(token.access_token),
      expiresAt: readTokenExpiry(token.access_token),
      replaced: patch.replaced,
      previousFingerprint: patch.previousFingerprint,
      probe,
    };
  }

  /**
   * Patches `mcpServers.<name>.headers.Authorization` in place, keeping the
   * rest of the file byte-identical. Creates the entry when it is missing.
   */
  async function patchMcpAuthorization(serverName, token, { url } = {}) {
    const bearer = `Bearer ${token}`;
    const parsed = await readConfigFile(mcpConfigPath);
    const existing = parsed.servers[serverName];

    if (!existing) {
      const next = { ...parsed.config };
      next.mcpServers = {
        ...parsed.servers,
        [serverName]: {
          type: 'streamable-http',
          enabled: true,
          configured: true,
          builtin: false,
          url: url ?? '',
          headers: { Authorization: bearer },
        },
      };
      return withWriteLock(async () => {
        await backupConfig(mcpConfigPath, backupPath);
        await writeJsonFile(mcpConfigPath, next);
        return { created: true, replaced: false, previousFingerprint: null };
      });
    }
    const headers = existing.headers && typeof existing.headers === 'object' ? existing.headers : null;
    const previous = headers && typeof headers.Authorization === 'string' ? headers.Authorization : '';
    const span = findMemberObjectSpan(parsed.text, serverName);
    if (!span) throw serviceError('server_entry_not_locatable');

    let nextText;
    let replaced = false;
    const authSpan = findMemberStringSpan(parsed.text, 'Authorization', span.start, span.end);
    if (authSpan) {
      // Replace the existing Authorization value in place.
      nextText = `${parsed.text.slice(0, authSpan.start)}${JSON.stringify(bearer)}${parsed.text.slice(authSpan.end)}`;
      replaced = true;
    } else {
      // The entry carries no Authorization header yet - it may authenticate with
      // x-api-key, or not at all. Add the header instead of refusing the write
      // after the user already completed the browser authorization.
      const headersSpan = headers ? findMemberObjectSpan(parsed.text, 'headers', span.start, span.end) : null;
      if (headersSpan) {
        const insertAt = headersSpan.start + 1;
        nextText = `${parsed.text.slice(0, insertAt)}${JSON.stringify('Authorization')}: ${JSON.stringify(bearer)}, ${parsed.text.slice(insertAt)}`;
      } else {
        const insertAt = span.start + 1;
        nextText = `${parsed.text.slice(0, insertAt)}${JSON.stringify('headers')}: { ${JSON.stringify('Authorization')}: ${JSON.stringify(bearer)} }, ${parsed.text.slice(insertAt)}`;
      }
    }

    let verified;
    try {
      verified = JSON.parse(nextText);
    } catch {
      throw serviceError('patched_config_invalid');
    }
    if (verified?.mcpServers?.[serverName]?.headers?.Authorization !== bearer) {
      throw serviceError('patch_verification_failed');
    }
    return withWriteLock(async () => {
      await backupConfig(mcpConfigPath, backupPath);
      await writeFileAtomic(mcpConfigPath, nextText);
      return {
        created: false,
        replaced,
        previousFingerprint: previous ? fingerprint(previous.replace(/^\S+\s+/, '')) : null,
      };
    });
  }

  /** Refreshes every server whose token is inside the refresh window. */
  async function refreshExpiring() {
    const { servers } = await listConfiguredServers();
    const results = [];
    for (const server of servers) {
      const credential = await loadCredential(server.name);
      if (!credential?.refresh_token || !credential?.client_id) continue;
      const expiresAt = readTokenExpiry(credential.access_token);
      if (!Number.isFinite(expiresAt)) continue;
      if (expiresAt - Date.now() > REFRESH_WINDOW_MS) continue;
      try {
        const result = await refreshServer(server.name);
        results.push({ server: server.name, ok: true, expiresAt: result.expiresAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'refresh_failed';
        results.push({ server: server.name, ok: false, reason: message });
        log('warn', `oauth.auto_refresh_failed server=${server.name} reason=${message}`);
      }
    }
    return results;
  }

  function dispose() {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // child already exited
      }
    }
    children.clear();
    pending.clear();
    awaitingConfirmation.clear();
    discoveryCache.clear();
  }

  return {
    mcpConfigPath,
    credentialDir,
    listConfiguredServers,
    buildState,
    probeDiscovery,
    startAuthorization,
    completeAuthorization,
    handleCallback,
    applyGrant,
    writeAuthorization: patchMcpAuthorization,
    refreshServer,
    refreshExpiring,
    dispose,
  };
}
