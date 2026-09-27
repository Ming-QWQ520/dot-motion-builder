# Dot Motion Builder · 单文件本地版

> 点阵动画（dot-matrix loader）可视化编辑器 —— 一个 **自包含单二进制**，双击即用，无需安装 Node.js 或任何依赖。
>
> 衍生自 [LerSent001/dot-motion-builder](https://github.com/LerSent001/dot-motion-builder)；
> 本项目以 **AGPL-3.0** 发布，全文见 [`LICENSE`](./LICENSE)。

[![Release](https://img.shields.io/badge/release-v0.1.1-blue)](../../releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-green)](./LICENSE)

---

## 这是什么

在浏览器里画点阵、调动画、导出生产可用代码的本地工具。整个前端（Next.js 静态导出）在构建时通过 `go:embed` 嵌入 Go 二进制，运行期**零外部依赖、零文件依赖、零网络依赖**（仅监听本机回环地址）。

- **Windows**：双击运行出现一个小控制面板 —— 启动 / 停止 / 打开编辑器 / 退出，端口随手改。
- **Linux / 命令行**：一条命令拉起本地服务，Ctrl+C 优雅退出。
- 项目数据保存在浏览器 `localStorage`，一键导出/导入 JSON 备份。

## 下载

从 [Releases](../../releases) 页面获取对应平台的可执行文件（由 GitHub Actions 自动编译发布）：

| 文件 | 平台 |
| --- | --- |
| `dot-motion-builder-windows-amd64.exe` | Windows x64（含控制面板 GUI） |
| `dot-motion-builder-windows-arm64.exe` | Windows ARM64（含控制面板 GUI） |
| `dot-motion-builder-linux-amd64` | Linux x64 |
| `dot-motion-builder-linux-arm64` | Linux ARM64 |

## 功能亮点

### 编辑器
- 画布平移缩放、多画板、自定义 loader 与序列帧动画。
- **点阵规模 3×3 ~ 20×20**。
- **逐格颜色 / 形状控制**：
  - 右键任意单元格 → 单独编辑该点的颜色与形状（10 色快捷调色板 + 自定义取色器 + 8 种形状）；
  - 画笔模式：选好颜色/形状后直接拖拽绘制，新画的点自动带上单格样式。
- **批量上色**：渐变上色（激活色 → 副色）、彩虹上色、一键重置单格样式。
- **图案变换**：水平/垂直翻转、90° 旋转（正方形网格）、循环上下左右平移、反选——单格样式随图案同步重映射。
- 8 种单元格形状；18 种 mask-safe 运动预设（波浪、扫描、鱼眼、雷达、彗星、萤火虫、万花筒……）。
- 激活/未激活点独立的动画样式（呼吸、幽灵网格等）、发光、透明度与颜色控制。
- 中英文界面切换；项目 JSON 一键备份/恢复；6 个快速图案模板。

### 导出（全部自包含、零运行时依赖）
| 格式 | 说明 |
| --- | --- |
| **JavaScript** | Web Component（Shadow DOM + Canvas），可直接 `<script>` 引入 |
| **SVG** | 自包含动画 SVG（内嵌 CSS keyframes，`<img>` 直接可用） |
| **GIF** | 动图导出：单格像素 4–24px 可调、可选透明背景、实时预览（内置从零实现的 GIF89a/LZW 编码器） |
| **AVD** | AnimatedVectorDrawable（Android 矢量动画，单文件自包含，放入 `res/drawable/` 即用；阶梯 pathInterpolator 精确还原逐帧效果，支持逐格颜色/形状） |
| **Swift** | SwiftUI `Canvas` + `TimelineView` 视图 |

### 服务端（Go，零第三方依赖）
- `go:embed all:frontend` 嵌入完整前端，单二进制分发。
- 路由规范化（`/editor` → 301 → `/editor/`）、404 回退、安全响应头。
- 缓存策略：`_next/static/*` immutable 一年；HTML `no-store`；其余 86400。
- gzip 自动协商；`/api/health`、`/api/version` 健康检查。
- 优雅停机；跨平台自动开浏览器。

## 使用

### Windows（GUI）

双击 exe 即出现控制面板：

- **端口**：启动前可任意修改（默认 3000）。
- **启动服务**：在本机端口拉起编辑器并自动打开浏览器；运行中该按钮变为“停止服务”。
- **退出**：字面意思。

命令行参数仍然可用（在 cmd 中运行 `dot-motion-builder-windows-amd64.exe -version` 等）；
`-nogui` 可强制回到纯控制台模式。

### 命令行（全平台）

```bash
dot-motion-builder [flags]

-addr string    监听地址，如 127.0.0.1:3000 或 :8080
-port int       覆盖 -addr 的端口（1-65535），如 -port=8080
-no-open        启动时不自动打开浏览器
-quiet          关闭逐请求访问日志
-nogui          (Windows) 跳过控制面板，直接在控制台运行
-version        打印版本并退出
```

示例：

```bash
./dot-motion-builder-linux-amd64 -port=8123
./dot-motion-builder-windows-amd64.exe -addr 0.0.0.0:9000 -no-open -nogui
```

启动后：

```
http://127.0.0.1:3000/           # 首页
http://127.0.0.1:3000/editor/    # 编辑器
http://127.0.0.1:3000/api/health # 健康检查
```

## 从源码构建

依赖：Node.js 18+ / pnpm 9+ / Go 1.22+（Linux、macOS、Windows 均可构建，交叉编译无需 CGO）。

```bash
./scripts/build-binary.sh            # 构建当前平台 + windows/amd64
./scripts/build-binary.sh all        # 全平台矩阵
./scripts/build-binary.sh linux/arm64  # 指定单一目标
```

或手动：

```bash
pnpm install && pnpm build          # 产出静态导出 out/
rm -rf server/frontend && cp -a out server/frontend
cd server && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.appVersion=0.1.0 -H windowsgui" \
  -o ../bin/dot-motion-builder-windows-amd64.exe .
```

> Windows 目标请保留 `-H windowsgui`，这样运行时只显示控制面板而不弹出控制台。

### 测试

```bash
pnpm test           # typecheck + 运动采样器 + 导出边界（含 GIF/AVD）
cd server && go test ./...   # HTTP 服务端单元测试
```

### 发布

推送 `v*` 标签即触发 GitHub Actions（`.github/workflows/release.yml`）：构建前端 → 嵌入 →
交叉编译 Windows/Linux × amd64/arm64 → 自动创建 Release 并附上二进制。

## 目录结构

```
src/            Next.js 15 + React 19 前端（纯客户端）
  components/editor/   编辑器 UI（画布、导出面板、单格样式弹窗）
  lib/exporters/       Web / SVG / GIF / AVD / Swift 导出器
  lib/core/            共享运动采样器（编辑器与导出同源）
  stores/              zustand 状态
server/         Go 单二进制后端（含 Windows GUI）
scripts/        一键构建与测试脚本
.github/        Actions 发布流水线
```

## 兼容性说明

- GIF 导出在浏览器内完成（Canvas 栅格化 + 自研 LZW 编码器），超大网格（20×20 全亮 + 高帧率）产物会较大属正常现象。
- AVD 导出不包含发光效果（VectorDrawable 不支持），且超大网格会自动降低关键帧密度以控制文件体积。
- localStorage 项目数据格式与上游编辑器保持一致；新增的逐格样式字段为可选增量，旧数据可直接打开。

## 许可

本项目以 **GNU AGPL-3.0** 发布，全文见 [`LICENSE`](./LICENSE)。
