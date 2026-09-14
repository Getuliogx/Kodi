# EAGLE / Kodi relay — correção

A versão corrigida remove o FFmpeg do caminho do canal e usa proxy HTTP direto, sem transcodificação e sem reempacotamento. Isso elimina o limite artificial de `MAX_STREAMS` da versão anterior e evita segurar o início do vídeo esperando o FFmpeg.

## O que substituir no GitHub

Na raiz do repositório, substitua/adicione somente:

- `Dockerfile`
- `server.mjs`
- `.dockerignore`

**Não substitua sua `EAGLE_VLC.m3u`.** O servidor usa a que já existe no repositório. Se houver `/etc/secrets/EAGLE_VLC.m3u` no Render, ela tem prioridade automaticamente.

## Render

Use o mesmo Web Service com runtime Docker:

- Dockerfile Path: `./Dockerfile`
- Start/Docker Command: vazio
- Não precisa de FFmpeg nem de `ADMIN_PASSWORD`.

Após o deploy, abra:

- `https://SEU-SERVICO.onrender.com/health`
- `https://SEU-SERVICO.onrender.com/diagnostico.json`
- `https://SEU-SERVICO.onrender.com/canais.m3u`

No VLC/Kodi, use a URL que termina em `/canais.m3u`. Ela gera links no formato `/canal/<id>.ts`.

## Segurança

Se a M3U contiver usuário/senha do provedor, o ideal é não deixá-la em repositório público. Mova-a para Render > Environment > Secret Files como `EAGLE_VLC.m3u` e remova a cópia pública depois de trocar/rotacionar as credenciais expostas.
