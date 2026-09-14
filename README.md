# KODI / Render — V6

## O que foi corrigido

A versão anterior tentava fazer o vídeo sair do provedor, entrar no Render e só depois ir ao VLC. Isso muda o IP de origem da conexão e pode ser recusado pelo provedor, além de acrescentar um salto de rede.

Nesta V6:

- `/canais.m3u` entrega as URLs originais ao VLC/Kodi. O vídeo NÃO atravessa o Render.
- `/canal/<id>.ts` continua existindo para compatibilidade, mas agora responde com redirecionamento HTTP 302 para a URL original.
- Não usa FFmpeg.
- Não transcodifica.
- Não cria buffer de vídeo no servidor.
- Mantém `/health` e `/diagnostico.json`.

## Arquivos para colocar na raiz do GitHub

Substitua/adicione:

- `Dockerfile`
- `server.mjs`
- `.dockerignore`

Mantenha seu `EAGLE_VLC.m3u` atual. Se existir um Secret File do Render chamado `EAGLE_VLC.m3u`, ele tem prioridade.

## Render

- Runtime: Docker
- Dockerfile Path: `./Dockerfile`
- Docker Command/Start Command: vazio

Depois do deploy use no VLC/Kodi:

`https://kodi-vt5s.onrender.com/canais.m3u`

Antes de testar, feche a lista antiga do VLC e abra novamente essa URL para evitar que o VLC continue usando os links `/canal/...` em cache.
