FROM node:22-bookworm-slim
WORKDIR /app
COPY . /app
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node", "/app/server.mjs"]
