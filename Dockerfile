FROM node:22-alpine
WORKDIR /app
COPY server.mjs /app/server.mjs
COPY EAGLE_VLC.m3u* /app/
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.mjs"]
