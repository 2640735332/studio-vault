# 简报：{{PROJECT_NAME}} 演示简报

日期: {{DATE}}  
包提示: demo  
轨提示: *(无)*  
状态: **草稿**

> 本文件由 `studio init --demo` 生成，用来验证 `docs/briefs` 扫描与 Viewer 渲染链路；可安全删除或改写成你的第一份真实简报。

## 1. 问题

一个新接入 Studio 的游戏仓，需要先确认「简报目录能被发现、能被渲染」这条最小链路是通的，再谈共享仓同步。

## 2. 目标

1. `studio serve` 打开 Viewer 后，侧栏「简报」根下能看到本目录。
2. 点开能正确渲染本文件。
3. 改写成真实简报后，`studio sync` 能把它镜像进 `docs/briefs`（需先配置 `shared.remote` 并执行 `studio bootstrap`）。

## 3. 非目标

- 不引入任何 npm 依赖（本仓红线：只用 Node 标准库）。
- 不要求先启动 Vault：Vault 不可达时 Viewer/doctor 以 degraded 运行，不是失败。

## 4. 约束

- 目录名格式 `<YYYY-MM-DD>-<主题>`；本演示为 `{{DATE}}-demo-brief`。
- `BRIEF.md` 首行 `# 简报：<标题>`，并保留 `状态:` 行（Viewer 用它显示状态徽标）。

## 5. 方案

先用本文件跑通链路，再把内容替换成项目的真实简报。

## 6. 验收标准

| ID | 标准 |
|----|------|
| AC-1 | Viewer 侧栏出现「简报」条目 |
| AC-2 | 点开后正确渲染 `BRIEF.md` |
| AC-3 | 删除本演示目录后 Viewer 不报错 |

## 7. 待决问题

- 无。

## 8. 参考

- `studio.config.json`（由 `studio init` 生成）
- `game/reports/bugs/`（演示 Bug 上报）
- `game/src/data/buildings.json`（演示数据样例）

## 9. 变更记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | {{DATE}} | `studio init --demo` 生成 |
