# 自动测试

插件使用 Node.js 内置测试器，不需要安装额外依赖。

在插件目录运行：

```powershell
npm test
```

当前覆盖：

- Observer 两阶段频率抽样
- 表情包标签打分、偏好、否决与排除名单
- 批量识图任务重启时回收 `current_ids` / `current`

新增或修改以上逻辑时，应先补对应失败用例，再修改实现，最后运行 `npm test`。
