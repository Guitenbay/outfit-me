# Outfit Me

本地优先的 Agent 个人衣橱、搭配与有据可查的整套选购助手。已有衣物优先，购物只补缺口；不是独立电商网站、通用爬虫或自动下单工具。

## 目前能做什么

- 可移植 Skill：建档、衣橱整理、场合/天气约束搭配、风格探索、选购与反馈流程。
- Python 标准库 SQLite CLI：七类记录、结构/引用校验、事务、导出与删除。
- 结构化订单暂存、去重和用户确认入衣橱；**不包含 OCR 或订单页自动读取**。
- 已附可选购物 MCP 与 Chrome 授权标签页扩展源码，支持京东、淘宝/天猫独立授权、默认只读浏览与详情提取。淘宝/天猫可另行启用在 Agent 内原生确认后直接操作网页的受控加购，扩展弹窗是可选替代，不开放通用点击、下单、结算或支付；受控加购支持旧版与已观测新版商品控件，已做隔离真实浏览器 DOM 测试，实际加购结果仍需现场验证，无法识别的页面拒绝执行；不保证平台持续可用或所有 SKU 字段完整。
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

## 安装与可选连接器

推荐使用 [npm/npx 安装说明](docs/SETUP.md)。包名暂定 `outfit-me-agent`，尚未核实可用性或发布；维护者发布后，在目标项目目录一行执行：

```sh
npx outfit-me-agent setup --agent claude --scope project
```

主动运行 setup 会安装完整 Skill、把捆绑购物 MCP 复制到持久用户目录、创建 Python 3.11+ venv 并下载其依赖、合并项目 `.mcp.json`；随后引导手动加载 Chrome 扩展和授权标签页。需要 Node >=18、Python >=3.11 和安装网络；没有 npm postinstall，不自动登录、启动浏览器或创建数据库。已有 Skill/MCP 项默认提示不覆盖，明确同意后保留备份。先用 `--dry-run` 可无写入预览，`--skill-only` 可只安装 Skill。小红书与天气仍需独立可信连接器/本机凭据，不能把安装完成称为全部服务就绪。

也可手动将整个 `skills/outfit-me/` 交给支持 Skills 的宿主，不要只复制入口。手动安装与可选 MCP 配置见 [安装说明](docs/INSTALL.md)。

- [产品定位、当前能力与路线图](docs/PRODUCT.md)
- [历史设计提案](docs/DESIGN.md)
- [来源与许可证边界](THIRD_PARTY_NOTICES.md)
- 数据与授权规则：`skills/outfit-me/references/`

## 发布安全与许可

发行校验针对未创建档案或安装依赖的干净源码目录。根目录 `.git/` 元数据被排除，不进入发行清单；真实 `private-data/`、虚拟环境和缓存会被严格校验拒绝。这表示该目录不能原样作为发行包，并不表示运行程序失败。发布时应重新整理干净目录，不要删除个人数据或 Git 历史来通过校验。

这是精确白名单导出，不是原工作区镜像。`release-manifest.json` 列出每个可发布文件及 SHA-256；校验器拒绝未列文件、符号链接、数据库/配置/缓存等常见私密路径和机器路径。启发式检查不能证明没有任何秘密，公开前仍须人工审阅。修改发行源码后需明确执行 `python -B scripts/release.py refresh` 并重新核验，不能用 refresh 接纳私有文件。

本项目采用 [MIT 许可证](LICENSE)。第三方派生组件保留其原始许可证和署名，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；根许可证不覆盖或移除这些来源义务。
