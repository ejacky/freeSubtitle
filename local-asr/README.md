# local-asr — 本地 Whisper 伴随服务

给 freeSubtitle 的“无字幕视频”提供离线语音识别。结构：

- `whisper.cpp` 的 `whisper-server` 常驻内存，加载一次模型；
- `server.mjs` 是零依赖的 Node 反向代理，补 CORS，并把扩展发来的裸 WAV 转成 whisper.cpp 需要的 multipart；
- 只监听 `127.0.0.1:8787`，不对外网开放。

## 环境

- Linux / macOS / WSL2（Windows 原生需自行准备 CMake 与预编译 whisper.cpp）
- Node.js ≥ 20
- CMake + C/C++ 编译器
- 约 1 GB 磁盘（base 模型 + 构建产物）

## 首次安装

```bash
cd local-asr
./setup.sh base       # 或 small（更准更慢）、tiny（更快更糙）
```

如果 GitHub/HuggingFace 访问受限：

```bash
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export HF_ENDPOINT=https://hf-mirror.com
./setup.sh base
```

## 启动

```bash
node server.mjs --model base
# [asr] ready at http://127.0.0.1:8787
```

扩展设置里“本地 ASR 地址”填 `http://127.0.0.1:8787`，点“测试本地服务”应显示正常。

## 手动测试

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"model":"base","ready":true,...}

curl -s -X POST 'http://127.0.0.1:8787/v1/audio/transcriptions?model=base&language=en' \
  -H 'Content-Type: audio/wav' --data-binary @sample.wav
# {"text":"...","language":"en","durationMs":...}
```

扩展发的是 16 kHz / 单声道 / 16-bit PCM WAV，不需要 ffmpeg。

## 性能与参数

- 本机（i5-10210U，4 核 8 线程，无独显）建议 `--threads 4`，不要用满 8 线程。
- `base` 多语言模型约 142 MB；`small` 约 466 MB，CJK 更准但更慢。
- 本机实测：`base` + 4 线程，11 秒 JFK 样本耗时约 8.8 秒，**RTF ≈ 0.80**，刚好接近实时。
- 如果 RTF（处理时间/音频时长）持续 > 0.8，实时字幕会越积越多，建议换 `tiny` 或改用云端 ASR（Groq/OpenAI）。
- 端口被占用时可用 `--port 8787 --whisper-port 8788`；`8080` 在本机已被其他服务占用。

## 常见问题

- **找不到 whisper-server / 模型**：先跑 `./setup.sh base`。
- **扩展报 CORS/无法连接**：确认服务监听 `127.0.0.1:8787`，且扩展有 `http://127.0.0.1/*` host 权限。
- **识别质量差**：换 `small`，减少背景音乐，确认视频本身有清晰人声。
- **DRM 视频**：可能完全抓不到音频，本服务无法解决，也不提供绕过。
