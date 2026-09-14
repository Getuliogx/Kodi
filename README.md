# EAGLE DIRECT V8 FIX — URL ORIGINAL

Correção mínima da V8.

O erro da V8 era a função que convertia URLs como:

`http://servidor/usuario/senha/62169`

para:

`http://servidor/usuario/senha/62169.ts`

Alguns servidores não aceitam essa forma e o VLC retorna "A entrada não pode ser aberta".

## Esta correção mantém a arquitetura da V8

- Render entrega apenas `/canais.m3u`.
- O vídeo continua indo direto do provedor para VLC/Kodi.
- Não existe relay `/canal/<id>`.
- Não existe FFmpeg.
- Não existe transcodificação.
- NÃO acrescenta `.ts`.
- NÃO converte para `.m3u8`.
- Preserva a URL de cada canal exatamente como está na `EAGLE_VLC.m3u`.

## Substitua

- `server.mjs`
- `Dockerfile`
- `.dockerignore`

Mantenha sua `EAGLE_VLC.m3u`.

## Verificação

Abra `/diagnostico.json` e confirme:

- `"urlRewrite": false`
- `"appendsTs": false`
- `"keepsOriginalProviderUrl": true`
- `"renderRelaysVideo": false`
