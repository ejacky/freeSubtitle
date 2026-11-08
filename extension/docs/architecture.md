# 架构

## 数据流

```
Popup/Options
  │ runtime message
Service Worker ── tabCapture streamId / 注入 content / 翻译队列 / 缓存
  │ Port + 20s heartbeat                 │ tabs.sendMessage
Offscreen（抓取+回放+VAD+WAV）        Content（视频发现+字幕+覆盖层）
  │
Providers：OpenCode Go / Ollama / Groq/OpenAI ASR / local-whisper
```

- **Service Worker**：会话状态机、provider 链、翻译调度、拒绝降级、IndexedDB 缓存。
- **Offscreen**：`getUserMedia({chromeMediaSource:'tab'})` 抓音频；单独 playback AudioContext 回放原声；AudioWorklet 采集 16 kHz PCM；能量 VAD 分段；WAV 编码；20 秒心跳保活 SW。
- **Content**：发现 `<video>`（含 open shadow root）、选择最大播放视频、读取 YouTube timedtext / TextTrack、Shadow DOM 双语覆盖层、按 `video.currentTime` 同步。
- **Popup/Options**：启动/停止、模式、provider 配置、Key、健康状态、隐私同意。

## 为什么字幕优先

有字幕轨时不需要 ASR，延迟接近零、成本低、内容审核面更小。无字幕才抓音频；音频链路本身有 4–8 秒延迟，无法做到同传级。

## 关键实现点

- `tabCapture` 会让原标签页静音，offscreen 必须把 stream 接回 `AudioContext.destination`，否则用户听不到原声。
- `activeTab` + `scripting.executeScript({allFrames:true})` 注入；`frameId === 0` 是合法值，不能用 falsy 判断（曾因此导致 top-frame 字幕消息被丢弃）。
- **音频段必须 base64**：Chrome 扩展消息是 JSON 序列化的，直接传 `ArrayBuffer` 到 SW 会变成 `{}`，ASR 收到 15 字节的 `[object Object]` 后返回 400。0.1.2 在 offscreen 编码 base64、SW 解码。
- 日语识别：优先使用 ASR 返回的 `language` / cue 的 `lang`；只有缺失时才用文本判断，且检测到假名直接判为日语。否则“漢字比例高”的日语会被误当成中文而跳过翻译。
- 字幕 cue 以 `start-end-hash(text)` 为 id；SW 维护 cue 表，按 `currentTime` 前后窗口批量翻译；seek 只清滚动 ASR 行，不清已预取的字幕。
- 翻译缓存 key 与 provider 无关（target + 原文 + 上下文 + glossary + prompt 版本），换 provider 仍可复用。
- 审核拒绝按 cue 记录负缓存，避免同一条敏感台词反复打同一个 provider。
- `chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` 防止内容脚本读 Key。

## 失败模式

| 场景 | 行为 |
|---|---|
| 云端 policy 拒绝 | 拆批/换 provider；3 次后切本地；全失败显示原文 |
| ASR 不可用 | 提示启动 local-asr 或填云 Key；字幕轨仍可用 |
| SW 被终止 | offscreen 心跳重连；失败则停止并提示 |
| YouTube timedtext 403 | DOM 字幕兜底；再失败走音频 |
| DRM | 检测 `video.mediaKeys`，提示不支持，不绕过 |
| 后台标签页 | rAF 被节流，字幕可能不刷新；保持前台 |

## 扩展点

- 新 ASR：实现 `AsrProvider`，在 `providers/registry.ts` 注册 kind。
- 新翻译：实现 `ChatProvider`；OpenAI 兼容服务直接加配置即可。
- 新站点字幕：实现 `CaptionSource`，在 `content/caption-sources/controller.ts` 选择。
