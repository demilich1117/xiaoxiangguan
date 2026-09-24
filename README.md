# 瀟湘館

瀟湘館是本机运行的单人翻译与阅读工作台。导入无 DRM 的 EPUB、PDF 或 AZW3，整理章节，用自己的模型 API 翻译为简体中文，校订后导出可阅读 EPUB。支持日语、英语、法语、德语、西班牙语原文。界面和书库仅在本机 127.0.0.1 提供服务；项目不提供账号或云同步。

## 安装与启动

需要 Node.js 20 或更新版本，以及 Python 3。先安装 Python 依赖：

~~~sh
python -m pip install -r requirements.txt
npm start
~~~

Windows 也可双击 start-library.cmd 启动，双击 stop-library.cmd 停止。网页地址是 http://127.0.0.1:4327/ 。如有多个 Python，可设置 PYTHON_PATH 为安装了依赖的 Python 可执行文件绝对路径；项目内 .venv 也会被自动识别。更改端口可在启动前设置 PORT。

首次启动会创建空书库。导入作品后，在“API 设置”中配置自己的服务商和密钥；可使用 OpenAI、DeepSeek、本机 Ollama 或兼容接口。翻译请求会发送到你配置的模型地址；仅在主动启用联网查证时才使用单独配置的 Brave Search API。连接测试会实际发起请求，可能产生费用。无密钥也可浏览书库，但不能调用需认证的翻译服务。

## 本机数据与迁移

书籍、译文、导出文件及密钥保存在用户数据目录，界面“API 设置 → 本机数据”会显示实际路径。默认位置：

| 系统 | 数据目录 |
| --- | --- |
| Windows | %LOCALAPPDATA%\Xiaoxiangguan |
| macOS | ~/Library/Application Support/Xiaoxiangguan |
| Linux | $XDG_DATA_HOME/xiaoxiangguan，未设置时为 ~/.local/share/xiaoxiangguan |

数据目录下的 data/ 存放书库索引，library/ 存放原书和工作文件，exports/ 存放 EPUB，secrets/ 存放 API 配置。可在启动前设置 TRANSLATION_LIBRARY_DATA_DIR 为**绝对路径**来指定整个数据目录。迁移时先停止程序，再复制整个数据目录到新位置，并设置该变量。旧版本若已在项目目录的 data/library.json 存有书库，程序会继续使用原项目目录；可以按上述方式迁移。不要将数据目录、密钥或导入的书籍提交到公开仓库。

Windows 上密钥优先使用当前用户的 DPAPI 保护。其他环境或 DPAPI 不可用时，程序将配置文件限制为当前用户可读写，并在设置页提示。请保护本机账户和备份；本项目没有远程账户隔离。

## PDF OCR 与外部工具

可选安装 Tesseract OCR、Poppler（pdftoppm）及 Calibre（AZW3 转换）。文本型 PDF 不要求 OCR；扫描 PDF 需要对应的 Tesseract 语言模型。日语、英语、法语、德语、西班牙语分别使用 jpn、eng、fra、deu、spa，日语竖排建议另装 jpn_vert。设置页会显示各语种 OCR 是否就绪。

程序先检查显式配置，再检查常见安装位置和 PATH。可用这些环境变量指定自定义安装：

| 变量 | 值 |
| --- | --- |
| PYTHON_PATH | Python 可执行文件绝对路径 |
| TESSERACT_PATH | Tesseract 可执行文件绝对路径 |
| TESSDATA_PREFIX | 包含 .traineddata 文件的目录，或其上级目录 |
| PDFTOPPM_PATH | pdftoppm 可执行文件绝对路径 |
| CALIBRE_PATH | ebook-convert 可执行文件绝对路径 |

例如 Windows PowerShell：

~~~powershell
$env:TESSERACT_PATH = 'C:\Program Files\Tesseract-OCR\tesseract.exe'
$env:TESSDATA_PREFIX = 'C:\Program Files\Tesseract-OCR\tessdata'
npm start
~~~

## 开发

~~~sh
python -m pip install -r requirements.txt
npm test
~~~

测试使用临时样本，不需要 API Key。项目源代码使用 [GNU GPL v3.0](LICENSE)；贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。作品原文及生成译文的使用权由各自权利人与使用者决定，仓库不附带用户书籍或密钥。
