# 本地数据操作

Python 3.10+，无需 pip 安装。相对脚本路径从本 Skill 所在位置解析，数据库始终用项目 private-data 下的绝对路径。以下用占位符，执行前替换，不照抄路径。

```text
python <skill-dir>/scripts/store.py --db <absolute-db-path> init
python <skill-dir>/scripts/store.py --db <absolute-db-path> put profile --file <private-json-file>
python <skill-dir>/scripts/store.py --db <absolute-db-path> list wardrobe
python <skill-dir>/scripts/store.py --db <absolute-db-path> get wardrobe shirt-001
python <skill-dir>/scripts/store.py --db <absolute-db-path> export --output <new-private-export-path>
python <skill-dir>/scripts/store.py --db <absolute-db-path> delete wardrobe shirt-001 --confirm
python <skill-dir>/scripts/store.py --db <absolute-db-path> purge --confirm DELETE_ALL_RECORDS
```

put 是同 kind/id 的完整替换，不是局部 patch：更新前 get，再合并用户修改，不丢弃原字段。CLI 会设置 updated_at。导出仅创建新文件，拒绝覆盖。init 可重复调用，不清空数据。list/get 在数据库不存在时失败，不自动创建。--file - 从标准输入读取；尽量避免把私人数据写进 shell 参数和历史。临时 JSON 也放 private-data，处理后按授权清理。

记录格式：所有记录有 schema_version=1 和 ASCII id（字母数字开头，可用连字符/下划线，最长 80）。

- profile：name 必填；city/timezone 可选；preferences/constraints 为字符串数组；budget={amount,currency}；claims 为 {name,value,basis,confidence} 数组。
- wardrobe：name、category、color、status 必填；attributes 对象；image_path 可选。category=top/bottom/one_piece/outerwear/shoes/accessory，status=available/laundry/unavailable/retired。
- candidate：name、platform、url、verification、fetched_at、source 必填。platform=taobao/tmall/jd/other；verification=search_result/detail_verified/sku_verified。有 price 时必须有 currency 和 price_conditions。detail_verified 需非空 details；sku_verified 额外需 sku={id,color,size,stock,source}，stock 必须明确 available/out_of_stock。
- outfit：name、occasion、date、reason、garment_ids 必填；evidence_ids 可选。仅引用已录入且 available 衣物。date=YYYY-MM-DD。
- feedback：outfit_id、date、notes 必填；comfort 可选。
- evidence：type=weather/trend/product，url、fetched_at、source、非空 data 必填。weather 额外需 forecast_for 带时区时间戳和 data.location/data.timezone。

示例（仅说明格式，不能作为用户真实档案保存）：
```json
{"schema_version":1,"id":"shirt-001","name":"白色衬衫","category":"top","color":"白","status":"available","attributes":{"material":{"value":"棉","basis":"user_confirmed"}}}
```

fetched_at/forecast_for 使用 ISO 8601 带时区，例如 2026-10-08T09:00:00+08:00。URL 必须 HTTPS 且无嵌入账号密码；淘宝/天猫/京东候选要求与平台相符的正规域名，先解析短链接再存，不猜重定向。此校验不联网，也不认证店铺/商品真伪。

SQLite 事务防止半写和引用丢失，但不能检测模型捏造、过期内容、所有隐藏敏感数据或多人完整替换造成的业务覆盖。本版按单用户顺序编辑；需要多用户时另加版本冲突检测。JSON Schema 描述公共交换结构，完整规则以 store.py 为准。
