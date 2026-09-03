# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ── Production dependencies ──────────────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── API runtime ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public

RUN mkdir -p uploads/images && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]

# ── Scraper worker runtime (adds Chromium for Playwright) ────────────────────
FROM node:24-alpine AS worker

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# playwright-core drives the distro Chromium, avoiding a 300MB browser download.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p uploads/images && chown -R node:node /app
USER node

CMD ["node", "dist/worker.js"]
