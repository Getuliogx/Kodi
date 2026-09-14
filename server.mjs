import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

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

function commonVlcOptions(out) {
  out.push('#EXTVLCOPT:network-caching=150');
  out.push('#EXTVLCOPT:live-caching=150');
  out.push('#EXTVLCOPT:http-reconnect=true');
}

// Principal: o VLC recebe as URLs ORIGINAIS. O vídeo não passa pelo Render.
// Isso mantém a mesma origem/IP de rede que já funciona no VLC do usuário e
// evita acrescentar atraso, buffering ou bloqueio por IP de datacenter.
function buildDirectPlaylist() {
  refreshPlaylist(false);
  if (state.loadError || !state.channels.length) throw new Error(state.loadError || 'Playlist vazia');

  const out = ['#EXTM3U'];
  for (const c of state.channels) {
    out.push(c.extinf || `#EXTINF:-1,${c.name}`);
    for (const opt of c.options) out.push(opt);
    commonVlcOptions(out);
    out.push(c.url);
  }
  return out.join('\n') + '\n';
}

// Compatibilidade: gera os mesmos /canal/<id>.ts usados pela versão anterior.
// Cada /canal agora apenas redireciona o VLC à URL original, em vez de tentar
// retransmitir o vídeo a partir do Render.
function buildRedirectPlaylist(req) {
  refreshPlaylist(false);
  if (state.loadError || !state.channels.length) throw new Error(state.loadError || 'Playlist vazia');

  const base = publicBase(req);
  const out = ['#EXTM3U'];
  for (const c of state.channels) {
    out.push(c.extinf || `#EXTINF:-1,${c.name}`);
    for (const opt of c.options) out.push(opt);
    commonVlcOptions(out);
    out.push(`${base}/canal/${c.id}.ts`);
  }
  return out.join('\n') + '\n';
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', extra = {}) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    ...extra,
  });
  res.end(data);
}

function sendJson(res, status, body) {
  sendText(res, status, JSON.stringify(body, null, 2), 'application/json; charset=utf-8');
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
    return sendText(res, ok ? 200 : 503,
      ok
        ? [
            'EAGLE lista direta V6 OK',
            `Canais: ${state.channels.length}`,
            'Use no VLC/Kodi: /canais.m3u',
            'Compatibilidade com links antigos: /canais-render.m3u',
            'Diagnóstico: /diagnostico.json',
            '',
          ].join('\n')
        : `EAGLE com erro\n${state.loadError || 'playlist indisponível'}\n`
    );
  }

  if (req.method === 'GET' && pathname === '/health') {
    const ok = refreshPlaylist(false) && state.channels.length > 0;
    return sendJson(res, ok ? 200 : 503, { ok, channels: state.channels.length, error: state.loadError });
  }

  if (req.method === 'GET' && pathname === '/diagnostico.json') {
    refreshPlaylist(false);
    return sendJson(res, state.loadError ? 503 : 200, {
      ok: !state.loadError,
      source: state.sourcePath,
      channels: state.channels.length,
      loadedAt: state.loadedAt,
      node: process.version,
      mode: 'direct-playlist-no-video-relay',
      channelRoute: '302-redirect-to-original-source',
      error: state.loadError,
    });
  }

  // ESTA é a lista recomendada: URLs originais, sem o vídeo atravessar o Render.
  if (req.method === 'GET' && pathname === '/canais.m3u') {
    try {
      return sendText(res, 200, buildDirectPlaylist(), 'audio/x-mpegurl; charset=utf-8');
    } catch (err) {
      return sendText(res, 503, `Falha ao gerar M3U: ${err.message}\n`);
    }
  }

  // Lista opcional com links do Render; /canal faz somente redirecionamento 302.
  if (req.method === 'GET' && pathname === '/canais-render.m3u') {
    try {
      return sendText(res, 200, buildRedirectPlaylist(req), 'audio/x-mpegurl; charset=utf-8');
    } catch (err) {
      return sendText(res, 503, `Falha ao gerar M3U: ${err.message}\n`);
    }
  }

  const m = pathname.match(/^\/canal\/([a-f0-9]{20})(?:\.ts)?$/i);
  if ((req.method === 'GET' || req.method === 'HEAD') && m) {
    refreshPlaylist(false);
    const channel = state.byId.get(m[1].toLowerCase());
    if (!channel) return sendText(res, 404, 'Canal não encontrado. Atualize /canais.m3u.\n');

    // Não faz proxy. O VLC passa a conectar diretamente à origem.
    res.writeHead(302, {
      Location: channel.url,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end();
  }

  return sendText(res, 404, '404\n');
});

server.requestTimeout = 0;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(PORT, HOST, () => {
  console.log(`[server] V6 ouvindo em http://${HOST}:${PORT}`);
});
