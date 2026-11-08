# freeSubtitle Chrome 扩展

把网页视频的外语字幕/语音翻译成中文，覆盖在视频上。默认双语（原文 + 中文）。

- **字幕优先**：YouTube 字幕轨、页面 `<track>` 直接读取并翻译，延迟低、成本低。
- **音频兜底**：没有字幕时抓取当前标签页音频 → VAD 分段 → ASR → 翻译。
- **云端优先 + 本地兜底**：OpenCode Go / 其他 OpenAI 兼容服务失败时，自动切本地 Ollama。
- **内容审核降级**：云端拒绝敏感内容时不中断，切本地模型或显示原文。
- **不训练模型**：只使用现成量化模型；本机硬件只适合做兜底。

## 快速开始

```bash
cd extension
npm install --cache ./.npm-cache
npm run typecheck
npm test
npm run build
```

Chrome / Chromium → `chrome://extensions` → 打开“开发者模式” → “加载已解压的扩展程序” → 选择 `extension/dist`。

> 注意：Google Chrome 品牌版从 137 起可能忽略 `--load-extension` 命令行参数；手动“加载已解压”不受影响。无头测试请用 Chromium。

## 配置

打开扩展的“设置与 API Key”：

### 1. 翻译服务（OpenCode Go）

1. 在 OpenCode Console 创建 API key（CLI 登录凭证不能直接复用）。
2. 在“翻译服务”里给 OpenCode Go 条目填 Key。
3. 默认模型：
   - `deepseek-v4.1-flash`（中文强、便宜，`reasoning_effort=low`）
   - `gpt-6-luna`（`reasoning_effort=none`，不支持 temperature）
   - `glm-5.3-flash`
4. 点“测试”确认能返回译文。

扩展会自动发送 `x-opencode-session`（每个视频会话一个 UUID）。如果网关返回 `MissingSessionID`，检查该请求头是否被代理丢弃。

**条款提醒**：OpenCode Go 官方定位是编码代理，字幕翻译属于非典型流量，可能被限流。建议保留本地 Ollama 兜底，或换成通用 LLM API。

### 2. 本地翻译（可选但推荐）

```bash
ollama pull qwen2.5:3b-instruct
# 如果扩展连接 Ollama 被 CORS 拒绝：
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

本机实测（i5-10210U，4 线程）1.5B Q4 约 5.8–6.5 tok/s；8 线程反而降到约 1.3 tok/s。3B 约 3 tok/s，适合兜底，不适合主力实时。

### 3. 本地语音识别（无字幕视频）

```bash
cd ../local-asr
./setup.sh base          # 首次：构建 whisper.cpp + 下载 base 模型
node server.mjs          # http://127.0.0.1:8787
```

设置里“本地 ASR 地址”填 `http://127.0.0.1:8787`，点“测试本地服务”。详细说明见 [local-asr/README.md](../local-asr/README.md)。

如果不想装本地服务，也可以填 Groq / OpenAI 的 ASR Key，扩展会优先走云端。

## 使用

1. 打开视频页面，点击工具栏里的 freeSubtitle 图标。
2. 选择“自动（优先字幕轨）/ 只用字幕轨 / 只用音频识别”。
3. 点“开始翻译本页视频”。
4. 视频底部出现原文 + 中文双语字幕；设置里可切纯中文、字号、位置、隐藏原生字幕。
5. 也可以按 **Alt+Shift+Y** 直接开始/停止（不打开 popup 的快捷路径）。

- 有字幕轨：通常 1 个 cue 内出现中文；预取会提前翻译后续 120 秒。
- 无字幕：语音结束后约 4–8 秒出现滚动中文；倍速 > 1.6x 时质量会下降。
- 点击“停止”释放音频捕获、恢复原声、移除字幕。

## 内容审核与降级

