#!/usr/bin/env bash
# Build whisper.cpp and download a multilingual model for local ASR.
# Usage: ./setup.sh [base|small|tiny]
set -euo pipefail

cd "$(dirname "$0")"
MODEL="${1:-base}"
ROOT="$(pwd)"
VENDOR="$ROOT/vendor/whisper.cpp"
MODEL_DIR="$ROOT/models"
MODEL_FILE="$MODEL_DIR/ggml-${MODEL}.bin"

if ! command -v cmake >/dev/null 2>&1; then
  echo "需要 cmake；请先安装（例如 sudo apt install cmake build-essential）" >&2
  exit 1
fi

if [ ! -d "$VENDOR/.git" ]; then
  echo "==> clone whisper.cpp"
  mkdir -p "$ROOT/vendor"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$VENDOR"
fi

echo "==> build whisper-server"
cmake -S "$VENDOR" -B "$VENDOR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=ON \
  -DWHISPER_BUILD_SERVER=ON
cmake --build "$VENDOR/build" -j"$(nproc)" --target whisper-server

if [ ! -x "$VENDOR/build/bin/whisper-server" ]; then
  echo "构建完成但找不到 build/bin/whisper-server" >&2
  exit 1
fi

mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_FILE" ]; then
  HF_BASE="${HF_ENDPOINT:-https://huggingface.co}"
  URL="${HF_BASE%/}/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"
  echo "==> download ggml-${MODEL}.bin from $HF_BASE"
  curl -L --fail --retry 5 --retry-delay 3 -o "$MODEL_FILE" "$URL"
fi

echo
echo "完成。启动："
echo "  node server.mjs --model $MODEL"
echo
echo "提示：模型下载走 HuggingFace；网络受限时可设置 HTTPS_PROXY 或 HF_ENDPOINT=https://hf-mirror.com"
