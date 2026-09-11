# 表情包插件发布契约

这份文件只约束表情包项目的发布，不替代 Hana 插件开发规范。每次发布前先读本文件，再动手。

## 发布类型

- **小改动**（纯美化、小修复、没有用户流程变化）：推送代码并打 Git tag，不创建 Release；`PENDING_CHANGES.md` 继续积累。
- **功能级改动**（新功能、用户在等的修复、交互流程变化）：走完整发布流程，创建带安装包的 GitHub Release。
- 拿不准档位时，先停在本地问一句，不擅自创建 Release。
- tag 每版都打，不省；已发布历史漏打的补上。

注意：插件自带「检查更新」会在有新 Release 时提示用户，所以小改动逐发 Release 等于频繁打扰。这也是分档的原因。

## 发布工作区

本地正式目录（`<HANA_HOME>/plugins/biaoqingbao`）是唯一开发位置，改完直接改它，不走 dev slot。公开内容从独立克隆推送：

- 发布仓库克隆：`<工作台>/hanako-biaoqingbao`（remote 指向 `moononnn/hanako-biaoqingbao`）
- 同步方式：从正式目录整树复制到克隆，排除 `.git`、`data`、`stickers`、`_backups`、`__pycache__`、`.pytest_cache`、`node_modules`、`*.pyc`、`*.zip`、`*.log`、`*.bak`

克隆里独有的东西（`.github/workflows/ci.yml`、`assets/release-screenshots/`）不能被正式目录覆盖掉，复制方向始终是正式目录 → 克隆。

正式目录里的 `.git` 是早期本地历史线（停在 v0.33.x），**不要用它推送**，公开历史以克隆为准。

推送前验证顺序：同步 → 在克隆目录跑 `node --test tests/*.test.js` 全绿 → push → 等 CI 全绿。

## 版本与账本

- `manifest.json` 与 `package.json` 的版本必须一致（CI 会检查，不一致直接红）。
- 每完成一个功能或修复且测试全绿，就往 `PENDING_CHANGES.md` 记一笔，并把 manifest 版本 patch +1；两个动作一次做完，半成品不升版本。
- 完整发布前，把账本内容整理进 `CHANGELOG.md`，确认没有遗漏后再清空账本（保留文件头），本地正式目录的账本同步清空。
- 跨窗口漏升时补升：账本攒的一波未发布改动整体算一个 minor 版本，之后从 patch +1 递增。
- 发布时直接发当前 manifest 版本号，不额外跳号。
- 发布后核对 `TESTING.md` 里声明的测试项数与当次实跑输出一致。这项是易腐内容，功能迭代后经常落后（曾出现文档写 348 项、实测 375 项，导致包已打好又回炉重打）。

## 固定顺序

1. 读本文件、`TESTING.md`、插件开发规范。
2. 核对 manifest 版本、账本条目、与克隆的差异；补齐 CHANGELOG。
3. 跑 `node --test tests/*.test.js` 与 Python 离屏测试，全绿才继续。
4. 外传红线扫描：个人姓名、其他伙伴姓名、真实邮箱、凭据、测试入口、本机私密路径都不能进入发布内容；对外署名统一为 `moononnn & 小花`。
5. 按逻辑边界拆提交（功能代码与测试 / 文档 / 版本等分开），禁止 `git add .`，逐项确认发布文件。
6. 推送到 `https://github.com/moononnn/hanako-biaoqingbao.git`。
7. 等 GitHub CI 全绿；红了先修再继续，不打包、不建 Release。
8. 建立干净发布暂存目录，做包内容审查、副本测试和树哈希比对。
9. 从干净暂存目录打包，计算 SHA-256。
10. 走下面的「交叉审查门」。
11. 创建 GitHub Release，标题写版本号加主要内容，附上 zip 和 SHA-256；完成后提醒确认。

未经明确确认不执行第 6 步，也不创建对外可见的 Release。

## 干净安装包范围

安装包只放插件本体和运行所需的源码，共 64 个条目：

- `manifest.json`、`package.json`、`index.js`
- `lib/`、`routes/`、`tools/`、`extensions/`、`assets/`、`python/`、`skills/`、`scripts/`
- `README.md`、`CHANGELOG.md`、`TESTING.md`、`THIRD_PARTY_NOTICES.md`
- `LICENSE`、`NOTICE`、`COMMERCIAL-LICENSE.md`

