#!/usr/bin/env bash
# Dinheirama Training Pipeline Runner
#
# Usage:
#   ./training/run.sh collect   # collect training data
#   ./training/run.sh train     # train XGBoost model
#   ./training/run.sh all       # collect + train
#   ./training/run.sh clean     # remove old data
#
# Environment variables:
#   TRAINING_DATA_DIR - where to store training data (default: ./data/training)
#   MODEL_DIR         - where to store trained models (default: ./data/models)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TRAINING_DATA_DIR="${TRAINING_DATA_DIR:-$PROJECT_DIR/data/training}"
MODEL_DIR="${MODEL_DIR:-$PROJECT_DIR/data/models}"
HORIZON="${HORIZON:-5}"

mkdir -p "$TRAINING_DATA_DIR" "$MODEL_DIR"

export TRAINING_DATA_DIR
export MODEL_DIR

collect() {
  echo "=== Collecting training data ==="
  cd "$PROJECT_DIR"
  bun run ./training/collector.ts
  echo "Done. Data in $TRAINING_DATA_DIR"
}

train() {
  echo "=== Training model (horizon=${HORIZON}d) ==="
  pip install -q xgboost pandas numpy scikit-learn
  python3 "$SCRIPT_DIR/trainer.py" \
    --data-dir "$TRAINING_DATA_DIR" \
    --model-dir "$MODEL_DIR" \
    --horizon "$HORIZON"
  echo "Done. Model in $MODEL_DIR"
}

all() {
  collect
  train
}

clean() {
  echo "=== Cleaning old data ==="
  find "$TRAINING_DATA_DIR" -name 'training_*.jsonl' -mtime +90 -delete
  echo "Cleaned data older than 90 days"
  echo "Current files:"
  ls -lh "$TRAINING_DATA_DIR" 2>/dev/null || echo "  (empty)"
}

case "${1:-help}" in
  collect) collect ;;
  train) train ;;
  all) all ;;
  clean) clean ;;
  *)
    echo "Usage: $0 {collect|train|all|clean}"
    echo ""
    echo "  collect  - Fetch current quotes + history and save as training samples"
    echo "  train    - Train XGBoost model from collected data"
    echo "  all      - collect + train"
    echo "  clean    - Remove old training data (>90 days)"
    exit 1
    ;;
esac
