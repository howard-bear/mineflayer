# `Promise.race` 的定时器泄漏 —— 一颗延迟 30 秒才炸、而且炸在别人身上的雷

> 这是我们自己写出来的 bug,靠"包装 `setGoal` 记调用栈"这一条诊断当场抓到的。
> 它的价值不在这个 bug 本身,在于**这类 bug 为什么几乎不可能靠读代码发现**。

## 原来的代码

给每个动作加一个 30 秒封顶,免得一个动作把决策循环堵死:

```js
const outcome = await Promise.race([
  executeAction(action),
  new Promise((res) => setTimeout(() => {
    bot.pathfinder.setGoal(null)
    bot.stopDigging()
    res('失败:这个动作卡了 30 秒还没做完,我掐掉了')
  }, ACT_CAP_MS)),
])
```

看起来完全正常。而且它**确实**在动作卡住时正确地掐掉了动作。

## 问题

**`Promise.race` 不会取消输掉的那一边。**

动作在 3 秒内正常完成 → `race` 已经 resolve 了 → 但那颗 `setTimeout` **还活着**。
30 秒后它照样触发,对着**当时正在跑的另一个动作**执行
`setGoal(null)` + `stopDigging()`。

而我们的决策是每 2.5 秒一次。也就是说:
**空中永远飘着一串定时炸弹,每颗在自己那个动作结束 30 秒后,炸一次别人。**

## 为什么读代码发现不了

因为**现场和起因完全脱钩**。你看到的是:

```
「gather_wood」开始 → 3 秒后 → 失败:砍不动(The goal was changed…)
```

在那 3 秒里,日志上什么都没发生。凶手是 30 秒前那个**已经成功结束**的动作。
你会去查"谁打断了砍树",而正确答案是"三十秒前的某个已经完成的动作"。

## 怎么抓到的

包装 `bot.pathfinder.setGoal`,在长动作进行中记一次调用栈(完整代码见
[06](06-error-dictionary.md))。一挂上就看见了:

```
「gather_wood」跑了 29999ms 时,目标被改成 null —— Timeout._onTimeout (bot.js:3473)   ← 合理,是它自己的封顶
「goto_place」 跑了  3212ms 时,目标被改成 null —— Timeout._onTimeout (bot.js:3473)   ← 才跑 3.2 秒
「explore」    跑了  2645ms 时,目标被改成 null —— Timeout._onTimeout (bot.js:3473)   ← 同上
```

**同一行代码,却在一个动作才跑了 3 秒的时候触发** —— 它只可能来自别的动作留下的定时器。

## 修法

```js
let capTimer = null
try {
  const outcome = await Promise.race([
    executeAction(action),
    new Promise((res) => {
      capTimer = setTimeout(() => {
        capTimer = null              // 自己已经触发了,finally 里就别再 clear
        bot.pathfinder.setGoal(null)
        bot.stopDigging()
        res('失败:这个动作卡了 30 秒…')
      }, ACT_CAP_MS)
    }),
  ])
  …
} finally {
  if (capTimer) { clearTimeout(capTimer); capTimer = null }   // ← 关键
}
```

## 效果(同一台机器,部署前后)

| 判据 | 修之前(12 分钟) | 修之后(5 分钟) |
|---|---|---|
| **短命动作被超时定时器掐掉**(遗留炸弹) | **9 次** | **0 次** |
| `GoalChanged` 造成的砍树失败 | 5 次 | **0 次** |
| 存进箱子的速度 | — | ≈456 块/小时 |

## 教训

> **`Promise.race` 里任何带副作用的定时器,都必须 `clearTimeout`。**

更一般地:**凡是"超时兜底"的实现,都要问一句"赢的那一边发生后,输的那一边怎么办"。**
如果输的那一边只是 resolve 一个没人要的值,那没关系;
只要它**动了外部状态**(停寻路、停挖掘、改变量、发网络包),它就是一颗延迟生效的雷。

而"延迟生效"正是让它极难被发现的原因:**日志上因果关系是断开的。**
