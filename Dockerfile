# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:20-alpine AS builder

# better-sqlite3 needs native compilation tools
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend and server source
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY src/shared ./src/shared
COPY public ./public

RUN mkdir -p /app/data

VOLUME ["/app/data"]
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npx", "tsx", "server/index.ts"]
