# npm / npx 安装

## 发布状态与一行命令

包名暂定 `outfit-me-agent`，**尚未核实 npm 名称可用性，也不表示已发布**。维护者审核并发布该名称后，进入要安装的项目目录运行：

```sh
npx outfit-me-agent setup --agent claude --scope project
```

默认命令也可省略 `setup` 和两个默认选项。Node.js >=18；自动购物 MCP 安装需要 Python >=3.11（含 venv/pip）、网络/PyPI 和 Chrome。CLI 本身没有 npm 依赖，没有 postinstall；npx 会下载此包，主动执行 setup 则授权下载 Python 依赖、创建本地环境和修改项目 MCP 配置。Python 依赖只有版本范围，尚未锁定，不保证可重复解析。

未发布时，在本源码目录用 `node bin/setup.cjs --help` 查看帮助。实际安装请在目标项目目录用 `node <SOURCE_DIR>/bin/setup.cjs setup`，否则会安装到当前源码项目。可先用 `--dry-run`，它不写文件、不生成令牌、不执行 Python/安装子进程，也不会验证实际 Python/网络可用性。

## 实际安装范围

| 内容 | 默认 Claude 项目安装 | 仍需用户完成 |
| --- | --- | --- |
| 完整 Outfit Me Skill | `.claude/skills/outfit-me/` | 重启或重新发现 Skill |
| 已审核、捆绑的京东/淘宝购物 MCP | 持久源码、独立 Python venv、声明依赖、项目 `.mcp.json` 合并 | 宿主批准、Chrome 扩展加载、令牌配对、分别授权标签页 |
| 小红书参考/灵感工作流 | **未捆绑、未自动安装或配置** | 审阅独立连接器来源、许可证、版本、工具 schema；按其文档启动本地服务、本人完成登录，再注册到宿主 |
| QWeather / 天气 | **未安装或配置凭据** | 自行申请服务凭据并仅在本机配置可信连接器，验证真实工具调用与限额 |
| 数据库、模型、账号与浏览器 | 不创建数据库、不改模型、不登录、不启动浏览器 | 持久化另获同意，登录/验证码/SKU 选择人工完成 |

安装完成不等于购物桥已连接，更不等于小红书/天气可用。没有小红书时不能声称已分析线上参考内容；让用户提供链接、文字或截图。没有天气服务时明确未知，接受用户提供的天气。遇到连接失败需报告失败，而不是认定未配置或伪造查询结果。

## 持久目录、配置与令牌

购物源码和扩展复制到 `~/.outfit-me/runtimes/commerce-<随机后缀>/component/`，venv 位于同级 `venv/`；不会引用 npx 临时缓存。每次完整安装使用独立 runtime，避免替换其他项目正在使用的服务。成功重装后旧 runtime 不自动删除；确认没有其他配置或 Chrome 扩展引用后再自行清理。

CLI 探测 Python 版本，可用 `--python <EXECUTABLE>` 指定；然后创建 venv，pip 安装捆绑组件及其声明的依赖，并验证三个依赖 import。extension 模式不下载 Chromium，不执行 Playwright 浏览器安装。测试不代表真实 PyPI 安装或在线购物验收。

项目 `.mcp.json` 只新增/替换 `mcpServers.outfit-me-commerce`，保留其他服务器和顶层键。入口使用绝对 venv 解释器、`-B` 和绝对 `server.py`。强制设置 `BROWSER_MODE=extension`、回环地址、端口 8765、随机令牌、`PYTHON_DOTENV_DISABLED=1` 和 `ALLOW_STATE_CHANGING_ACTIONS=false`；profile/artifacts 使用 runtime 下绝对路径。

令牌只存在本机 `.mcp.json` 和 runtime 的 `connection.json`，不输出到终端。POSIX 文件权限为 0600、runtime 0700；Windows 使用当前用户目录继承的 ACL，未宣称自动设置专属 ACL，用户应核实目录权限。**不要提交 `.mcp.json`、其备份、connection.json 或 runtime；不要将令牌发到聊天。** 如果项目尚未忽略这些实际配置，请自行设置版本控制排除。安装器不扫描或公开用户配置。

## Chrome 扩展手动引导

1. 完成安装后按终端输出找到持久的 `component/chrome-extension/`。
2. Chrome 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选择上述目录。
3. 自己打开输出指向的私有 `connection.json`；把端口与令牌填到扩展弹窗，勿分享文件或内容。
4. 重启 Claude Code，审阅并批准该项目 MCP；调用 `browser_start()` 启动本地回环桥，端口 8765 必须空闲，勿重复启动多个桥。
5. 本人打开公开京东与淘宝/天猫页面，从扩展分别授权当前标签页。授权不等于登录，登录/验证码与颜色尺码选择均手动完成。
6. 扩展/worker 重载、关闭标签页、授权过期或离开公开购物范围可能撤销授权，需重新授权。遇平台风控立即停止。

