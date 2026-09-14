import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const MAX_REDIRECTS = 6;
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 12000);
const UPSTREAM_USER_AGENT = process.env.UPSTREAM_USER_AGENT || 'VLC/3.0.21 LibVLC/3.0.21';

const playlistCandidates = [
  process.env.M3U_FILE,
  '/etc/secrets/EAGLE_VLC.m3u',
  '/app/EAGLE_VLC.m3u',
  './EAGLE_VLC.m3u',
].filter(Boolean);

let state = {
  sourcePath: null,
  mtimeMs: 0,
  size: 0,
  channels: [],
  byId: new Map(),
  loadedAt: null,
  loadError: null,
};

function safeName(text) {
  return String(text || '').replace(/[\r\n\0]/g, ' ').trim();
}

function channelId(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 20);
}

function findPlaylistPath() {
  for (const p of playlistCandidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function parsePlaylist(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      const name = comma >= 0 ? line.slice(comma + 1).trim() : `Canal ${channels.length + 1}`;
      pending = { extinf: raw.trim(), name: safeName(name), options: [] };
      continue;
    }

    if (pending && line.startsWith('#')) {
      // Preserve channel-scoped metadata/options, but we add our own low-cache hints later.
      if (!/^#EXTVLCOPT:(network-caching|file-caching|live-caching|http-reconnect)=/i.test(line)) {
        pending.options.push(raw.trim());
      }
      continue;
    }

    if (pending && /^(https?):\/\//i.test(line)) {
      const url = line;
      const id = channelId(url);
      channels.push({ id, url, name: pending.name, extinf: pending.extinf, options: pending.options });
      pending = null;
      continue;
    }

    // Ignore orphaned URLs/comments instead of corrupting the generated M3U.
    pending = null;
  }

  return channels;
}

function refreshPlaylist(force = false) {
  const sourcePath = findPlaylistPath();
  if (!sourcePath) {
    state.loadError = `EAGLE_VLC.m3u não encontrado. Procurado em: ${playlistCandidates.join(', ')}`;
    return false;
  }

  try {
    const st = fs.statSync(sourcePath);
    if (!force && state.sourcePath === sourcePath && state.mtimeMs === st.mtimeMs && state.size === st.size) {
      return true;
    }

    const text = fs.readFileSync(sourcePath, 'utf8');
    const channels = parsePlaylist(text);
    if (!channels.length) throw new Error('Nenhum canal HTTP/HTTPS válido foi encontrado na M3U.');

    state = {
      sourcePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
      channels,
      byId: new Map(channels.map((c) => [c.id, c])),
      loadedAt: new Date().toISOString(),
      loadError: null,
    };
    console.log(`[m3u] ${channels.length} canais carregados de ${sourcePath}`);
    return true;
  } catch (err) {
    state.loadError = String(err?.message || err);
    console.error('[m3u] falha:', state.loadError);
    return false;
  }
}

function publicBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function buildRelayPlaylist(req) {
  refreshPlaylist(false);
  if (state.loadError || !state.channels.length) throw new Error(state.loadError || 'Playlist vazia');

  const base = publicBase(req);
  const out = ['#EXTM3U'];
  for (const c of state.channels) {
    out.push(c.extinf || `#EXTINF:-1,${c.name}`);
    for (const opt of c.options) out.push(opt);
    out.push('#EXTVLCOPT:network-caching=250');
    out.push('#EXTVLCOPT:live-caching=250');
    out.push('#EXTVLCOPT:http-reconnect=true');
    out.push(`${base}/canal/${c.id}.ts`);
  }
  return out.join('\n') + '\n';
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const data = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function openUpstream(target, clientReq, clientRes, redirects = 0) {
  let u;
  try {
    u = new URL(target);
  } catch {
    text(clientRes, 502, 'URL de origem inválida.');
    return;
  }

  const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
  if (!mod) {
    text(clientRes, 502, 'Protocolo da origem não suportado.');
    return;
  }

  const headers = {
    'User-Agent': UPSTREAM_USER_AGENT,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Connection': 'close',
  };
  if (clientReq.headers.range) headers.Range = clientReq.headers.range;

  const upstreamReq = mod.request(u, {
    method: clientReq.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    timeout: CONNECT_TIMEOUT_MS,
    rejectUnauthorized: true,
  }, (upstreamRes) => {
    upstreamRes.socket?.setNoDelay?.(true);

    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
      upstreamRes.resume();
      if (redirects >= MAX_REDIRECTS) {
        text(clientRes, 502, 'Muitos redirecionamentos na origem.');
        return;
      }
      const next = new URL(upstreamRes.headers.location, u).toString();
      openUpstream(next, clientReq, clientRes, redirects + 1);
      return;
    }

    const status = upstreamRes.statusCode || 502;
    const outHeaders = {
      'Content-Type': upstreamRes.headers['content-type'] || 'video/mp2t',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    };
    if (upstreamRes.headers['content-length']) outHeaders['Content-Length'] = upstreamRes.headers['content-length'];
    if (upstreamRes.headers['content-range']) outHeaders['Content-Range'] = upstreamRes.headers['content-range'];
    if (upstreamRes.headers['accept-ranges']) outHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];
    if (upstreamRes.headers['icy-name']) outHeaders['icy-name'] = upstreamRes.headers['icy-name'];
    if (upstreamRes.headers['icy-metaint']) outHeaders['icy-metaint'] = upstreamRes.headers['icy-metaint'];

    clientRes.writeHead(status, outHeaders);
    if (clientReq.method === 'HEAD') {
      upstreamRes.resume();
      clientRes.end();
      return;
    }

    upstreamRes.on('error', (err) => {
      console.error('[upstream response]', err.message);
      if (!clientRes.destroyed) clientRes.destroy(err);
    });

    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('socket', (socket) => socket.setNoDelay?.(true));
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('timeout conectando à origem')));
  upstreamReq.on('error', (err) => {
    console.error('[upstream request]', err.message);
    if (!clientRes.headersSent) text(clientRes, 502, `Origem indisponível: ${err.message}`);
    else if (!clientRes.destroyed) clientRes.destroy(err);
  });

  const stop = () => {
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  };
  clientReq.once('aborted', stop);
  clientRes.once('close', stop);

  upstreamReq.end();
}

refreshPlaylist(true);

const server = http.createServer((req, res) => {
  req.socket.setNoDelay(true);

  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {}

  if (req.method === 'GET' && pathname === '/') {
    const ok = refreshPlaylist(false) && state.channels.length > 0;
    return text(res, ok ? 200 : 503,
      ok
        ? `EAGLE relay OK\nCanais: ${state.channels.length}\nLista: /canais.m3u\nDiagnóstico: /diagnostico.json\n`
        : `EAGLE relay com erro\n${state.loadError || 'playlist indisponível'}\n`
    );
  }

  if (req.method === 'GET' && pathname === '/health') {
    const ok = refreshPlaylist(false) && state.channels.length > 0;
    return json(res, ok ? 200 : 503, { ok, channels: state.channels.length, error: state.loadError });
  }

  if (req.method === 'GET' && pathname === '/diagnostico.json') {
    refreshPlaylist(false);
    return json(res, state.loadError ? 503 : 200, {
      ok: !state.loadError,
      source: state.sourcePath,
      channels: state.channels.length,
      loadedAt: state.loadedAt,
      error: state.loadError,
      node: process.version,
      relay: 'direct-http-no-transcode',
    });
  }

  if (req.method === 'GET' && pathname === '/canais.m3u') {
    try {
      const body = buildRelayPlaylist(req);
      return text(res, 200, body, 'audio/x-mpegurl; charset=utf-8');
    } catch (err) {
      return text(res, 503, `Falha ao gerar M3U: ${err.message}\n`);
    }
  }

  const m = pathname.match(/^\/canal\/([a-f0-9]{20})(?:\.ts)?$/i);
  if ((req.method === 'GET' || req.method === 'HEAD') && m) {
    refreshPlaylist(false);
    const channel = state.byId.get(m[1].toLowerCase());
    if (!channel) return text(res, 404, 'Canal não encontrado. Atualize /canais.m3u.\n');
    return openUpstream(channel.url, req, res);
  }

  return text(res, 404, '404\n');
});

server.requestTimeout = 0;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(PORT, HOST, () => {
  console.log(`[server] ouvindo em http://${HOST}:${PORT}`);
});
