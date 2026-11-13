# 维护图文手册

[返回功能目录](index.md)

## 核对功能入口

路由以 `web/src/router.tsx` 和 `web/src/routes/settings/categories.ts` 为准。任务入口在 `web/src/components/Tasks/`，会话菜单在 `SessionActionMenu.tsx`，输入栏在 `AssistantChat/ComposerButtons.tsx`，任务助手在 `components/Assistant/`。

新增按钮时，同时更新对应章节的操作步骤和总目录；有权限或 agent 能力限制时必须写出。页面底部记录了核对的源码文件。

## 重新生成截图

在仓库根目录启动仅本机访问的 Vite：

```bash
CHOKIDAR_USEPOLLING=1 bun run --cwd web dev -- --port 5288 --host 127.0.0.1
```

另开终端，在仓库根目录执行：

```bash
node design/launch/manual-screenshots.mjs
```

使用自定义 Playwright 浏览器安装位置时，设置 `PLAYWRIGHT_BROWSERS_PATH`。单独重拍可以指定 `DOCS_SHOTS=files,directories`。脚本仅接受 localhost/127.0.0.1 的截图地址。

截图来自正式组件；任务场景复用 `assistant-panel-demo`，设置与文件场景使用 `manual-fixture`。所有 `/api/` 请求都由截图脚本提供演示响应。终端截图只展示连接/控件，不连接真实 shell。不得填入真实 token、私有会话或生产数据。

脚本输出的截图位于本目录 `assets/`；逐页提取的界面文字与来源记录写到 `/tmp/dugong-manual-screenshots.json`。重拍后检查：没有错误页、没有加载中界面、文字完整、图片和操作说明一致。

## 构建与检查

```bash
bun run --cwd docs docs:build
```

文档站已有本地搜索。新章节应同时接入 `docs/.vitepress/config.ts` 的侧栏和本目录 `index.md`。GitHub 阅读使用 Markdown 相对链接。小节使用标准 HTML `<a name="section-id"></a>` 锚点，目录通过 `page.md#section-id` 跳转；不要改成仅文档站支持的标题后缀语法。站点由 VitePress 转换页面链接。

版本号只说明截图来源，不表示新版本已经发布。不要把功能介绍写成尚未完成的质量验收结论。
