# 按群覆盖的提示词

把文件命名为 `<群号>.md` 放在这个目录里，该群就会用这份提示词，未命中的群继续用 `../system.md`。

```
prompts/
├─ system.md          # 全局默认
├─ rules.md           # 公共规则（被 system.md 通过 {{include:rules.md}} 引入）
└─ groups/
   ├─ 123456789.md    # 只对这个群生效
   └─ 987654321.md
```

几点约定：

- 文件名**只能是纯数字**（群号）+ `.md`，其它名字会被忽略，可以放心放说明文件。
- 想在某个群里写不同人设，复制一份 `system.md` 改内容即可；也可以继续 `{{include:rules.md}}` 复用公共规则。
- 也可以在 `config/config.json` 里显式指定（优先级更高）：

  ```json
  "prompt": { "default": "system.md", "perGroup": { "123456789": "groups/game-team.md" } }
  ```

- 改完在群里发 `@小助手 /reload`（需 `bot.owners`）即时生效，不必重启。
- 提示词里可用 `{botName}`、`{groupId}` 占位符；`{{include:相对路径}}` 最多嵌套 4 层，出现循环会直接报错并指出链路。
