# EAGLE RAW RELAY — baixa latência

Este pacote recria o relay sem FFmpeg.

O objetivo é simples:
- o Render entrega `/canais.m3u`;
- cada canal aponta para `/canal/<id>.ts`;
- o servidor abre a URL ORIGINAL da M3U;
- os bytes do provedor são repassados diretamente para VLC/Kodi;
- não há transcode, remux, `.ts` acrescentado à URL original, HLS novo ou buffer artificial do servidor.

## Arquivos
Substitua no GitHub:
- `server.mjs`
- `Dockerfile`
- `.dockerignore`

Mantenha a sua `EAGLE_VLC.m3u` original. O servidor procura primeiro:
1. variável `M3U_FILE`;
2. `/etc/secrets/EAGLE_VLC.m3u`;
3. `/app/EAGLE_VLC.m3u`;
4. `./EAGLE_VLC.m3u`.

## Render
Para não publicar credenciais da lista, o recomendado é criar Secret File:
- Filename: `EAGLE_VLC.m3u`
- Conteúdo: sua M3U original

A URL para VLC/Kodi:
`https://SEU-SERVICO.onrender.com/canais.m3u`

Diagnóstico:
`https://SEU-SERVICO.onrender.com/health`

O `/health` deve mostrar:
- `mode: RAW_BYTE_FOR_BYTE`
- `ffmpeg: false`
- `transcode: false`
- `remux: false`

## Importante
O relay não altera codecs de áudio ou vídeo: ele envia os mesmos bytes recebidos da origem.