扩展模式只读且功能少于 persistent 模式（例如不支持结构化 search_products/截图、点击/输入）。见捆绑组件 README 与 SECURITY.md；安装器不自动放宽保护。

## 覆盖、备份与恢复

同名 Skill 或已有 `outfit-me-commerce` 项冲突时，交互提示默认 **No**；取消无写入。非交互遇冲突失败，必须显式使用 `--overwrite` 或 `--yes` 才同意替换。没有 `--force`。文件、符号链接、Windows junction 和不安全祖先路径不可覆盖。

先暂存文件与完成依赖安装，再发布 Skill 和配置。已有 Skill 和配置改动前分别保留 `.backup-<随机标识>`；配置仅新增服务器时也备份原配置。失败尽力删除本次创建内容并恢复原件；操作系统阻止回滚或检测并发修改时会报错并指明需人工恢复，不会假报成功。不要并发修改安装目录或 MCP 文件；这不是防御恶意本机进程的沙箱。pip 外部缓存/网络副作用不属于文件事务。

恢复时停止相关宿主，检查备份内容后手动移回原位置；只有确认不再被任何配置引用，才清理新 runtime。备份可能含私人配置与凭据，不能提交或分享。

## 其他宿主与范围

```sh
npx outfit-me-agent setup --agent claude --scope user --skill-only
npx outfit-me-agent setup --agent codex --scope project --skill-only
npx outfit-me-agent setup --agent codex --scope user --skill-only
npx outfit-me-agent setup --target ./custom-skills
```

`--target` 是 Skill 的**父目录**，最终追加 `outfit-me`；自动成为 skill-only，不能与 `--agent`/`--scope` 组合，不接受 `..` 路径穿越。支持绝对路径、当前目录相对路径及 `~/`。

已核实常规路径：Claude 项目 `.claude/skills`、用户 `~/.claude/skills`；Codex 项目 `.agents/skills`、用户 `~/.agents/skills`。当前 Codex 文档未列 `~/.codex/skills`，因此不采用该路径。参考 [Claude Skills](https://code.claude.com/docs/en/skills)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)。自动 MCP 配置当前**仅支持 Claude project**；其他组合没有 `--skill-only` 将明确失败，不猜测或文本拼接修改 TOML。Claude 项目 MCP 首次启动仍需用户批准；用户 MCP 配置位置是 `~/.claude.json` 而非 settings，本安装器不修改它。Claude MCP 格式参考 [官方 MCP 文档](https://code.claude.com/docs/en/mcp)。Codex 的 `codex mcp add` 注册是用户级配置（`~/.codex/config.toml`），不应冒充项目级自动安装。

其他宿主需按其官方 MCP 注册命令/配置格式手动配置稳定的服务路径，勿引用 npx 缓存；可按 `docs/INSTALL.md` 和组件 README 自行安装购物组件。Claude 用户级注册可参考官方 `claude mcp add --help`，Codex 可参考 `codex mcp add --help`，审阅作用域和环境变量后操作；本安装器不代写用户级配置。外部小红书端点须按经过审阅的连接器文档在本机启动，审阅宿主 HTTP/SSE 支持与鉴权，再注册回环地址；不要盲目使用公网端点或下载未经审核的实现。QWeather 凭据只存本机，不在命令示例、README 或聊天中填写真实秘密。

## 维护验收（不发布）

```sh
node --test tests/setup.test.cjs
npm pack --dry-run --json --ignore-scripts
python -B -m unittest discover -s tests -v
```

根 `.gitattributes` 使用 `* text=auto eol=lf` 固定 Git checkout 文本换行，避免 Windows CRLF 改写导致按字节计算的发行清单失配。

Node 测试用临时目录及注入的 Python 子进程模拟验证完整安装/失败回滚，不下载依赖、不修改真实用户配置。CLI 子进程 smoke 真实执行 help/dry-run/skill-only。维护者另将 tarball 输出到系统临时目录解包执行入口，不应在发行源码目录遗留 `.tgz`。Python 发行清单更新由维护者审阅后执行，npm 包只允许 CLI、Skill、Node 测试、必要文档/许可证及购物组件所需源码/扩展，不带真实配置、数据库、venv、Git 元数据或开发缓存。
