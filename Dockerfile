FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY agent-ai.mjs model-setup.mjs pdf-extract.mjs agent-queue.mjs operational-memory.mjs cloud-start.mjs state-store.mjs server.mjs firetms.mjs firetms-writes.mjs firetms-schemas.json gmail-oauth.mjs gmail-filters.mjs ptv.mjs ptv-report.mjs ./
COPY cloud-smoke.mjs ./
USER node
EXPOSE 8080
CMD ["node","cloud-start.mjs"]
