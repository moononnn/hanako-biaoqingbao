# 对外索引（public-index.json）

图库对外的只读快照，供别的消费者（比如聊天类 App）读取。**挑选权在消费方**：这份文件只摊平事实，不做评分、不做选择。

- 位置：`<HANA_HOME>/plugin-data/biaoqingbao/public-index.json`
- 刷新：插件启动时重建；图库、分组白名单、偏好、最近发送有任何变动后去抖刷新（约 2 秒合并一次）。读到的可能是几秒前的快照，这对消费方足够。
- 当前版本：`schemaVersion: 1`。读之前先检查它，不认识就别解析 `data` 以外的字段。

## 形状

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-13T00:00:00.000Z",
  "stickerCount": 293,
  "stickers": [
    {
      "id": "stk_002",
      "file": "stickers/stk_002.jpg",
      "emotion": ["委屈"],
      "scene": ["被忽视"],
      "keywords": ["猫", "委屈", "撒娇"],
      "description": "委屈的猫，被主人忽视了"
    }
  ],
  "partners": {
    "hanako": {
      "configured": true,
      "allowed": ["stk_002", "stk_007"],
      "preferred": ["stk_007"],
      "vetoed": ["stk_012"],
      "recent": ["stk_007", "stk_021"]
    }
  }
}
```

## 字段

### `stickers[]`

| 字段 | 说明 |
| --- | --- |
| `id` | 表情包 id，消费方回传反馈时用这个 |
| `file` | **相对数据目录的路径**，用正斜杠。真实路径 = `<数据目录>/<file>` |
| `emotion` / `scene` / `keywords` | 识图或人工打上的标签。`emotion` 是情绪词（可能很多很细），`scene` 是场景，`keywords` 是自由词 |
| `description` | 一句话画面描述，截断到 80 字 |

### `partners{}`

按 agent id（伙伴 id）索引。**伙伴不在这份表里时，表示没有白名单、没有偏好、没有发送记录——消费方按全集处理即可。**

| 字段 | 说明 |
| --- | --- |
| `configured` | 是否配过分组白名单。`false` 表示 `allowed` 就是全集 |
| `allowed` | 该伙伴**可发**的图 id（白名单、未分组规则都已算完）。消费方只需要在这份名单里挑 |
| `preferred` | 被明确偏爱过的图 id（已剔除 `vetoed`，也已剔除不在 `allowed` 里的） |
| `vetoed` | 被明确否掉的图 id。**消费方不要再发这些** |
| `recent` | 最近发过的图 id，新的在前，最多 60 条，已去重。用于避免短时间内重复 |

## 消费方该怎么做

1. 读文件、检查 `schemaVersion`。
2. 取 `partners[自己这边的伙伴 id]`；没有就用全集。
3. 从 `allowed` 里排掉 `vetoed`，再避开 `recent` 前几条。
4. 挑图、控制频率、渲染：都是消费方自己的事。
5. 文件不存在、解析失败、库为空：**静默降级**，不要报错给用户。

## 边界

- 这份快照**不会发布到互联网**，只存在于本机数据目录里。
- 它**不包含**任何路径穿越风险：`file` 始终是数据目录下的相对路径。
- 它**不包含**用户的原始反馈记录、会话内容或任何隐私字段。
- 消费方**不应写入**这份文件，也不应依赖其中的字段顺序。
