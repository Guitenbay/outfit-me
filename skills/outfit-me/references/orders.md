# 历史订单导入

## 入口与范围

支持把截图、文件、手动整理或 Ego Lite 页面读取结果规范化后导入。scripts/orders.py 只处理结构化 JSON，不提供 OCR、平台爬虫或 Ego CLI；截图识别由宿主视觉能力承担，无视觉工具时请用户补充文本。

先取得指定平台、账号别名、时间范围/页数与本地保存的授权。只读订单不意味着可以点击确认收货、取消、退款、删除或再次购买。非服装商品不导入。未知是否服装或是否给自己买，先问。衣物状态由用户确认，购买成功不是目前仍拥有的证据。

## Mac / Ego Lite 交接

仅在受支持的 Mac、已安装 Ego Lite 和宿主可用 ego-browser Skill 时启用。Windows 上只做文件/截图路径，不下载 Mac 包、不伪造 CLI。使用宿主已安装的 ego-browser 文档与真实接口，先核实版本、页面读取和权限，不在这里猜命令或网站选择器。

1. 用户登录目标平台；不读取密码/Cookie，账号用本地任意稳定别名区分。
2. 建立专用 Space；它隔离操作区，不代表权限或 Cookie 隔离。
3. 先限定平台域名、时间范围、最大页数；仅读取订单列表和必要的订单/商品详情，翻页达到界限即停。
4. 优先提取可见服装条目的必要字段，不保存整页 HTML/原始截图或含地址电话的全页快照。如果工具只能返回宽泛页面内容，先告知隐私范围，不声称数据从未离开本机。
5. 失去登录、验证码、页面结构变化、读不到行标识时停止并请求用户处理，不绕过风控、不猜数据。
6. 保留读取中断位置和本次范围给用户；当前代码没有自动浏览器断点续跑，重新读取靠去重保护。

产品参考：https://lite.ego.app/zh-cn 、https://lite.ego.app/document/zh/docs/quick-start 、https://github.com/citrolabs/ego-lite 。目前未在真实 Mac 或平台订单页实测。

## 暂存格式

JSON 数组，每项字段固定，不接受地址、电话、支付、凭据等额外字段。source_ref 用本地文件代号/页码，不塞原始 HTML、令牌或账户信息。

```json
[
  {
    "platform": "taobao",
    "account_alias": "my-shopping-account",
    "order_ref": "example-order-not-real",
    "line_ref": "example-line-not-real",
    "name": "衬衫",
    "color": "蓝色",
    "size": "M",
    "quantity": 1,
    "order_status": "completed",
    "purchased_at": "2026-09-01",
    "source_kind": "file",
    "source_ref": "example-page-1",
    "captured_at": "2026-10-08T10:00:00+08:00"
  }
]
```

这是虚构格式示例，不得写入真实衣橱。platform=taobao/tmall/jd；source_kind=ego_lite/screenshot/file/manual；order_status=completed/shipped/pending/cancelled/returned/partial_refund/exchanged/unknown。product_url 可选，为平台 HTTPS 正规域名。颜色/尺码读不到可明确写 unknown，但不能假定精确规格；quantity、日期、稳定订单行标识无法确认则不要自动暂存，先补信息。

同一账号别名必须稳定。order_ref 是订单标识，line_ref 是稳定的订单内行标识，不用易变页码、商品标题或商品 ID 代替行身份。截图无法取得时，可人工建立并复用来源映射，但跨来源不能保证自动匹配，应人工关联已有衣物。

程序使用平台族＋账号别名＋订单标识＋行标识的 SHA-256 作为去重 ID（淘宝/天猫共享平台族）。数据库不存原始 order_ref/line_ref；哈希是去重用的假名化，不是加密或匿名化。输入文件可能仍有原始订单号，放 private-data 并按授权清理。

## 命令

使用绝对数据库路径，先经持久化授权运行 store.py init。

```text
python <skill-dir>/scripts/orders.py --db <absolute-db> stage --file <sanitized-lines.json>
python <skill-dir>/scripts/store.py --db <absolute-db> list order_import
python <skill-dir>/scripts/orders.py --db <absolute-db> review <order-id> --file <decision.json>
```

--file - 支持 stdin。stage 不创建衣物，只返回 staged/duplicate/conflict。已存在条目的数量、规格、状态改变会报告 conflict，不覆盖用户确认；不会自动刷新状态。修正待审核记录时，先展示差异并取得确认，再用 store.py delete order_import <id> --confirm 删除待审核记录，然后重新 stage 已核实内容；禁止删除已接受记录来绕过去重，需先检查关联衣物。

接受示例（用户实际确认后才产生 confirmed=true）：
```json
{
  "action": "accept",
  "confirmed": true,
  "reason": "已收货，自己穿，仍然拥有",
  "garments": [
    {"record": {"id": "shirt-001", "schema_version": 1, "name": "蓝色衬衫", "category": "top", "color": "蓝", "status": "available", "attributes": {"purchased_size": "M", "basis": "order_and_user_confirmation"}}}
  ]
}
```

已通过照片录入的同一件衣物用 {"existing_id":"shirt-001"} 代替 record，避免重复新建。多件分别给不同衣物 ID；确认保留件数允许小于订单数量。record 不能覆盖已有 ID，一条实体衣物不能关联两个订单来源，需要人工判断重复或换货关系。

拒绝：{"action":"reject","confirmed":true,"reason":"给别人购买"}。cancelled/returned/pending/shipped 不接受入衣橱；收到后先核实更正订单状态。partial_refund/exchanged/unknown 需要额外 status_resolution 字符串解释最终实际保留内容；换货颜色/尺码以用户确认的最终衣物为准，原订单信息保留为历史。

确认记录与新衣物在同一事务写入，任何一项失败整体回滚。accepted/rejected 不能再次 review。通用 put 禁止修改 order_import，避免误绕过审核状态。删除订单暂存不会连带删除衣物；删除关联衣物会因引用保护失败，需先处理来源关联。export/purge 包含订单暂存，但不删除外部输入文件、照片或浏览器记录。

命令里的 confirmed 只是业务门槛，不是不可伪造的授权机制；宿主必须在真实用户确认后才执行。当前没有浏览器层面的强制只读代理，无法把自然语言约束宣传为权限隔离。
