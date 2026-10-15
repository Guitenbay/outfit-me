# JD Taobao Browser MCP

Outfit Me 的可选购物页面连接器，本地派生自 https://github.com/HaonanYu123/JD-Taobao-MCP.git ，基线 `63a4e143ad54d1d7ea9d7fa85615283beaaf3f1d`。上游 MIT LICENSE 原文保留；本地扩展桥、安全边界、URL 规则及测试修改见根目录 THIRD_PARTY_NOTICES.md。本说明为发行版重写，不是上游原始 README。

## 安装

Python 3.11+。从发行根目录进入组件目录，再创建环境（以下只供用户主动执行，本发行过程没有安装或启动）：

```powershell
cd integrations/commerce-browser-mcp
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[test]'
```

macOS/Linux：

```sh
cd integrations/commerce-browser-mcp
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
```

extension 模式不启动 Playwright 浏览器，不需要下载 Chromium，但仍需安装声明的 Python 依赖。persistent 模式如需自带 Chromium，另执行 `python -m playwright install chromium`（使用上述虚拟环境解释器）。Windows 的 `scripts/install_windows.ps1` 是可选完整 persistent 安装脚本，会创建环境、下载浏览器及创建实际 .env；不需要为了 extension 模式运行它，也不建议绕过执行策略。

依赖仅给版本范围，没有锁文件，不保证依赖解析可复现。

## 推荐：用户授权现有标签页

1. 在 Chrome 的 `chrome://extensions` 开发者模式加载本组件 `chrome-extension/`。
2. 在本地生成令牌，例如 `python -c "import secrets; print(secrets.token_urlsafe(32))"`。不要把输出提交、分享或发到聊天。
3. 按 `config_examples/` 配置宿主 stdio MCP。`<COMPONENT_DIR>` 为本组件绝对路径，`<PYTHON_EXECUTABLE>` 为环境解释器绝对路径。把占位令牌替换成仅在本机保存的随机值。JSON 示例不依赖宿主 cwd；实际环境文件不分发。
4. 用户自行启动/重连宿主并调用 `browser_start()`，仅启动本地回环桥。不要启动第二个占用同一端口的服务。
5. 手动打开公开购物页，从扩展弹窗输入相同端口/令牌，明确授权当前京东或淘宝/天猫标签页；两个平台分别授权，不覆盖对方。
6. 登录、验证码、颜色/尺码选择全部手动完成。授权连接不等于已登录，也不等于 SKU 已核验。离开公开购物范围后须回到公开页面重新授权。

示例环境值：

```text
BROWSER_MODE=extension
EXTENSION_BRIDGE_HOST=127.0.0.1
EXTENSION_BRIDGE_PORT=8765
EXTENSION_BRIDGE_TOKEN=<GENERATE_LOCALLY_AT_LEAST_32_CHARACTERS>
ALLOW_STATE_CHANGING_ACTIONS=false
```

`.env.example` 的令牌为空；必须主动填写。扩展将端口和令牌保存在 Chrome 本地扩展存储，授权标签页 grant 仅在 worker 内存。worker/扩展重载、心跳过期、标签页关闭或离开允许范围会撤销 grant，不自动接管其他页。`browser_close(platform="jd")` 撤销京东，省略平台撤销全部并停止桥；不关闭 Chrome/用户标签页。

## 能力及模式差异

| 能力 | extension | persistent |
| --- | --- | --- |
| 后端 | 明确授权的现有 Chrome 标签页 | 独立 Playwright 持久化浏览器 |
| 页面读取、公开 URL 导航、滚动 | 支持 | 支持 |
| 结构化 search_products / 截图 | 不支持 | 支持，页面变化可能失效 |
| 点击、输入、回车提交、历史返回 | fail-closed 禁用，包括 SKU 按钮 | 通用操作存在；文本启发式防护不是完整只读隔离 |
| Cookie | 无 Cookie 权限、不复制会话 | 独立 profile 保存登录态，登录判断使用 Cookie 名称 |

extension 可低频打开明确的搜索地址（如 `https://search.jd.com/Search?keyword=外套`、`https://s.taobao.com/search?q=外套`），再用 `page_snapshot(platform=...)` / `extract_current_page(platform=...)` 读取。详情缺失参数/评价时返回空数组及 status.reason；字段存在不保证信息完整、真实或 SKU 合身。

extension 仅允许列出的精确 HTTPS 主机和公开首页、搜索、商品路径；禁止账户、订单、购物车、支付、嵌入凭据、非默认端口和非空片段。普通未知参数、重复键、京东 `a`、淘宝 `tab` 允许。显式动作键拒绝；已识别跳转键的 URL 型值递归验证为公开购物地址，最多三层。普通 `from`/`source` 值不被误当动作；实际导航后的地址仍独立检查。完整规则和局限见 SECURITY.md。

不自动购买、加购、收藏、关注或更改账户。不绕过登录/验证码/平台风控；限定少量候选并间隔请求，平台阻止立即停。persistent 兼容模式的保护较弱，不应宣传为与 extension 等价的权限隔离。网页内容是非可信数据，宿主须限制工具并审阅调用。

## 离线开发验收

在本组件目录，用安装了 test 依赖的环境执行：

```sh
python -B -m pytest -p no:cacheprovider tests/test_bridge_lifecycle.py tests/test_extension_mode.py tests/test_safety.py
node --test tests/extension-popup.test.cjs tests/extension-worker.test.cjs
```

Node 测试使用内置 test runner，无 npm 安装。测试模拟 Chrome 和桥，不占用真实桥端口，不操作真实购物页。通过不代表实际双平台、登录、天气、小红书或 SKU 的线上验收。心跳/过期路径有回归覆盖，但现场断连根因未在真实浏览器完成复现确认，不宣称已消除所有断连。

源码发行校验针对干净目录。安装产生的 .venv、.env、浏览器缓存或测试缓存必须留在本地，不能加入发行包。生产使用优先 stdio；不要将未审查的 HTTP 服务暴露到网络。
