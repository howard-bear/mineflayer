# 泄漏一个独占的东西,比泄漏资源贵得多

> 一次被 30 秒封顶掐掉的**合成**,让之后**每一次开箱子**都失败 —— 一直失败到进程重启。
> 这是 [08](08-promise-race-timer-leak.md)、[19](19-stop-is-not-stopped.md) 那条线上的第三个,
> 而它比前两个都贵:**前两个泄漏的是可再生资源,这个占住的是一个全局独占的单例。**

## 症状

```
14:2x  合成动作(打开工作台)有几次被 30 秒封顶掐掉
15:2x~16:0x  连续 10 次「打不开箱子(windowOpen did not fire within timeout of 20000ms)」
16:02:16  机器人就站在箱子那一格上(距离 0.0),照样失败
```

同一口箱子,**另一个机器人一直开得好好的**。

## 链条

```
动作封顶用 Promise.race
  → race 不取消输的那一边,被掐掉的 craft 变成僵尸继续跑
    → 它已经把工作台窗口开出来了
      → 但它再也走不到自己那句 closeWindow
        → bot.currentWindow 永远非空
          → 之后任何 openBlock 都等不到 windowOpen(服务端认为你已经开着一个窗口了)
            → 20 秒超时,每一次,直到重启
```

`craft` 本身**没有 bug**。它在成功和异常两条路上都关窗:

```js
// craft.js:23-35(mineflayer 4.39.0,逐行核过)
      if (windowCraftingTable) {
        await bot._syncWindow(windowCraftingTable)
        await bot.closeWindow(windowCraftingTable)   // ← 成功路
        windowCraftingTable = undefined
      }
    } catch (err) {
      if (windowCraftingTable) {
        bot.closeWindow(windowCraftingTable)         // ← 异常路
        windowCraftingTable = undefined
      }
      throw new Error(err)
    }
```

**两条路都关。问题是僵尸走不到任何一条。**
`Promise.race` 只是不再等它,不是让它停下 —— 它停在了中间某一步。

## 为什么它比前两个贵:泄漏的东西是独占的

08 泄漏的是**定时器**,19 泄漏的是**一次寻路**。多一个少一个,系统还能跑。

这次泄漏的是 `bot.currentWindow` —— **全局只有一个**。而 mineflayer 里一大堆东西默默依赖它:

```js
// inventory.js:581   点格子的时候,目标窗口是【隐式】选的
const window = bot.currentWindow || bot.inventory
```

所以窗口泄漏期间,**后续每一次点格子都被悄悄改道打进那个残留窗口**,槽号整体错位。
不是报错,是**点到别的东西上去**。

```js
// inventory.js:433-440   只有 closeWindow 会把窗口内容同步回背包
function closeWindow (window) {
  bot._client.write('close_window', { windowId: window.id })
  copyInventory(window)          // ← 唯一调用点
  lastClosedWindow = window
  bot.currentWindow = null
  ...
}
```

窗口不关 → `copyInventory` 不跑 → **`bot.inventory` 永远停在开窗前的快照**。
所有"我背包里有什么"的判断,从此读的是一张过期的照片。

```js
// simple_inventory.js:83
async function disrobe (destination) {
  assert.strictEqual(bot.currentWindow, null)     // ← 直接 AssertionError
```

脱装备会直接抛断言错误。

> **一个可再生资源泄漏,代价是"多用了点内存"。
> 一个独占单例泄漏,代价是"之后所有人都用不了,而且没人知道为什么"。**

## 故障半径在时间上是无界的

前两个的代价落在**出问题的那个动作**上。这个不是:

- 触发它的是 14 点那次合成
- 付代价的是 15 点、16 点、以及之后每一次开窗
- **直到进程重启为止**

一次 30 秒的超时,换来后面几小时所有箱子操作全废。
而且**现场看起来完全不像同一件事** —— 谁会把"打不开箱子"和"一小时前一次合成超时"联系起来?

## 🔴 一处要更正的:库里是有超时的

排查过程中有个说法是「mineflayer 层面没有超时,不 resolve 也不 reject」。**这句不对。**

