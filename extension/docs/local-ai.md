# 本地 AI 与硬件

## 本机实测

| 项目 | 值 |
|---|---|
| CPU | Intel i5-10210U，4 核 8 线程，AVX2，15 W |
| 内存 | 14 GiB（可用约 7 GiB） |
| GPU | 无独显 / 无 CUDA |
| 磁盘 | 53 GB 可用 |
| Ollama | 0.5.12，`deepseek-r1:1.5b` Q4_K_M |
| 端口 | 11434 Ollama；8080 已被其他服务占用 |

### Ollama 1.5B 实测

| 线程 | tok/s |
|---|---|
| 2 | 4.22 |
| 4 | 5.78–6.45 |
| 8 | 1.27（严重争抢） |

冷启动加载约 10 秒；短句热身后约 2–5 秒。`deepseek-r1:1.5b` 是 reasoning 模型，会产生额外 `think` token，不适合做字幕主力。

推论：3B 约 3 tok/s（30 token 字幕约 8–10 秒），7B 约 1.3 tok/s，只适合离线批处理。**本地模型只做兜底**。

## 推荐配置

- LLM：`qwen2.5:3b-instruct`（约 1.9 GB），4 线程，`num_ctx=2048`；速度优先可换 1.5B。
- ASR：whisper.cpp `ggml-base.bin`（142 MB）默认；CJK 准确率优先用 `small`（466 MB）；太慢用 `tiny`。
- 不要用满 8 线程；不要同时跑本地 LLM + 本地 ASR + 视频，15 W CPU 会明显掉帧。
- 仅插电时使用本地模式；电池模式建议云端。

## 本地 ASR 服务

`local-asr/server.mjs` 是零依赖 Node 代理：

- 启动并守护 `whisper-server`（127.0.0.1:8788）；
- 对外 127.0.0.1:8787，提供 CORS + OpenAI 兼容 `/v1/audio/transcriptions`；
- 扩展发送裸 16 kHz 单声道 WAV，服务端转 multipart；
- 只绑定 localhost，不对外网开放。

实测（`ggml-base.bin`，4 线程，11 秒 JFK 样本）：转写耗时约 **8.8 秒，RTF ≈ 0.80**。也就是说 base 模型刚好接近实时：5 秒语音段约 4 秒处理，加上翻译后总延迟约 8–10 秒。若觉得慢，用 `tiny` 或云端 ASR；`small` 更准但会明显慢于实时。

```bash
cd local-asr
./setup.sh base
node server.mjs --model base
```

若 RTF（处理时间/音频时长）> 0.8，实时字幕会积压，建议换 `tiny` 或云端 ASR。

## 为什么不在本机训练

- 现成 Qwen/Whisper 对字幕已足够；瓶颈是延迟、审核和工程链路，不是模型容量。
- 本机无 GPU、内存 14 GiB，7B 推理都紧张，训练/微调不现实。
- 如未来确需微调：租 24 GB GPU 做 LoRA（3B/7B + 1–5 万条字幕对），不在本机进行；MVP 不包含。
- 术语/人名一致性用 glossary + 上下文解决，不靠训练。

## 云端成本参考

- OpenCode Go：按订阅额度；DeepSeek V4.1 Flash 约 $0.15/$0.60 每百万 token（off-peak）。
- Groq Whisper Large v3 Turbo：远低于 OpenAI Whisper；具体以官网为准。
- 1 小时视频字幕翻译通常只有几万 token；音频 ASR 成本按分钟计。
