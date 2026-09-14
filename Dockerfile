FROM node:22-alpine
WORKDIR /app
COPY . /app
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.mjs"]
