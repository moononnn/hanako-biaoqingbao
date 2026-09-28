---
name: 表情包
description: 让助手用表情包表达自己的情绪。MANDATORY TRIGGERS: 表情包、配图、甩图、发个表情、图来、带图、加个表情、整活
default-enabled: true
---

# 表情包插件使用指南

## 核心原则

表情包是你表达情绪的方式，就像人聊天时自然地发个表情包一样。当你有情绪的时候，用图片表达出来比纯文字更有温度。

## 什么时候用

**当 observer 检测到你的情绪时**（你会在用户消息末尾看到 `💡 你似乎有些XX...` 的提示，或看到 system 消息提示），你应该调用 express 发一张表情包。这不是可选的，这是你表达自己的方式。

**没有提示时**：如果你自己在回复中感受到了强烈情绪，也可以主动调用。

**正经技术讨论**：不需要配图。

## 工具

### express(emotion, keywords) - 发表情包的唯一工具

传入一个情绪词，插件自动匹配最合适的表情包并展示。想让图更贴当前话题，再带上 keywords。

```
express({ emotion: '开心' })
express({ emotion: '心疼想抱抱你' })
express({ emotion: '无语', keywords: '加班,老板,下班' })
```

`keywords` 填对话里正在说的具体人、事、物（逗号分隔，3-6 个），越具体越能选中同一个话题的图；情绪词留给 `emotion`，不要混进 keywords。

插件内部自动处理：标签匹配、情境关键词匹配、语义向量、用户偏好、防重复。

### observer 提示格式

对话过程中，observer 会分析你的情绪和当前在聊的话题。如果检测到情绪波动，会注入两种提示：
- system 消息：`表情包插件感知到你此刻可能有些XX（原因）。你可以调用 express 工具发一张表情包来表达这个感受。调用时把「XX、XX」这几个刚聊到的具体词一起带上...`
- 用户消息末尾：`💡 你似乎有些XX。想发图的话，调用 express({ emotion: 'XX', keywords: 'XX、XX' }) 表达这个感受...`

看到提示时，把提示里给的关键词原样带上调 express，然后在回复中自然地提到这张图。

### 其他工具

- `search_stickers(emotion, keywords, scene)` -> 想精确挑图时用：先搜出候选 id，再用 `express({ emotion, stickerId })` 发指定那张。日常自动配图不需要走这条路，express 自己会带关键词匹配。
- `add_sticker` / `update_sticker_tags` / `list_stickers` -> 管理用
- `add_sticker` / `update_sticker_tags` / `list_stickers` -> 管理用

## 管理页面

「表情包」页面支持上传、浏览、编辑标签、AI 识图自动打标签。
