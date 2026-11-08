# freeSubtitle

网页视频外语 → 中文字幕。

## 当前实现

Chrome MV3 扩展在 [`extension/`](extension/README.md)：

- 字幕轨优先（YouTube / HTML5 TextTrack），无字幕时抓标签页音频做 ASR；
- 云端翻译（OpenCode Go / OpenAI 兼容）优先，本地 Ollama 兜底；
- 云端内容审核拒绝时自动降级，不中断会话；
- 本地 ASR 伴随服务在 [`local-asr/`](local-asr/README.md)（Node + whisper.cpp，可选）；
- 不做模型训练；本机（i5-10210U / 无独显）只适合本地兜底。

快速开始：

```bash
cd extension
npm install --cache ./.npm-cache
npm run build
# chrome://extensions → 开发者模式 → 加载 extension/dist
```

详细安装、OpenCode Go / Ollama / 本地 ASR 配置见 [extension/README.md](extension/README.md)。

## 文档

- [架构](extension/docs/architecture.md)
- [本地 AI 与硬件](extension/docs/local-ai.md)
- [隐私说明](extension/docs/privacy.md)
- [QA 清单](extension/docs/qa.md)
