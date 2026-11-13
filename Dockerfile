FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=8092
ENV DB_PATH=/app/data/tessera.db
ENV NODE_ENV=production

EXPOSE 8092

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8092/api/health || exit 1

CMD ["node", "src/server/index.js"]
