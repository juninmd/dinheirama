# Build Frontend
FROM oven/bun:latest AS web-builder
WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install
COPY web/ .
RUN bun run build

# Final Stage - Run Backend
FROM oven/bun:latest
WORKDIR /app

# Copy backend source and dependencies
COPY core/package.json core/bun.lock ./
RUN bun install
COPY core/ .

# Copy frontend build results
COPY --from=web-builder /app/dist ./public

EXPOSE 3000
CMD ["bun", "index.ts"]
