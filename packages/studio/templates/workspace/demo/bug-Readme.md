ID: {{BUG_ID}}
标题: 演示 Bug：建造完成后镜头没有跟随
类型: bug
Tags: demo
描述: 本上报由 `studio init --demo` 生成，用于验证 Viewer 的上报列表 / 详情 / 状态徽标；可安全删除。
复现时间: {{NOW}}
状态: 新
优先级: P2
严重度: low
分支: main
复现步骤: [{"id":"1","text":"启动游戏并进入主场景"},{"id":"2","text":"建造任意一座建筑"},{"id":"3","text":"观察镜头是否跟随"}]
复现: {"frequency":"always","attempts":3}
环境: {"os":"Windows","node":"{{NODE_VERSION}}"}
上报者: {"id":"demo","source":"init"}
数据缺口: 日志, 截图

历史变更:
- [{{NOW}}] 创建 (ID: {{BUG_ID}})
