# freeSubtitle 项目约束

## 发布与扩展压缩包

- 扩展压缩包 `freeSubtitle-<version>.zip` 只在打 tag 时创建。日常 `npm run build` / `npm run watch` / `npm test` 都不产出 zip，也不要提前生成。
- 发布顺序：
  1. 同步 `extension/package.json` 与 `extension/manifest.json` 的版本号；
  2. `npm run typecheck && npm test && npm run build`；
  3. 提交后打 tag `v<version>`；
  4. `npm run zip` 生成压缩包；
  5. 把 zip 附到对应的 GitHub Release。
- `npm run zip` 会校验当前 HEAD 正好是 `v<version>` tag 且工作区干净；未打 tag 或工作区有改动时直接报错退出，不要用绕过的方式产出压缩包。
- `extension/dist/`、`extension/node_modules/`、`extension/.npm-cache/`、根目录 `freeSubtitle-*.zip` 都是产物，不进版本库。

## 本地开发

- 安装依赖用 `npm install --cache ./.npm-cache`，不依赖全局 npm 缓存。
- 提交前必须跑通 `npm run typecheck` 和 `npm test`。
- `npm run watch` 只在启动时复制静态文件；改了 `extension/public/` 需要重启 watch。

## 文档

- 安装与配置见 `extension/README.md`，架构、隐私、本地 AI、QA 在 `extension/docs/`。
- 改动行为时同步更新对应文档；新的限制写进“已知限制”，不要只留在提交信息里。