明确排除：

- `tests/`、`python/test_ball_app.py`（测试文件）
- `.github/`、`.gitignore`（仓库配置）
- `assets/release-screenshots/`（README 截图，只在 GitHub 仓库展示）
- `PENDING_CHANGES.md`、`PROJECT_LOG.md`、`PUBLISHING.md`（本地开发文档）
- `data/`、`stickers/`、`node_modules/`、`__pycache__/`、日志、`*.zip`、`*.bak`、运行时 state

打包方式：`.NET ZipFile CreateFromDirectory`，`includeBaseDirectory=false`，条目名不带 `./` 或 `../` 前缀。

### 测试文件联动规则

安装包排除了 `tests/` 与 `python/test_ball_app.py`，因此 `npm test` 不能停在「排除文件但脚本照旧」的状态：`node --test tests/*.test.js` 在没有匹配文件时会输出 `tests 0 / pass 0 / fail 0` 并以 `exit 0` 结束，是能骗过自动审查的假绿灯。

当前做法：`scripts/run-tests.mjs` 作为唯一测试入口，先确认 `tests/` 与 `*.test.js` 存在，缺任一都非零退出并给出明确提示；找到才调用 `node --test`。脚本以自身位置锚定仓库根，并把子进程工作目录钉在仓库根，因此从任意目录调用结果一致（测试用例里有依赖当前目录的相对路径）。

以后新增或移动测试文件时，保持这个入口为唯一入口，不要再把裸 `node --test tests/*.test.js` 写回 `package.json`。

## 交叉审查门

对最终 zip 实物做三层检查。A、B 两组必须派独立的只读审查伙伴复核，C 组可由主会话执行并留证。

**只读审查伙伴的限制**：子会话处于只读模式，`exec_command` 会被平台拒绝，凡是需要 shell 的检查项（包内 JS 逐文件 `node --check`、树哈希、文件行数统计、git 命令）它都做不了，会标成「无法验证」。这些项由主会话补齐，并在发布记录里如实区分「审查伙伴验证」与「主会话补证」，不得把无法验证混成通过。

### A：包内容

- 文件清单无测试文件、用户数据、备份、日志、`node_modules`、运行时产物。
- `manifest.json` 的 `id` / `name` / `version` 齐全；`main` 与 `contributes` 下全部相对路径在包内可解析。
- 条目名无 `./`、`../` 前缀，无绝对路径（Windows 反斜杠分隔符本身不算穿越）。
- 版本对账：manifest / package.json / CHANGELOG / zip 文件名 / tag 一致。
- 解压副本对包内全部 JS 跑 `node --check`。
- 依赖完整性：本项目零第三方依赖，包内 JS 只引用 `node:` 内置与相对路径。
- 暂存目录与解压目录逐文件 SHA-256 及整树哈希比对一致。

### B：安装模拟

- 全新安装路径：关键文件齐全，包内无硬编码本机绝对路径。
- 升级兼容：本版是否改动数据 schema；旧数据与旧字段是否被破坏性重写（分组关系、指纹索引、隐藏名单等要能被旧版数据安全补全）。
- 数据目录合规：运行数据写入 `<HANA_HOME>/plugin-data/biaoqingbao/`，包内不以插件目录为写入根。
- 空图库首次进入有引导入口。

### C：外传红线

- 全库扫描不出现个人姓名、其他伙伴姓名、真实邮箱、凭据或本机私密路径。
- 本地测试入口与调试残留不进入发布副本。
- 提交身份使用开发署名，不带真实邮箱。
- README 的风险、模型请求、数据位置与代码行为一致。
-  GitHub CI 已通过，发布包 SHA-256 已记录，远端下载件与本地一致。
- 超 500 行的文件记录在案（既存项不阻断发布，本版新增的标出来）。

## 署名与隐私

对外文案、README、CHANGELOG、Release notes、代码注释和提交信息不得写入个人姓名、其他伙伴姓名或真实邮箱。项目署名只使用：

```text
moononnn & 小花
```

提交署名：开发类提交使用开发身份；仓库创建与用户拍板的决策节点使用 owner 身份。具体以工作台的账号凭据文件为准，不写进本文件。
