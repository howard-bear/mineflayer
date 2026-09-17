# 我调了停止,它没停 —— 而换一种停法,它会假装成功

> 动作封顶到点,我们调 `setGoal(null)` 把砍树掐掉。日志显示掐掉了 **171 次,其中 170 次是砍树**。
> 然后下一个动作开始走路,和一个"已经被掐掉"的任务抢寻路器。
>
> 我第一版的解释是:错误被库吞掉了。**那个解释是错的,而我已经把它发给了另一个会话。**
> 真相是:我们的停止信号,大部分时候**根本没有人在听**。

## 症状

`gather_wood` 被封顶掐掉之后,机器人并没有停下。下一个动作(走路、打猎)开始后,
两边同时在给寻路器下目标,表现是走走停停、或者刚起步就被打断。

## 我第一版的解释(错的)

读 `mineflayer-collectblock 1.6.0` 的 `lib/CollectBlock.js:205-218`,看到这个:

```js
try {
  await collectAll(this.bot, optionsFull)
} catch (err) {
  this.targets.clear()
  // Ignore path stopped error for cancelTask to work properly (imo we shouldn't throw any pathing errors)
  if (err.name !== 'PathStopped') throw err        // ← 吞掉
} finally {
  this.bot.emit('collectBlock_finished')
}
```

推理链是这样的:我们掐 → 产生 `PathStopped` → 被这个 `catch` 吞掉 →
`collect()` **正常 resolve** → 调用方分不出"砍完了"和"我把它掐了"。

听起来很顺。我把它写进了给另一个会话的结论里。

## 🔴 真因:`setGoal(null)` 产生的根本不是 `PathStopped`

用真的 `goto.js` 驱动跑了一遍,不是读代码推的:

```js
// 把 mineflayer-pathfinder 2.4.5 的 lib/goto.js 原样 require 进来,手工发事件
emit('goal_updated', null)   → GoalChanged
emit('goal_updated', 别的目标) → GoalChanged
emit('path_stop')            → PathStopped
path_update status=noPath    → NoPath
path_update status=timeout   → Timeout
```

机制在 `pathfinder` 里:

```js
// index.js:142-147
bot.pathfinder.setGoal = (goal, dynamic = false) => {
  stateGoal = goal
  bot.emit('goal_updated', goal, dynamic)     // ← 立刻触发下面这个
  resetPath('goal_updated')
}

// lib/goto.js:32-36
function goalChangedListener (newGoal) {
  if (newGoal !== goal) {
    cleanup(error('GoalChanged', '…'))        // ← null !== goal,当场 GoalChanged
  }
}
```

而 `:212` 的豁免条件是 `err.name !== 'PathStopped'` —— **`GoalChanged` 不满足,被原样抛出。**

> **我们的封顶掐在寻路上时,`collect()` 是可见地 reject 的。它从来没被吞过。**

## 那泄漏是怎么来的:不是"被吞掉",是"没人接"

`collectAll` 的循环(`CollectBlock.js:23-58`)里有**五**个 await,只有**两个**是寻路:

```
:24  emptyInventoryIfFull(…)          ← 对 setGoal(null) 免疫
:31  await bot.pathfinder.goto(goal)  ← 听得见
:32  await mineBlock(…)               ← 里面是 bot.dig + 等 10 个 physicsTick,免疫
:49  await bot.pathfinder.goto(GoalFollow) ← 听得见(走向掉落物)
:50  await waitForPickup              ← 等 entityGone 事件,完全免疫
```

`setGoal(null)` 只对**此刻正卡在 `goto()` 里**的那一程有效,因为只有 `goto()`
挂了监听器(`goto.js:59-62`)。掐在另外三个上时,它是一次**纯空放**:
不 reject、不 resolve、什么都不发生 —— `while` 循环下一圈照样开一个新的 `goto`,
接着走。

**这才是"任务还在后台跑、和下一个动作抢寻路器"的真机制。**

两种情况的差别很大:

| 封顶掐下去时,collectAll 停在 | 结果 |
|---|---|
| `:31` 或 `:49`(寻路中) | `collect()` 以 **`GoalChanged`** reject。任务真停了,目标被 `:209` 清空。**调用方看得见。** |
| `:24` / `:32` / `:50`(非寻路) | **空放**。循环继续,开新路径。**调用方什么都看不见,而它还在跑。** |

## 那个"吞掉"是真的,只是要换一种停法才碰得到

`PathStopped` 只由 `path_stop` 事件产生,而这个事件全仓库**只有一处** emit ——
`pathfinder` 的**内部** `stop()`:

```js
// index.js:390-396   注意:这是闭包里的内部函数,不是 bot.pathfinder.stop
function stop () {
  stopPathing = false
  stateGoal = null
  path = []
  bot.emit('path_stop')     // ← 唯一的 PathStopped 来源
  fullStop()
}
```

而对外暴露的那个 `stop()` 只有一行:

```js
// index.js:162-164
bot.pathfinder.stop = () => { stopPathing = true }   // 只举一个闩,什么都不发
```

闩由两处消费:走到下一个路径节点(`index.js:582`),或任何一次 `resetPath` 的末尾
(`index.js:139` `if (stopPathing) return stop()`)。

所以要走到"被吞掉"那条路,得调 `pathfinder.stop()`,而不是 `setGoal(null)`。
**`CollectBlock.js:245` 的 `cancelTask()` 第一句正是 `this.bot.pathfinder.stop()`。**

> **换用库自己的 `cancelTask()` —— 那个看起来更"正确"的 API —— 才是真正走进吞掉路径的那一步。**
> 到那时,"掐掉"和"砍完了"才真的分不出来。

## 为什么这个设计不是 bug

