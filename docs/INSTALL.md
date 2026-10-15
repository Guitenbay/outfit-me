# 安装与验收

## 核心

Python 3.10+。先进入解压/克隆后的发行根目录，再运行 README 的测试命令。测试从自身文件位置寻找 Skill，不依赖原开发工作区。macOS/Linux 可将 `python` 替换为 `python3`。

宿主安装：完整复制 `skills/outfit-me/`，保持 references/scripts/schemas/evals 的相对布局。例如使用支持项目 Skills 的 Claude Code 时，目标为你选择项目的 `.claude/skills/outfit-me/`。复制前确认目标无同名内容；不要覆盖已有个人定制。其他宿主按其 Skills 文档配置。此项目不会自动改宿主配置，也没有模型 API 依赖。

数据库选目标项目的 `private-data/outfit-me.sqlite3`，实际调用显式传入绝对路径；别把个人数据放进安装的 Skill 目录。持久化必须获得用户同意。可先只运行测试和 `--help`，不创建真实档案。

## 可选连接器

核心不依赖任何 MCP。小红书和天气服务不捆绑；请独立核实其来源、许可证、版本、真实工具 schema、凭据处理和限额。工具连接失败不代表未配置，不能声称查询成功；接受用户文字/截图并降级即可。

本发行目录已包含可选 `integrations/commerce-browser-mcp/` 源码、Chrome 扩展及其离线测试，保留独立 MIT LICENSE 与来源声明。安装与双平台授权步骤见该目录 README.md 和 SECURITY.md。它不会随核心自动启动；小红书和天气连接器仍需独立安装。`scripts/release.py` 支持精确允许文件清单导入，用于后续人工审阅后的发行整理，不会复制完整工作区。

## MCP 配置示例

`config_examples/mcp-client.json` 是**空能力的安全模板**，不是实际配置或已经启动的服务。核心没有 MCP server 入口，因此不能把 store.py 填成 MCP command。可选组件加入后，按其真实 stdio 或 HTTP 接口创建你自己的宿主配置；使用发行目录的绝对路径和平台适用解释器，尤其当宿主工作目录与仓库目录不一致时。

令牌仅在你本机生成并填入被忽略的实际配置，不发到聊天、提交 Git 或放进 README。不要从开发者机器复制实际 `.mcp.json` 或 `.env`。示例不授予任何写工具权限；宿主仍应显式限为只读工具。安装不等于授权登录，登录和验证码由用户本人完成。

## 发行验收

```sh
python -B -m unittest discover -s tests -v
python -B scripts/release.py verify
```

核心测试和发行校验离线运行，不证明模型行为或平台实时可用。可选组件另有自身离线测试；首次真实使用前，限定平台、页数/候选数和时间范围，经用户授权单独验收。平台风控、验证码或权限不足立即停止，不重试绕过。

`release.py refresh` 仅为明确允许的发行源码重新计算摘要。任何未列文件、符号链接或禁止路径都会阻止刷新。项目已采用 MIT 许可证；公开前仍须人工审阅，并决定是否接受未锁依赖的可重复性限制。发行校验工具不初始化 Git、不提交、不推送、不发布。
