# Build Frontend
FROM oven/bun:latest AS web-builder
WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install
COPY web/ .
RUN bun run build

# Python Training Image
FROM python:3.14-slim AS trainer
WORKDIR /app

RUN pip install --no-cache-dir \
    xgboost==3.0.0 \
    pandas==2.2.3 \
    numpy==2.2.4 \
    scikit-learn==1.6.1

COPY core/training/trainer.py ./training/trainer.py

VOLUME ["/data/training", "/data/models"]
ENTRYPOINT ["python3", "training/trainer.py"]

# Final Stage - Run Backend
FROM oven/bun:latest
WORKDIR /app

# Copy backend source and dependencies
COPY core/package.json core/bun.lock ./
RUN bun install
COPY core/ .

# Copy frontend build results
COPY --from=web-builder /app/dist ./public

# Install Python for training subprocess (optional)
RUN apt-get update && apt-get install -y --no-install-recommends python3 && \
    rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["bun", "index.ts"]