```js
// inventory.js:405-410
async function openBlock (block, direction, cursorPos) {
  bot.activateBlock(block, direction, cursorPos)
  const [window] = await once(bot, 'windowOpen')      // ← 看着像没超时
  ...
}

// promise_utils.js:102-104   但这个 once 不是 Node 的 events.once
function once (emitter, event, timeout = 20000) {     // ← 默认 20 秒
  return onceWithCleanup(emitter, event, { timeout })
}
```

那句 `Event windowOpen did not fire within timeout of 20000ms`(`promise_utils.js:86`)
**就是库自己抛的**,不是我们加的。

这个误会本身值得记:`once` 这个名字来自 Node 标准库,而 mineflayer 用同名函数覆盖了它、
还塞了个默认超时。**看到一个眼熟的名字,先确认它是不是你以为的那个。**

## 修:四处,少一处都不够

```
① 开箱子/开工作台【之前】,先关掉可能泄漏的旧窗口 —— 每次留一行日志,不静默
② 兜底巡检:没有动作在跑、却有窗口开着超过 3 秒 = 必然是泄漏
③ 开窗等待从库默认的 20 秒压到 6 秒(动作总预算只有 30 秒)
④ 失败文案里带上「现在是否还有窗口开着(id/type)」
```

**②那一处是必须的,因为它不依赖"谁记得写清理"。**
①只保护"我想到的那两个入口";以后新加的任何开窗动作都会重新掉进同一个坑。
④也不是装饰:这个故障**会把自己伪装成网络问题**(等不到回包),
必须让系统自己把"其实是我手里还攥着一个窗口"说出来。

## 教训

**1. 🔴 分清你泄漏的是资源还是独占权。**
   资源泄漏可以靠"多给点"扛过去;独占权泄漏没有这种余地 ——
   **它不是变慢,是别人全都进不来。** 排查优先级应该按这个分,不按"泄漏"这个词分。

**2. 一个副作用要一路追到底 —— 追到它被谁收拾掉,或者确认没人收拾。**
   这条链的上半截(僵尸会把窗口开出来)其实早就写进过文档,
   但当时只修了预算、**没有追问那个已经开出来的窗口后来怎么了**。
   知道"有副作用"和知道"副作用的结局",差了整整一次事故。

**3. 故障半径要按【时间】量,不只按【范围】量。**
   "只影响合成"听起来很小。但它影响的是**之后所有时间里的所有开窗**,
   而触发点早已滚出日志窗口。**代价不落在犯错的地方,是最难查的一类。**

**4. 名字眼熟不等于是同一个东西。**
   `once` 看着像 `events.once`,其实带 20 秒默认超时。

> **`Promise.race` 不取消输的那一边 —— 而输的那一边,手里可能攥着一把公共的钥匙。**

---

⚠️ **附:这篇里哪些是我核的,哪些不是**

- **我逐行核过的**(mineflayer `4.39.0` 实际安装包):`craft.js:23-35` 两条关窗路径、
  `inventory.js:405-410` openBlock、`inventory.js:433-440` closeWindow/copyInventory、
  `inventory.js:581` `bot.currentWindow || bot.inventory`、`simple_inventory.js:83` 断言、
  `promise_utils.js:86` 报错文案、`promise_utils.js:102` `once` 的 20 秒默认超时。
- **现场时间线、10 次失败、逐条排除(GP 授权 / 离线 UUID / 距离 0.0 / nLogin / GrimAC)
  来自另一个会话,我没有独立复核。**
- **「服务端在已有窗口打开时不会再发 windowOpen」这条机制,我没有独立验证。**
  它能解释全部现象,但我没有抓包、也没有读服务端实现 —— 这是推断,不是证据。
- **僵尸 craft 具体卡在哪一步**(它为什么走不到自己的 closeWindow)**没有查到**。
  `Promise.race` 不取消它,但正常情况下它应该继续跑完并关窗;
  所以中间一定还有一步把它卡死了(合理的猜测是机器人被封顶后走开、工作台出了交互距离),
  **这一环是缺的**,而它决定了「所有被掐掉的 craft 都会泄漏」还是「只有某些情况会」。
- 四处修法的效果由另一个会话实测(两个机器人现在都能开箱子),我只复核了源码侧的因果。

版本:`mineflayer 4.39.0`。
