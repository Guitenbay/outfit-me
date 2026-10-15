# 来源与第三方边界

## 核心

`skills/outfit-me/` 与核心测试来自本地 Outfit Me 工作区的精确允许文件清单。设计文档称其参考 wardrobe、fashion-skill 的流程思想而未复制这些项目的代码/提示词；发行审阅没有独立证明全部内容的原创性。参考源码及本地研究页面没有分发；无法从当前允许文件确认这些项目的精确版本或完整来源，故不虚构仓库归属。根项目采用 MIT 许可证，见根目录 LICENSE；第三方原始署名与许可仍须保留。

## 可选 commerce 组件

如发行清单包含 `integrations/commerce-browser-mcp/`，该目录为独立上游派生组件，而非核心原创代码。

- 上游：https://github.com/HaonanYu123/JD-Taobao-MCP.git
- 已识别上游基线：`63a4e143ad54d1d7ea9d7fa85615283beaaf3f1d`
- 上游许可：MIT，copyright 2026；必须保留该组件 LICENSE 原文和其中署名。根项目的 MIT 许可证不移除该组件原始许可与署名。
- 本地修改包括授权标签页/Chrome 扩展桥接、只读安全边界、商品页面提取及链接规则、安装/安全说明与离线测试；这是本地派生版本，不声称由上游作者批准，也不把本地修改冒称上游发布版本。
- 不捆绑虚拟环境、依赖安装产物、浏览器会话、令牌、实际环境文件或上游 Git 历史。没有锁文件，不保证依赖解析可复现。

## 仅引用，不分发

- QWeather 社区连接器：https://github.com/overstarry/qweather-mcp ，官方配置文档 https://dev.qweather.com/docs/configuration/ 。
- 小红书社区连接器：https://github.com/xpzouying/xiaohongshu-mcp 。
- 历史候选：https://github.com/JeremyDong22/taobao_mcp 、https://github.com/abc354402600/JD-Shopping-MCP 。
- 可选订单读取交接的产品文档：https://lite.ego.app/zh-cn 、https://github.com/citrolabs/ego-lite 。没有捆绑 Ego Lite 或自动订单读取适配器。

引用不是官方背书、安全审计、许可核验或连通保证。以上外部连接器、参考仓库及其二进制文件未包含在本发行版；要安装时须独立审阅选定版本的许可证与条款。