查了这行的来历。它来自
[`PR #88 "Make cancelTask functional"`](https://github.com/PrismarineJS/mineflayer-collectblock/pull/88)
(作者 @gyorik,2022-04-27 由 TheDudeFromCI 合并),用来关掉
[`#49 "CancelTask() not fully implemented"`](https://github.com/PrismarineJS/mineflayer-collectblock/issues/49)。

同一个 PR 同时加了两样东西 —— 我拉了它的 patch 逐行确认:

```diff
+      // Ignore path stopped error for cancelTask to work properly (imo we shouldn't throw any pathing errors)
+      if (err.name !== 'PathStopped') throw err
+    this.bot.pathfinder.stop()
```

**吞掉是为了让 `cancelTask()` 能正常工作。** 对"库自己取消自己"这个场景,它完全正确。
只是作者没有考虑另一种情形:**调用方出于自己的理由停掉寻路器** ——
而那恰恰是社区为了绕开[没有超时](18-no-timeout-is-not-a-bug.md)会做的事。

和 [07](07-three-movements.md) 是同一个道理:一个插件的行为不一定是 bug,
可能是它在自己那个场景里唯一能工作的方式。

## 🔴 还有一颗雷:`cancelTask()` 会留下一个举着的闩

`stopPathing` 只在内部 `stop()`(`index.js:391`)里被清,**没有任何超时或空闲清理**。

`cancelTask()` 第一句举起闩,然后 `await once(bot, 'collectBlock_finished')`
(`CollectBlock.js:250`)。如果此刻 `collectAll` 停在 `:32` 或 `:50`(不在寻路),
闩**没人消费**;而如果你像我们一样给 `cancelTask` 套了超时并放弃等待,
**闩就一直举着**。

下一个走路动作会这样死:

```
挂监听器(goto.js:59-62)
  → setGoal(goal)
  → emit('goal_updated', goal)     自己的目标,不报错
  → resetPath
  → index.js:139 发现闩还举着
  → 内部 stop() → emit('path_stop')
  → 刚挂上的监听器当场 reject PathStopped      ← 一步都没走
```

实测(`goto.js` 用真身,`index.js` 的 `setGoal`/`stop`/`resetPath` 按行号复刻):

```
① 正常 goto,没人动过闩                → RESOLVED
② 先 stop() 举起闩,再开一个全新 goto    → PathStopped   ← 一步没走
③ 举闩后先 setGoal(null) 清场,再 goto  → RESOLVED
```

**修法**:`cancelTask` 超时放弃之后,补一次 `bot.pathfinder.setGoal(null)` ——
它的 `resetPath` 会顺带把闩吃掉(上面③已验证)。

只有下一次 `collect()` 能自愈:`CollectBlock.js:195` 每次开头无条件 `setMovements`,
那次 `resetPath` 会把闩无害地吃掉。**别的动作都是受害者。**

## 上游知道吗

不知道。

- 在 `PrismarineJS/mineflayer-collectblock` 的 issue 里搜 `PathStopped` —— **零条**。
- 五个还在维护、且领先上游的 fork,**每一个都逐字保留着这行**。
- npm 上的 `latest` 仍然是 **1.6.0**(2025-01-24),库代码最后一次实质改动也是那天。

对比之下 `mineflayer-pathfinder` **今天还在提交**(309 stars,collectblock 56)。
**下面那层活着,这一层是休眠的。** 所以不要指望上游修 —— 兜底得写在自己这边。

## 教训

**1.「我调了停止」和「它真的停了」是两件事。**
   而且中间有三种断法:信号没人听(空放)、信号被当正常情况吞掉、信号留下副作用毒死下一个人。
   我们三种都踩到了。

**2. 停止信号也要区分"停哪一层"。**
   `setGoal(null)` 停的是**一次寻路**,不是**一个任务**。一个任务里有五个 await,
   只有两个是寻路 —— 只停寻路,等于只按住了 40% 的它。

**3. 读源码读到一半就下结论,比不读更危险。**
   我看到那个 `catch` 就停下了,没有往回追一步"我们发的到底是哪个错误名"。
   因果链的每一环都要单独验,尤其是**最靠近自己代码的那一环** ——
   它离得最近,所以最容易被当成显然的。

**4. 名字相近的两个 API,失败方式可以完全相反。**
   `setGoal(null)` 立即生效、产生可见的 `GoalChanged`、不留副作用;
   `pathfinder.stop()` 延迟生效、产生会被吞掉的 `PathStopped`、留一个没人清的闩。
   一句话版:**`stop()` 是"下次路径推进时给我停",`setGoal(null)` 是"现在就把目标抹掉"。**

> **别问"我调停止了吗",问"谁在听,它听见之后会告诉谁"。**

---

⚠️ **附:这篇里我改过的和没复核的**

- 「`PathStopped` 被吞掉导致假成功」这个解释是我第一版的结论,**已经推翻**,
  但整段留在上面没删 —— 它错的方式比它本身更值得看:一条读起来完全通顺的因果链,
  断在离自己代码最近的那一环上。
- 「被掐 171 次,其中 170 次是 gather_wood」来自另一个会话的计数器,**我没有独立复核**。
  按上面的分析,这 171 次里真正产生 `PathStopped` 的**一次都没有**(封顶调的是
  `setGoal(null)`)。所以这个数是"封顶触发次数",**不能当成 `PathStopped` 的发生次数**。
- `index.js` 的 `setGoal` / `stop` / `resetPath` 在实测脚本里是**按行号复刻**的
  (它们是闭包内部函数,没法直接 require)。`goto.js` 和 `CollectBlock.js` 都是原包真身。

版本:`mineflayer-collectblock 1.6.0`、`mineflayer-pathfinder 2.4.5`、`mineflayer 4.39.0`。
行号都是这几个版本的实际安装包,逐行核过。
