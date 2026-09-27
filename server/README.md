# Go 单二进制集成说明

Dot Motion Builder 的前端是纯客户端的本地优先应用（数据存于浏览器 localStorage，无任何服务端 API 依赖），因此可以完整静态导出后，通过 Go 的 `//go:embed` 嵌入单一可执行文件。最终产物 **一个 exe 即包含整个编辑器**，无需 Node.js、无需外部静态目录、拷到哪台机器都能直接跑。

Windows 构建附带一个轻量控制面板 GUI（底部两键：启动↔停止、退出，端口可改）：纯 Win32 syscall 实现，零第三方依赖，交叉编译友好。

## 目录结构

```text
server/
  go.mod          Go 模块（module github.com/Ming-QWQ520/dot-motion-builder/server）
  main.go         HTTP 服务：静态托管 + gzip + 缓存策略 + 健康检查 API + appServer 生命周期
  gui_windows.go  Windows 控制面板 GUI（纯 Win32 syscall，含 -H windowsgui 构建）
  gui_stub.go     非 Windows 平台的 runGUI 存根
  main_test.go    单元测试（路由、缓存策略、gzip、安全头、API、-port 组合）
  frontend/       构建时从 out/ 复制而来（已 gitignore，嵌入源）
scripts/
  build-binary.sh     Linux / macOS 一键构建脚本
  build-binary.ps1    Windows PowerShell 一键构建脚本
bin/                  构建产物输出目录
```

## 一键构建

```bash
# Linux / macOS（默认构建 当前平台 + windows/amd64）
./scripts/build-binary.sh

# 指定目标
./scripts/build-binary.sh windows/amd64
./scripts/build-binary.sh all        # 全平台矩阵

# Windows 上原生构建
powershell -ExecutionPolicy Bypass -File scripts\build-binary.ps1
```

脚本会依次完成：安装依赖 → `next build` 静态导出 → 复制 `out/` 到 `server/frontend/` → 交叉编译到 `bin/`。

手动等价流程：

```bash
pnpm build
rm -rf server/frontend && cp -a out server/frontend
cd server
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X main.appVersion=0.1.0 -H windowsgui" -o ../dot-motion-builder.exe .
```

> Windows 目标请保留 `-H windowsgui`：运行时只显示控制面板窗口，不弹控制台。Linux/macOS 不需要。

## 运行

### Windows：控制面板

双击 exe 直接出现控制面板窗口（无需命令行）：

- **端口**：启动前可改（默认取 `-addr`/`-port` 的值，初始 3000）；
- **启动服务**：拉起本地服务并自动打开浏览器（`-no-open` 可禁用）；运行中按钮变为“停止服务”；
- **退出**：即字面含义；窗口右上角关闭按钮与“退出”等价（会先优雅停机）；运行中点击状态行可重新打开编辑器。

需要命令行行为时加 `-nogui`。

### 命令行（全平台）

```bash
./dot-motion-builder-windows-amd64.exe              # Windows：默认直接进入控制面板
./dot-motion-builder-windows-amd64.exe -nogui       # Windows：强制控制台模式
./dot-motion-builder -port=8080                    # 自定义端口（推荐写法）
./dot-motion-builder -port 8080                    # 等价写法
./dot-motion-builder -addr 0.0.0.0:8080            # 同时指定监听地址
./dot-motion-builder -no-open                       # 不自动打开浏览器
./dot-motion-builder -quiet                         # 关闭访问日志
./dot-motion-builder -version                       # 查看版本
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-port` | `0`（不覆盖） | 自定义端口，1-65535；设置后覆盖 `-addr` 中的端口部分，主机地址仍由 `-addr` 决定 |
| `-addr` | `127.0.0.1:3000` | 监听地址；`:8080` 表示全网卡，可与 `-port` 组合 |
| `-no-open` | `false` | 启动时不自动唤起系统浏览器 |
| `-quiet` | `false` | 抑制逐请求访问日志 |
| `-nogui` | `false` | （仅 Windows）跳过控制面板，直接在控制台运行 |
| `-version` | - | 打印版本后退出 |

启动后自动打开 `http://127.0.0.1:<端口>/editor/`。`Ctrl+C` 优雅停机。

## 服务端行为

- **静态托管**：`/` → 首页；`/editor` → 301 → `/editor/`；未知路径返回导出自带的 `404.html`（状态码 404）。
- **缓存策略**（复刻原部署意图）：
  - `_next/static/*` 内容哈希资源 → `public, max-age=31536000, immutable`
  - HTML / txt → `no-store, no-cache, must-revalidate`（换新二进制立即可见）
  - 字体、图片等其他资源 → `public, max-age=86400`
- **gzip**：对文本类资源 ≥512B 自动压缩（按 `Accept-Encoding` 协商，带 `Vary` 头）。
- **安全头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`。
- **API**：`GET /api/health`（状态/版本/运行时长）、`GET /api/version`（版本/Go 工具链）。
- **`-port` 参数**：`resolveListenAddr` 将 `-addr` 的主机与 `-port` 的端口组合；端口非法（超出 1-65535）时报错退出。
- **路径安全**：请求路径经 `path.Clean` 归一化，无法穿越出嵌入文件系统。

## 关键实现点

1. **`//go:embed all:frontend`** —— 必须带 `all:` 前缀。Next.js 的资源在 `_next/` 目录（下划线开头），默认 embed 规则会跳过 `_`/`.` 开头的文件，漏掉 `all:` 会导致样式脚本全部 404。
2. **`output: "export"` + `trailingSlash: true`** —— 静态导出并让链接统一带尾斜杠，配合服务端目录索引与 301 规则，保证相对资源路径在任何入口 URL 下都正确解析。
3. **移除 `/editor` 的 `force-dynamic` / `revalidate = 0`** —— 原指令用于防 CDN 缓存，与静态导出不兼容；等价语义已由 Go 服务端的 `no-store` 响应头接管。
4. **零第三方依赖** —— 仅用标准库（`embed`、`net/http`、`compress/gzip` 等），交叉编译加 `CGO_ENABLED=0` 无任何系统库依赖。

## 环境要求

- 构建期：Node.js 20+、pnpm 11+、Go 1.27.1+
- 运行期：无任何依赖（单文件自包含）
