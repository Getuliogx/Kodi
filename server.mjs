import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);
const MAX_REDIRECTS = 6;

const playlistCandidates = [
  process.env.M3U_FILE,
  '/etc/secrets/EAGLE_VLC.m3u',
  '/app/EAGLE_VLC.m3u',
  './EAGLE_VLC.m3u',
].filter(Boolean);

function findPlaylist() {
  for (const p of playlistCandidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function isHttpUrl(v) {
  return /^https?:\/\//i.test(String(v || '').trim());
}

function channelId(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
}

function loadPlaylist(baseUrl) {
  const path = findPlaylist();
  if (!path) throw new Error(`EAGLE_VLC.m3u não encontrada. Procurado em: ${playlistCandidates.join(', ')}`);

  const src = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const map = new Map();
  const out = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (isHttpUrl(line)) {
      const id = channelId(line);
      map.set(id, line);
      out.push(`${baseUrl}/canal/${id}.ts`);
    } else {
      // Preserva toda metadata original (#EXTM3U, #EXTINF, logos, grupos etc.)
      out.push(raw);
    }
  }

  return {
    path,
    map,
    body: out.join('\n').replace(/\n+$/, '') + '\n'
  };
}

function getBaseUrl(req) {
  const fallbackProto = req.socket?.encrypted ? 'https' : 'http';
  const proto = (req.headers['x-forwarded-proto'] || fallbackProto).split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function noCacheHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    ...extra
  };
}

function send(res, status, body, type='text/plain; charset=utf-8') {
  const data = Buffer.from(body);
  res.writeHead(status, noCacheHeaders({
    'Content-Type': type,
    'Content-Length': data.length
  }));
  res.end(data);
}

function safeUpstreamHeaders(req) {
  const h = {
    'User-Agent': req.headers['user-agent'] || 'VLC/3.0.21 LibVLC/3.0.21',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive'
  };
  if (req.headers.range) h['Range'] = req.headers.range;
  if (req.headers['if-range']) h['If-Range'] = req.headers['if-range'];
  return h;
}

function openUpstream(target, clientReq, clientRes, redirects = 0) {
  if (redirects > MAX_REDIRECTS) {
    return send(clientRes, 502, 'Muitos redirecionamentos no provedor.\n');
  }

  let u;
  try {
    u = new URL(target);
  } catch {
    return send(clientRes, 502, 'URL de origem inválida.\n');
  }

  const transport = u.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(u, {
    method: clientReq.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: safeUpstreamHeaders(clientReq),
    timeout: 15000,
    agent: false
  }, (upstreamRes) => {
    const code = upstreamRes.statusCode || 502;

    if ([301,302,303,307,308].includes(code) && upstreamRes.headers.location) {
      upstreamRes.resume();
      const next = new URL(upstreamRes.headers.location, u).toString();
      return openUpstream(next, clientReq, clientRes, redirects + 1);
    }

    const headers = noCacheHeaders({
      'Content-Type': upstreamRes.headers['content-type'] || 'video/mp2t',
      'Accept-Ranges': upstreamRes.headers['accept-ranges'] || 'bytes',
      'Connection': 'keep-alive'
    });

    if (upstreamRes.headers['content-range']) headers['Content-Range'] = upstreamRes.headers['content-range'];
    if (upstreamRes.headers['content-length']) headers['Content-Length'] = upstreamRes.headers['content-length'];

    clientRes.writeHead(code, headers);
    if (clientRes.flushHeaders) clientRes.flushHeaders();

    // Desliga Nagle em ambos os lados para reduzir espera de pequenos pacotes.
    clientRes.socket?.setNoDelay(true);
    upstreamRes.socket?.setNoDelay(true);
    upstreamRes.socket?.setKeepAlive(true, 10000);

    if (clientReq.method === 'HEAD') {
      upstreamRes.resume();
      return clientRes.end();
    }

    // Relay cru: nenhum FFmpeg, nenhum remux, nenhum transcoding.
    // Cada byte recebido do provedor é enviado imediatamente ao player.
    upstreamRes.on('data', (chunk) => {
      if (!clientRes.write(chunk)) upstreamRes.pause();
    });
    clientRes.on('drain', () => upstreamRes.resume());

    upstreamRes.on('end', () => {
      if (!clientRes.writableEnded) clientRes.end();
    });
    upstreamRes.on('error', () => {
      if (!clientRes.writableEnded) clientRes.destroy();
    });

    const stop = () => {
      upstreamRes.destroy();
      upstreamReq.destroy();
    };
    clientReq.on('aborted', stop);
    clientRes.on('close', stop);
  });

  upstreamReq.on('socket', (s) => {
    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('timeout')));
  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      send(clientRes, 502, `Falha ao abrir origem: ${err.message}\n`);
    } else {
      clientRes.destroy();
    }
  });

  upstreamReq.end();
}

const server = http.createServer((req, res) => {
  res.socket?.setNoDelay(true);

  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch {}

  if (req.method === 'GET' && pathname === '/') {
    try {
      const p = loadPlaylist(getBaseUrl(req));
      return send(res, 200,
        `EAGLE RAW RELAY OK\n` +
        `Canais: ${p.map.size}\n` +
        `Relay: RAW BYTE-FOR-BYTE\n` +
        `FFmpeg: NÃO\n` +
        `Transcode: NÃO\n` +
        `Remux: NÃO\n` +
        `Lista: /canais.m3u\n`
      );
    } catch (e) {
      return send(res, 503, `EAGLE RAW RELAY ERRO\n${e.message}\n`);
    }
  }

  if (req.method === 'GET' && pathname === '/health') {
    try {
      const p = loadPlaylist(getBaseUrl(req));
      return send(res, 200, JSON.stringify({
        ok: true,
        channels: p.map.size,
        mode: 'RAW_BYTE_FOR_BYTE',
        ffmpeg: false,
        transcode: false,
        remux: false
      }) + '\n', 'application/json; charset=utf-8');
    } catch (e) {
      return send(res, 503, JSON.stringify({ok:false,error:e.message}) + '\n', 'application/json; charset=utf-8');
    }
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/canais.m3u') {
    try {
      const p = loadPlaylist(getBaseUrl(req));
      if (req.method === 'HEAD') {
        const len = Buffer.byteLength(p.body);
        res.writeHead(200, noCacheHeaders({
          'Content-Type': 'audio/x-mpegurl; charset=utf-8',
          'Content-Length': len
        }));
        return res.end();
      }
      return send(res, 200, p.body, 'audio/x-mpegurl; charset=utf-8');
    } catch (e) {
      return send(res, 503, `Falha ao gerar M3U: ${e.message}\n`);
    }
  }

  const m = pathname.match(/^\/canal\/([a-f0-9]{24})\.ts$/i);
  if ((req.method === 'GET' || req.method === 'HEAD') && m) {
    try {
      const p = loadPlaylist(getBaseUrl(req));
      const origin = p.map.get(m[1].toLowerCase());
      if (!origin) return send(res, 404, 'Canal não encontrado.\n');
      return openUpstream(origin, req, res);
    } catch (e) {
      return send(res, 503, `Falha no relay: ${e.message}\n`);
    }
  }

  return send(res, 404, '404\n');
});

// Live stream não pode ser encerrado por timeout do servidor.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 20000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, () => {
  console.log(`[EAGLE] RAW relay ouvindo em http://${HOST}:${PORT}`);
});
