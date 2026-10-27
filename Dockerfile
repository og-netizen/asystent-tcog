FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY operational-memory.mjs cloud-start.mjs state-store.mjs server.mjs firetms.mjs firetms-writes.mjs firetms-schemas.json gmail-oauth.mjs gmail-filters.mjs ptv.mjs ptv-report.mjs ./
COPY cloud-smoke.mjs ./
USER node
EXPOSE 8080
CMD ["node","cloud-start.mjs"]
