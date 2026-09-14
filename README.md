# EAGLE DIRECT V8 — sem relay de vídeo no Render

Esta versão corrige o erro de arquitetura das versões anteriores: o Render **não retransmite o vídeo**.

## O que ela faz

- `/canais.m3u` lê `EAGLE_VLC.m3u` e devolve uma lista para o VLC/Kodi.
- As URLs de vídeo apontam **diretamente para a origem**.
- Não existe rota `/canal/<id>`.
- Não existe FFmpeg.
- Não existe proxy/relay de MPEG-TS pelo Render.
- Não injeta `network-caching`, `live-caching`, `clock-jitter` ou `clock-synchro`.
- Quando reconhece uma URL Xtream/XUI live sem extensão ou em `.m3u8`, gera a forma direta `.ts`.

## Render

Use Web Service com Docker e Dockerfile `./Dockerfile`.

A playlist pode estar:

- como `EAGLE_VLC.m3u` no projeto; ou
- preferencialmente como Secret File do Render com nome `EAGLE_VLC.m3u`.

Depois do deploy:

- `https://SEU-SERVICO.onrender.com/health`
- `https://SEU-SERVICO.onrender.com/diagnostico.json`
- `https://SEU-SERVICO.onrender.com/canais.m3u`

No diagnóstico, confirme:

- `"videoPath": "DIRECT_ORIGIN_TO_PLAYER"`
- `"renderRelaysVideo": false`
- `"ffmpeg": false`
- `"generatedCanalRoutes": false`

## Sobre atraso

Esta versão elimina o atraso **adicionado pelo relay que estava no nosso código**. Ela não consegue antecipar quadros que o próprio provedor já entrega atrasados em relação à TV aberta.
