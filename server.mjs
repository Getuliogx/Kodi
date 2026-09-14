import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

const playlistCandidates = [
  process.env.M3U_FILE,
  '/etc/secrets/EAGLE_VLC.m3u',
  '/app/EAGLE_VLC.m3u',
  './EAGLE_VLC.m3u',
].filter(Boolean);

function findPlaylistPath() {
  for (const p of playlistCandidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

// Canonicaliza URLs de live Xtream/XUI para MPEG-TS contínuo, quando o padrão é reconhecido.
// Não cria proxy e não faz o vídeo passar pelo Render.
function canonicalDirectTs(rawUrl) {
  const original = String(rawUrl || '').trim();
  try {
    const u = new URL(original);
    const parts = u.pathname.split('/').filter(Boolean);

    // Rewrite comum: /USER/PASS/STREAM_ID  ou /USER/PASS/STREAM_ID.m3u8|.ts
    if (parts.length === 3 && /^\d+(?:\.(?:ts|m3u8))?$/i.test(parts[2])) {
      const id = parts[2].replace(/\.(?:ts|m3u8)$/i, '');
      u.pathname = `/${parts[0]}/${parts[1]}/${id}.ts`;
      return u.toString();
    }

    // Endpoint explícito: /live/USER/PASS/STREAM_ID.m3u8|.ts
    if (parts.length === 4 && parts[0].toLowerCase() === 'live' && /^\d+(?:\.(?:ts|m3u8))?$/i.test(parts[3])) {
      const id = parts[3].replace(/\.(?:ts|m3u8)$/i, '');
      u.pathname = `/live/${parts[1]}/${parts[2]}/${id}.ts`;
      return u.toString();
    }
  } catch {}
  return original;
}

function buildDirectPlaylist(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let urlCount = 0;
  let canonicalized = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Removemos somente opções que alteram buffer/clock do player.
    // A latência do player não deve ser mascarada como "correção" do servidor.
    if (/^#EXTVLCOPT:(?:network-caching|live-caching|file-caching|disc-caching|clock-jitter|clock-synchro)=/i.test(line)) {
      continue;
    }

    if (isHttpUrl(line)) {
      const direct = canonicalDirectTs(line);
      if (direct !== line) canonicalized++;
      urlCount++;
      out.push(direct);
      continue;
    }

    out.push(raw.trimEnd());
  }

  if (!out.length || !out[0].trim().startsWith('#EXTM3U')) {
    out.unshift('#EXTM3U');
  }

  return {
    body: out.join('\n') + '\n',
    urlCount,
    canonicalized,
  };
}

function loadPlaylist() {
  const path = findPlaylistPath();
  if (!path) {
    throw new Error(`EAGLE_VLC.m3u não encontrado. Procurado em: ${playlistCandidates.join(', ')}`);
  }
  const st = fs.statSync(path);
  const text = fs.readFileSync(path, 'utf8');
  const built = buildDirectPlaylist(text);
  if (!built.urlCount) throw new Error('Nenhuma URL HTTP/HTTPS encontrada na M3U.');
  return { path, mtimeMs: st.mtimeMs, size: st.size, ...built };
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  const data = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
  });
  res.end(data);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2) + '\n', 'application/json; charset=utf-8');
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}

  if (req.method === 'GET' && pathname === '/') {
    try {
      const p = loadPlaylist();
      return send(res, 200,
        `EAGLE DIRECT OK\n` +
        `Canais/URLs: ${p.urlCount}\n` +
        `Vídeo passa pelo Render: NÃO\n` +
        `Lista: /canais.m3u\n` +
        `Diagnóstico: /diagnostico.json\n`
      );
    } catch (e) {
      return send(res, 503, `EAGLE DIRECT ERRO\n${e.message}\n`);
    }
  }

  if (req.method === 'GET' && pathname === '/health') {
    try {
      const p = loadPlaylist();
      return sendJson(res, 200, { ok: true, urls: p.urlCount, canonicalizedToTs: p.canonicalized });
    } catch (e) {
      return sendJson(res, 503, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && pathname === '/diagnostico.json') {
    try {
      const p = loadPlaylist();
      return sendJson(res, 200, {
        ok: true,
        source: p.path,
        urls: p.urlCount,
        canonicalizedToTs: p.canonicalized,
        videoPath: 'DIRECT_ORIGIN_TO_PLAYER',
        renderRelaysVideo: false,
        ffmpeg: false,
        generatedCanalRoutes: false,
        forcedPlayerCache: false,
      });
    } catch (e) {
      return sendJson(res, 503, { ok: false, error: e.message });
    }
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/canais.m3u') {
    try {
      const p = loadPlaylist();
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'audio/x-mpegurl; charset=utf-8',
          'Content-Length': Buffer.byteLength(p.body),
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        });
        return res.end();
      }
      return send(res, 200, p.body, 'audio/x-mpegurl; charset=utf-8');
    } catch (e) {
      return send(res, 503, `Falha ao gerar M3U direta: ${e.message}\n`);
    }
  }

  // Intencional: NÃO existe /canal/<id> nesta versão.
  // Qualquer reprodução deve sair diretamente do player para o provedor.
  return send(res, 404, '404\n');
});

server.requestTimeout = 0;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(PORT, HOST, () => {
  console.log(`[server] EAGLE DIRECT ouvindo em http://${HOST}:${PORT}`);
});
