FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# dependensi dulu supaya layer ter-cache saat hanya kode yang berubah
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY mcp ./mcp
COPY public ./public
COPY scripts ./scripts

# folder data (SQLite + backup) dimiliki user non-root
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
