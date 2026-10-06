# Build Frontend
FROM oven/bun:1-slim AS web-builder
WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ .
RUN bun run build

# Python Training Image
# 3.12 e nao 3.14: numpy 2.2.4, pandas 2.2.3, scikit-learn 1.6.1 e onnx nao
# publicam wheel cp314, entao no 3.14 o pip cai para build a partir do sdist.
# Este estagio nunca chegou a ser exercitado porque o estagio final nao depende
# dele e o BuildKit pula estagio nao alcancado -- por isso o erro so aparecia
# em runtime, no CronJob de treino.
FROM python:3.12-slim AS trainer
WORKDIR /app

RUN pip install --no-cache-dir \
    xgboost==3.0.0 \
    pandas==2.2.3 \
    numpy==2.2.4 \
    scikit-learn==1.6.1 \
    onnx==1.22.0

COPY core/training/trainer.py core/training/splits.py ./training/

VOLUME ["/data/training", "/data/models"]
ENTRYPOINT ["python3", "training/trainer.py"]

# Final Stage - Run Backend
FROM oven/bun:1-slim
WORKDIR /app

# Python para o subprocesso de treino (opcional). Fica antes do código para o layer ser reaproveitado do cache.
RUN apt-get update && apt-get install -y --no-install-recommends python3 && \
    rm -rf /var/lib/apt/lists/*

# Dependências de produção primeiro: só reinstalam quando package.json/bun.lock mudam
COPY core/package.json core/bun.lock ./
# sem --frozen-lockfile: o core/bun.lock atual referencia `ollama` sem entrada de pacote e o modo congelado falha
RUN bun install --production

COPY core/ .

# Frontend já vem pré-comprimido (.br/.gz) pelo build e é servido sem custo de CPU
COPY --from=web-builder /app/dist ./public

EXPOSE 3000
CMD ["bun", "index.ts"]
