# 安装与验收

## 安装器（本地运行，非 npm）

**npm 包 `outfit-me-agent` 未发布**，注册表返回 404，`npx outfit-me-agent` 现在不可用。正确做法是克隆仓库后本地执行：

```powershell
git clone https://github.com/Guitenbay/outfit-me.git $env:USERPROFILE\outfit-me
Set-Location <你的目标项目目录>
node $env:USERPROFILE\outfit-me\bin\setup.cjs setup --agent claude --scope project
```

macOS / Linux 用 `node ~/outfit-me/bin/setup.cjs setup --agent claude --scope project`。必须先在目标项目目录，否则会装到当前目录。Node >=18、Python >=3.11；执行 setup 会下载捆绑购物 MCP 的 Python 依赖、创建持久用户 runtime，并合并项目 `.mcp.json`。Chrome 扩展加载、令牌配对、宿主批准与账号授权仍需人工完成。小红书/天气仍需独立可信连接器和本机凭据，不宣称一键全部可用。`--dry-run` 无写入/子进程；`--skill-only` 不安装 MCP。完整说明与发布计划见 [SETUP.md](SETUP.md)。

## 手动核心安装

Python 3.10+。先进入解压/克隆后的发行根目录，再运行 README 的测试命令。测试从自身文件位置寻找 Skill，不依赖原开发工作区。macOS/Linux 可将 `python` 替换为 `python3`。

宿主安装：完整复制 `skills/outfit-me/`，保持 references/scripts/schemas/evals 的相对布局。例如使用支持项目 Skills 的 Claude Code 时，目标为你选择项目的 `.claude/skills/outfit-me/`。复制前确认目标无同名内容；不要覆盖已有个人定制。其他宿主按其 Skills 文档配置。手动复制本身不会改宿主配置，也没有模型 API 依赖；只有主动运行 setup 的完整 Claude 项目模式才会合并 MCP 配置。

数据库选目标项目的 `private-data/outfit-me.sqlite3`，实际调用显式传入绝对路径；别把个人数据放进安装的 Skill 目录。持久化必须获得用户同意。可先只运行测试和 `--help`，不创建真实档案。

## 购物连接器（需扩展）与外部连接器

Skill 完整的体验依赖三个 MCP 服务，其中购物连接器由本仓库内置，外部天气与灵感服务需独立配置：

1. **购物 MCP (`outfit-me-commerce`)**：本仓库内置于 `integrations/commerce-browser-mcp/`，默认 `BROWSER_MODE=extension`，**必须加载扩展并授权标签页才能搜索商品、读取详情或加购**；未加载扩展时购物功能不可用（衣橱与搭配不受影响）。安装与授权见其目录 README.md 与 SECURITY.md。
2. **天气 MCP (`qweather`)**：开源项目 [overstarry/qweather-mcp](https://github.com/overstarry/qweather-mcp)，官方配置文档与 API Key 申请参见 [和风天气开发平台](https://dev.qweather.com/docs/configuration/)。
3. **穿搭灵感 MCP (`xiaohongshu`)**：开源项目 [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)。

工具连接失败不代表未配置，不能声称查询成功；接受用户文字/截图并降级即可。`scripts/release.py` 支持精确允许文件清单导入，用于后续人工审阅后的发行整理，不会复制完整工作区。

## MCP 配置示例

`config_examples/mcp-client.json` 是**空能力的安全模板**，不是实际配置或已经启动的服务。核心没有 MCP server 入口，因此不能把 store.py 填成 MCP command。购物 MCP 加入后，按其真实 stdio 或 HTTP 接口创建你自己的宿主配置；使用发行目录的绝对路径和平台适用解释器，尤其当宿主工作目录与仓库目录不一致时。

令牌仅在你本机生成并填入被忽略的实际配置，不发到聊天、提交 Git 或放进 README。不要从开发者机器复制实际 `.mcp.json` 或 `.env`。示例默认不授予任何写工具权限；宿主应显式限制工具。若用户另行启用受控加购，只开放专用准备／确认／状态工具，由 Agent 宿主原生表单对具体商品规格和数量逐次确认后直接操作网页，扩展弹窗仅为替代入口；不开放通用点击、下单、结算或支付。安装不等于授权登录或授权具体商品加购，登录和验证码由用户本人完成。

## 发行验收

```sh
python -B -m unittest discover -s tests -v
python -B scripts/release.py verify
```

核心测试和发行校验离线运行，不证明模型行为或平台实时可用。购物组件另有自身离线测试；首次真实使用前，限定平台、页数/候选数和时间范围，经用户授权单独验收。平台风控、验证码或权限不足立即停止，不重试绕过。

`release.py refresh` 仅为明确允许的发行源码重新计算摘要。任何未列文件、符号链接或禁止路径都会阻止刷新。项目已采用 MIT 许可证；公开前仍须人工审阅，并决定是否接受未锁依赖的可重复性限制。发行校验工具不初始化 Git、不提交、不推送、不发布。