- 云端返回 policy/refusal 时，自动换下一个 provider；批量失败会拆成单条重试。
- 同一视频累计 3 次拒绝后切到本地模型（可在设置中改阈值）。
- 所有 provider 都失败时显示原文 + “未翻译”标记，不会卡死。
- 默认忠实翻译，不自动删改原意。

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab` + `scripting` | 用户点击扩展后，只向当前标签页注入字幕覆盖层 |
| `tabCapture` | 捕获当前标签页音频（仅在音频模式/自动兜底时） |
| `offscreen` | 在后台保持音频捕获与回放，关闭 popup 后继续 |
| `storage` | 保存设置、API Key、翻译缓存 |

- 不使用 `<all_urls>` 内容脚本；自定义服务域名在保存设置时按需申请 host 权限。
- API Key 只存 `chrome.storage.local`，并限制为 trusted contexts；内容脚本拿不到。
- 不做 analytics，不加载远程代码。

## 排查：X / 无字幕视频没有中文字幕

> 0.1.2 修复了音频段传输（base64）；并追加修复“日语汉字比例高被误判为中文而跳过翻译”。升级后必须重新加载扩展并刷新页面。

1. 确认模式是“自动（优先字幕轨）”或“只用音频识别”；X 视频通常没有字幕轨。
2. 开始后看 popup 的“音频 N%”：
   - 长期 0%：视频静音、标签页被静音，或 DRM/受保护内容；先取消静音并确认能听到声音。
3. 看“服务状态”：
   - Groq / OpenCode 的圆点是红色时，meta 会显示最后错误（401、403、无法连接等）。
   - 在设置里对 Groq 和 OpenCode 分别点“测试”。Groq 测试会发 1 秒测试音频，验证 key、host 权限和模型。
4. 如果底部出现日文但没有中文：说明音频/ASR 通了，翻译 provider 失败；看 provider 错误或切本地 Ollama。日语使用 ASR/cue 的 language 标签优先判断，检测到假名时不会按中文跳过翻译。
5. 如果页面底部出现“未检测到视频元素”的浮层：说明音频字幕在工作，只是没找到 `<video>`（X 的播放器有时在 shadow DOM/modal 里）；这版会退化到页面底部字幕。
6. 仍然没有：在设置里点“复制诊断日志”，把 JSON 发出来（日志不含字幕正文）。

注意：Chrome 扩展消息是 JSON 序列化的，`ArrayBuffer` 会变成 `{}`。0.1.0 的音频段就是这样丢掉内容的；**0.1.2 改为 base64 传输**。升级后要在 `chrome://extensions` 点一次“重新加载”，并刷新 X 页面。

## 已知限制

- **DRM 内容**（Netflix、Disney+ 等）可能抓不到音频；扩展只提示，不提供绕过。
- **画中画**里无法显示扩展字幕。
- **后台标签页**的 `requestAnimationFrame` 会被浏览器节流，字幕可能不刷新；请保持视频标签页在前台。
- 受站点字幕接口变化影响（如 YouTube timedtext 需要 `pot` token），会自动退到 DOM 字幕或音频。
- 本地 ASR 在无独显机器上可能慢于实时；建议 `base`/`tiny` 或云端 ASR。
- 目前只翻译为简体中文，MVP 不包含配音/TTS。

## 开发

```bash
npm run watch     # esbuild watch（静态文件只在启动时复制）
npm run build     # dist/
npm run zip       # 仅打 tag 后使用，生成 freeSubtitle-<version>.zip
npm test          # Vitest
npm run typecheck # tsc --noEmit
```

测试覆盖：VAD、WAV、JSON 解析、校验、拒绝识别、SSE、缓存 key、设置合并。

Mock provider：在设置里添加 `kind: "mock"`（需要手动改存储或测试代码），可在没有 API key 时验证字幕覆盖层。实际产品不暴露该选项。

## 目录

```
extension/
  manifest.json
  scripts/build.mjs
  public/worklet/pcm-tap.js
  src/background/   # 会话、注入、provider、降级
  src/offscreen/    # tabCapture、回放、VAD、WAV
  src/content/      # 视频发现、字幕适配、覆盖层
  src/lib/          # 设置、翻译、缓存、provider
  src/ui/           # popup / options
  tests/
  docs/
```
