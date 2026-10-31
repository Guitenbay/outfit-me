# Outfit Me

本地优先的 Agent 个人衣橱、搭配与有据可查的整套选购助手。已有衣物优先，购物只补缺口；不是独立电商网站、通用爬虫或自动下单工具。

## 目前能做什么

- 可移植 Skill：建档、衣橱整理、场合/天气约束搭配、风格探索、选购与反馈流程。
- Python 标准库 SQLite CLI：七类记录、结构/引用校验、事务、导出与删除。
- 结构化订单暂存、去重和用户确认入衣橱；**不包含 OCR 或订单页自动读取**。
- **商品搜索与加购必须加载 Chrome 扩展**：购物 MCP 默认 `BROWSER_MODE=extension`，只通过你授权的标签页工作，未加载扩展时无法搜索、读取详情或加购。已附该扩展与购物 MCP 源码，支持京东、淘宝/天猫独立授权、默认只读浏览与详情提取。淘宝/天猫可另行启用在 Agent 内原生确认后直接操作网页的受控加购，扩展弹窗是可选替代，不开放通用点击、下单、结算或支付；受控加购支持旧版与已观测新版商品控件，已做隔离真实浏览器 DOM 测试，实际加购结果仍需现场验证，无法识别的页面拒绝执行；不保证平台持续可用或所有 SKU 字段完整。
- 外部天气、小红书灵感服务不捆绑，由宿主及独立连接器提供。无连接器时接受用户提供的链接、截图、文字和天气，并明确未知信息。

Skill 文本是行为约定，不是权限沙箱。没有内置模型 API、独立聊天 GUI、自动视觉搜同款或保证实时库存的能力。`evals/scenarios.json` 是未执行的模型行为验收案例，不是已通过的模型评估。

## 快速开始

要求 Python 3.10+。核心无需 pip、联网、模型凭据或浏览器。

在本目录运行：

```sh
python -B -m unittest discover -s tests -v
python -B scripts/release.py verify
python skills/outfit-me/scripts/store.py --help
python skills/outfit-me/scripts/orders.py --help
```

仅在同意本地保存之后初始化数据库。PowerShell：

```powershell
$db = Join-Path (Get-Location) 'private-data/outfit-me.sqlite3'
python skills/outfit-me/scripts/store.py --db "$db" init
python skills/outfit-me/scripts/store.py --db "$db" list wardrobe
```

macOS / Linux：

```sh
db="$PWD/private-data/outfit-me.sqlite3"
python3 skills/outfit-me/scripts/store.py --db "$db" init
python3 skills/outfit-me/scripts/store.py --db "$db" list wardrobe
```

数据库未加密，不包含在发行清单中。不要把私人导出、照片、订单文件或浏览器会话加入版本控制。

## 安装

**当前没有发布任何 npm 包**，`npx outfit-me-agent` 现在会返回 404 并失败。请使用下面的本地方式；文档中的 npx 命令仅描述发布后的计划，不代表现在可用。

### 方式一：安装器（Skill + 购物 MCP，购物需再加载扩展）

先把本仓库克隆到本机，然后进入**要安装到的目标项目目录**执行：

```powershell
git clone https://github.com/Guitenbay/outfit-me.git $env:USERPROFILE\outfit-me
node $env:USERPROFILE\outfit-me\bin\setup.cjs setup --agent claude --scope project
```

macOS / Linux：

```sh
git clone https://github.com/Guitenbay/outfit-me.git ~/outfit-me
node ~/outfit-me/bin/setup.cjs setup --agent claude --scope project
```

先预览、不写任何文件：

```sh
node <本仓库路径>/bin/setup.cjs setup --dry-run
```

`setup` 会复制完整 Skill、把捆绑的购物 MCP 复制到持久用户目录、创建 Python 3.11+ venv 并安装其依赖、合并项目 `.mcp.json`，然后打印 Chrome 扩展的加载路径。需要 Node >=18、Python >=3.11 和网络。没有 npm postinstall，不自动登录、不启动浏览器、不创建数据库。遇到同名 Skill 或 MCP 项会询问，默认不覆盖；确认后保留备份。`--skill-only` 只安装 Skill。小红书与天气不在其中，仍需独立连接器和本机凭据。

### 方式二：只装 Skill（不用安装器）

把整个 `skills/outfit-me/` 目录复制到宿主的 Skills 位置，例如 Claude Code 项目的 `.claude/skills/outfit-me/`。不要只复制 `SKILL.md`，`references/`、`scripts/`、`schemas/`、`evals/` 要一起保留。手动复制不会改动宿主配置。

### 必须：加载 Chrome 扩展（搜索与加购的前提）

**不加载扩展，就不具备任何商品搜索或加购能力。** 扩展已包含在仓库中：`integrations/commerce-browser-mcp/chrome-extension/`（`manifest.json`、`popup.html`、`popup.js`、`service-worker.js`）。它让 MCP 使用你自己授权的标签页，不需要复制浏览器登录状态。

1. 先完成上面的安装器步骤；终端会打印持久化后的扩展目录，通常在 `~/.outfit-me/runtimes/commerce-<随机后缀>/component/chrome-extension/`。若只手动复制了 Skill，请直接使用仓库里的 `integrations/commerce-browser-mcp/chrome-extension/`。
2. Chrome 打开 `chrome://extensions`，右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择上面那个 `chrome-extension` 目录（要选到含 `manifest.json` 的那一层）。
4. 打开插件弹窗，填入安装器生成的端口（默认 `8765`）和令牌。令牌在本机 `.mcp.json` 和 `~/.outfit-me/runtimes/.../connection.json` 里，**不要发到聊天、不要提交到 Git**。
5. 在淘宝/天猫或京东的公开页面打开插件，点 **授权当前标签页**；两个平台需分别授权。
6. 遇到扫码、密码、验证码或风控验证，请在浏览器里自己完成，工具不会绕过。

扩展重载、后台休眠、关闭标签页或离开公开购物页面都会撤销授权，需要重新授权。详细能力边界见 `integrations/commerce-browser-mcp/README.md` 与 `SECURITY.md`。

- [安装说明（含手动 MCP 配置与故障处理）](docs/INSTALL.md)
- [产品定位、当前能力与路线图](docs/PRODUCT.md)
- [历史设计提案](docs/DESIGN.md)
- [来源与许可证边界](THIRD_PARTY_NOTICES.md)
- 数据与授权规则：`skills/outfit-me/references/`

**发布状态：** npm 包 `outfit-me-agent` 未发布、名称可用性未核实；`package.json` 与 `docs/SETUP.md` 只描述发布后的计划，不能据此执行 `npx`。仓库当前只保证从本地克隆运行。

## 发布安全与许可

发行校验针对未创建档案或安装依赖的干净源码目录。根目录 `.git/` 元数据被排除，不进入发行清单；真实 `private-data/`、虚拟环境和缓存会被严格校验拒绝。这表示该目录不能原样作为发行包，并不表示运行程序失败。发布时应重新整理干净目录，不要删除个人数据或 Git 历史来通过校验。

这是精确白名单导出，不是原工作区镜像。`release-manifest.json` 列出每个可发布文件及 SHA-256；校验器拒绝未列文件、符号链接、数据库/配置/缓存等常见私密路径和机器路径。启发式检查不能证明没有任何秘密，公开前仍须人工审阅。修改发行源码后需明确执行 `python -B scripts/release.py refresh` 并重新核验，不能用 refresh 接纳私有文件。

本项目采用 [MIT 许可证](LICENSE)。第三方派生组件保留其原始许可证和署名，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；根许可证不覆盖或移除这些来源义务。
