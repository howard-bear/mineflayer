# 报错词典:每一条的源码抛出点与真实成因

> 版本:mineflayer 4.39.0 / mineflayer-pathfinder 2.4.5 / mineflayer-collectblock 1.6.0 / mineflayer-pvp 1.3.2。
> 下面每一条我都在**实际安装的 node_modules 里**核对过行号,不是从文档或帖子抄的。

我们砍树的失败分布(4.5 小时,178 次尝试):

| 次数 | 报错 |
|---|---|
| 36 | `Digging aborted` |
| 25 | `The goal was changed before it could be completed!` |
| 20 | `There are no defined chest locations!` |
| 7 | `Took to long to decide path to goal!` |

**我一开始把这四条当成同一类("被打断")来处理,这是错的。它们的性质完全不同。**

---

## `There are no defined chest locations!`

**抛出点**:`mineflayer-collectblock/lib/Inventory.js:48`

```js
function emptyInventoryIfFull (bot, chestLocations, itemFilter, cb) {
  if (bot.inventory.emptySlotCount() > 0) return          // 有空格就直接返回
  return await emptyInventory(bot, chestLocations, itemFilter)
}
function emptyInventory (bot, chestLocations, itemFilter, cb) {
  if (chestLocations.length === 0) throw error('NoChests', 'There are no defined chest locations!')
}
```

**含义**:背包一格不剩,而你没有设 `bot.collectBlock.chestLocations`。
**不是**"找不到箱子",是"背包满了,而我不知道该把东西放哪"。

**我们的解法**:见 [01](01-inventory-full-blocks-everything.md) —— 自己扔垃圾,让 `emptySlotCount() > 0` 恒成立。

**🔴 不要用的解法:设 `chestLocations`。** 理由:
`CollectBlock.js` 的 `placeItems()` 从头到尾**没有 `chest.close()`**;
而"跑去箱子存东西"是一段长路径,会被动作超时和保命反射打断。
结果是把 20 次干净的报错,换成一个**窗口一直开着**的脏状态。

---

## `The goal was changed before it could be completed!`

**抛出点**:`mineflayer-pathfinder/lib/goto.js:34`

```js
function goalChangedListener (newGoal) {
  if (newGoal !== goal) cleanup(error('GoalChanged', 'The goal was changed before it could be completed!'))
}
bot.on('goal_updated', goalChangedListener)
bot.pathfinder.setGoal(goal)
```

**含义**:这次 `goto` 还没走到,**别人调了 `setGoal`**。
而 `collectBlock` 内部自己就在用 `goto`(`CollectBlock.js:49` 走向掉落物用的是
`goto(new goals.GoalFollow(closest, 0))`)—— 所以**任何**外部 `setGoal` 都能掐掉正在进行的砍树。

**谁在调 `setGoal`?** 光读代码猜不出来(我们全文有 20 多处)。
方法是**包装 `bot.pathfinder.setGoal`,在长动作进行中记一次调用栈**:

```js
const origSetGoal = bot.pathfinder.setGoal.bind(bot.pathfinder)
bot.pathfinder.setGoal = function (goal, dynamic) {
  // >1500ms 是为了跳过【动作自己开场那次】,否则它会把节流窗口吃掉
  if (acting && Date.now() - actingSince > 1500 && Date.now() - lastLogAt > 10000) {
    lastLogAt = Date.now()
    log(`「${actingName}」跑了 ${Date.now() - actingSince}ms 时,目标被改成 ` +
        `${goal?.constructor?.name} —— ${new Error().stack.split('\n').slice(2,7).join(' ← ')}`)
  }
  return origSetGoal(goal, dynamic)
}
```

**一挂上就当场抓到三个凶手**,其中一个是我们自己写的 bug(见 [08](08-promise-race-timer-leak.md))。

---

## `Took to long to decide path to goal!`

**抛出点**:`mineflayer-pathfinder/lib/goto.js:28`,由 `path_update` 事件的 `status === 'timeout'` 触发。

**🔴 这条根本不是"被打断"**,是 **A\* 在 `thinkTimeout` 内没算出路来**。
默认值在 `mineflayer-pathfinder/index.js:39-40`:

```js
bot.pathfinder.thinkTimeout = 5000   // ms,单次寻路的总思考预算
bot.pathfinder.tickTimeout  = 40     // ms,每 tick 花在思考上的时间(上限 50)
```

把它归到"被打断"那一桶里,就会去修错的东西 —— 这是典型的
**"新失败被归到旧桶里"**。

---

## `Digging aborted`

**抛出点**:mineflayer 核心的 `lib/plugins/digging.js`,不在 pathfinder 里。
挖掘过程中调用了 `bot.stopDigging()`,或目标方块变了。

⚠️ `digging.js:212-215`:**每次 `death` 事件都会
`removeAllListeners('diggingAborted' / 'diggingCompleted')`** ——
所以一次(哪怕是误报的)死亡事件,会让正在进行的挖掘永远收不到回调。

---

## 一条附带的:`bot.pathfinder.stop()` 会留下一个闩

`index.js:163` —— `bot.pathfinder.stop = () => { stopPathing = true }`,**没有任何"当前在不在走"的判断**;
`stopPathing` 只在**内部**的 `stop()`(`index.js:391`)里被清零。

→ **空闲时调一次 `pathfinder.stop()`,下一次 `goto` 会当场以 `PathStopped` 失败。**

社区里有项目把 `pathfinder.stop()` 写进"中断三件套",照抄会给自己引入一个本来没有的 bug。
我们的动作超时用的是 `setGoal(null) + stopDigging()`,**正好躲开了这个坑** —— 属于运气,不是设计。

⚠️ **上游已经修了,但没发版**:master 的 `84c3bd29a7`(2026-09-14)给 `stop()` 加了守卫
`if (!stateGoal && path.length === 0) return`。npm 上最新仍是 2.4.5(2023-09-04)。
详见 [11 · 上游修了但你装不到](11-goal-y-trap.md)。
