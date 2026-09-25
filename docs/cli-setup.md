# CLI 安装与接入

瀟湘館支持 Codex、OpenCode 和独立 Antigravity CLI（`agy`）。只安装要用的引擎即可。工作台会调用本机 CLI，沿用该 CLI 的账号、服务商和模型配置；它不负责替你登录。使用翻译 API 时不需要安装这些 CLI。

下面的安装命令由你在终端执行。Windows 运行本工作台时使用原生 Windows CLI；本项目没有提供 Windows 后台跨 WSL 调用的桥接。

## Codex

### 安装

Windows：在 PowerShell 运行官方独立安装器。

```powershell
irm https://chatgpt.com/codex/install.ps1 | iex
```

macOS / Linux：

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

独立安装器的默认命令目录是 Windows 的 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` 或 macOS/Linux 的 `~/.local/bin`。安装后打开一个新终端。来源：[官方安装器与安装目录说明](https://learn.chatgpt.com/docs/config-file/environment-variables#installer-variables)。

已使用 npm 管理 Codex 的用户也可运行 `npm install -g @openai/codex@latest`。Windows 若得到的是 `.cmd` / `.ps1` 启动脚本，接入工作台时需找到该安装包中的原生 `codex.exe`，或使用上面的独立安装器。来源：[官方 npm 安装示例](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#quickstart-using-goals)。

### 登录与检查

```sh
codex --version
codex
```

首次运行 `codex` 时选择 ChatGPT 或 CLI 提供的其他登录方式，按终端和浏览器提示完成。登录后退出交互界面即可，翻译时无需保持该终端打开。来源：[Codex CLI 官方入门](https://learn.chatgpt.com/docs/codex/cli)。

工作台通过 `codex app-server` 获取模型和推理强度，通过 `codex exec` 生成译文；模型和额度以该账号实际权限为准。

## OpenCode

### 安装

本轮适配并验证的是 OpenCode **1.x** 的 `run --format json` 和 `models --verbose` 协议，已在 1.18.30 上完成连通检查。下面提供该版本的可复现安装方式；尚未验证 OpenCode 2.x。

Windows：打开 [官方 1.18.30 发布页](https://github.com/anomalyco/opencode/releases/tag/v1.18.30)，普通 Intel/AMD 64 位电脑下载 `opencode-windows-x64.zip`，ARM64 电脑下载 `opencode-windows-arm64.zip`。解压到固定目录，保留包内文件。例如，若 `opencode.exe` 位于 `C:\Tools\OpenCode\opencode.exe`，在 PowerShell 运行：

```powershell
& "C:\Tools\OpenCode\opencode.exe" --version
& "C:\Tools\OpenCode\opencode.exe" auth login
```

以上是示例路径，请替换为实际解压位置。在工作台的 CLI 路径字段填同一个 `.exe` 绝对路径即可，无需配置 PATH。若想直接使用 `opencode` 命令，将所在目录加入用户 PATH，然后打开新终端。

macOS / Linux：已安装 Node.js/npm 时，可固定安装已验证版本：

```sh
npm install -g opencode-ai@1.18.30
opencode --version
opencode auth login
```

已有 Scoop 的 Windows 用户也可按 [OpenCode 官方安装说明](https://opencode.ai/docs/#windows) 使用 `scoop install opencode`。包管理器版本会变化，安装后先检查 `opencode --version` 和上述协议是否可用。

### 授权与模型

`opencode auth login` 会让你选择服务商，并按其要求填写 API Key 或完成授权；也可运行交互界面中的 `/connect`。自定义兼容地址和模型还需要在 OpenCode 自己的配置中设置，工作台不会自动写入它的服务商配置。来源：[官方授权命令](https://opencode.ai/docs/cli/#auth)、[服务商配置](https://opencode.ai/docs/providers/)。

授权后可运行 `opencode models` 查看模型名称。接入时模型 ID 使用 `provider/model`，推理强度来自该模型公开的 variants。桌面应用若没有附带独立 CLI，需要按上述步骤安装；不要将图形界面的 `OpenCode.exe` 填作 CLI 路径。

## Antigravity CLI（agy）

### 安装

Windows PowerShell：

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

macOS / Linux：

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

默认原生程序位置为 Windows 的 `%LOCALAPPDATA%\agy\bin\agy.exe` 或 macOS/Linux 的 `~/.local/bin/agy`。来源：[官方安装与授权说明](https://antigravity.google/docs/cli/install)。

### 授权与检查

打开新终端，运行：

```sh
agy --version
agy
```

`agy` 会尝试使用系统安全凭据存储中的已有登录；没有有效登录时会打开浏览器完成授权。按首次启动提示完成设置，再退出交互界面。来源：[官方本机授权流程](https://antigravity.google/docs/cli/install#local-silent-keyring-sign-in)。

可再运行 `agy models` 查看模型目录。工作台使用独立 `agy` 的 JSON 输入/输出协议，强度为 `low` / `medium` / `high`；编辑器启动命令 `antigravity` 不适用于该接入方式。

## 在瀟湘館中接入

1. 在 CLI 中完成登录或服务商配置后，打开瀟湘館的“设置 → 翻译引擎”。
2. 选择对应 CLI。先点“检测安装”；找不到时填写原生可执行文件的绝对路径，再检测。
3. 点“读取模型与强度”。选择账号可用的模型和强度，也可保留 CLI 默认值。
4. 点“保存引擎配置”，或点“测试并保存”实际发起一次小请求。仅检测安装和读取目录不代表模型一定能生成。
5. 返回书库打开章节，点击“翻译本章”。任务使用入队时的引擎配置，之后修改设置只影响新任务。

Windows 可用下列命令查找 PATH 上的原生程序；只查你已经安装的引擎即可：

```powershell
Get-Command codex.exe, opencode.exe, agy.exe -ErrorAction SilentlyContinue |
  Select-Object Name, Source
```

也可在启动后台前设置 `CODEX_PATH`、`OPENCODE_PATH`、`ANTIGRAVITY_PATH`。例如 PowerShell 中设置 `$env:ANTIGRAVITY_PATH = 'C:\Tools\agy\agy.exe'` 后，在同一终端启动工作台。这些值是程序路径，不是账号密钥。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 终端能运行，工作台检测不到 | 填写 `.exe` 绝对路径。若刚安装或改过 PATH，关闭后台后重新启动，让后台读取新环境。仅刷新网页不会更新后台环境变量。 |
| 提示不能使用 shell 包装脚本 | Windows 请选择原生 `.exe`，而不是 npm 的 `.cmd` / `.ps1` 包装文件；优先使用上面的原生安装方式。 |
| 已检测到安装，但测试要求登录 | 在同一个系统用户下运行该 CLI，完成交互登录或服务商授权，再测试。 |
| 模型可列出，但调用失败 | 检查模型权限、额度、网络及 CLI 提示；模型目录读取成功不等同于生成授权成功。 |
| 提示未知参数或 JSON 事件不兼容 | 检查 CLI 版本；OpenCode 可使用上面已验证的 1.18.30。保留现有配置，先用一章或连接测试验证新版本。 |
| 只在 WSL 安装了 CLI | Windows 后台使用 Windows CLI；若要用 Linux CLI，需要在同一个 WSL 环境中运行整个工作台。 |

安装与官方入口核对于 2026-09-25。工作台不会自动安装或更新这些 CLI，也不会自动更改全局账号、服务商和模型配置。
