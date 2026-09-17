# 闸门只挡了一半

> 我们为"放方块"建了一道很严的闸门,它挡下过上千次寻路自动搭桥,是这个项目里最得意的护栏之一。
> 然后有人问了一句:**"挖"呢?**
>
> 没有。一道都没有。

## 背景:放置闸门为什么存在

这个机器人住在有真人玩的服务器上,所以"不碰别人的东西"是硬红线。
寻路库为了走路会自动搭桥、搭塔 —— 在别人地盘上那就是破坏。

关掉库的配置不够(配置会被别的插件顶掉,见 [07](07-three-movements.md)),
所以我们在**唯一的出口**上设了闸:

```js
const realPlace = bot.placeBlock.bind(bot)
bot.placeBlock = async (refBlock, faceVector) => {
  const okHere = placeAllowedAt && refBlock && refBlock.position &&
    refBlock.position.x === placeAllowedAt.x &&
    refBlock.position.y === placeAllowedAt.y &&
    refBlock.position.z === placeAllowedAt.z
  if (!okHere) { placeBlocked++; return }        // ← 拦下
  return realPlace(refBlock, faceVector)
}
```

`placeAllowedAt` 只在真正要放的那一瞬间存着那一格的坐标,其余时间是 `null`。
**它工作得很好** —— 日志里有 **766 条**拦截记录。

⚠️ 但**别把这 766 当成拦截次数**,我差点就这么写了。那条日志是节流的:

```js
if (placeBlocked <= 3 || placeBlocked % 50 === 0) log(`拦下一次…(累计 ${placeBlocked} 次)`)
```

**前 3 次逐条记,之后每 50 次才记一条**,而且计数器每次进程重启归零
(日志里有 97 次启动,所以最后一条写的是"累计 1 次")。
766 是**行数**,真实拦截次数远大于它。

> 这是[截断和缓存](10-counting-deaths.md#附同一晚栽的另外两次工具在骗人)的同一家族:
> **节流过的日志不能当事件计数器用。** 要数事件,就在代码里数,别数日志行。

## 缺口

准备给机器人加"挖矿"动作时,才注意到:

| | 有闸门吗 |
|---|---|
| `bot.placeBlock` | ✅ 包装了,坐标精确匹配 |
| **`bot.dig`** | ❌ **一处包装都没有** |

而且:

```js
// 我们给 collectBlock 那份 Movements 设过:
cm.allow1by1towers = false
cm.scafoldingBlocks = []
// 但从来没设过 canDig —— 而 movements.js:23 的默认值是:
this.canDig = true
```

**所以现在唯一挡住乱挖的,是三个写在砍树函数【内部】的判断**:

```
isNaturalTree(block)      // 上面有树叶吗
  └─ hasLeavesAbove()
  └─ manmadeNear()        // 周围 3 格有人造方块吗
```

它们只在 `actGatherWood` 里被调用。

> **一个新动作要绕过它们,不需要任何恶意,只需要"没想到"。**

## 为什么这个缺口到今天才暴露

因为**目前只有一个地方会挖**(砍树),而那个地方恰好自带检查。
**能力的边界和护栏的边界重合了 —— 纯属巧合,不是设计。**

这类缺口的特征:
- 它**不会**在任何测试里暴露,因为触发它需要一个**还不存在的功能**
- 它**看起来**是被护住的,因为现有的调用路径确实被护住了
- 它会在**加新功能的那一刻**突然生效,而那时候你正忙着想新功能对不对

## 怎么补

和放置对称地做一道 `digAllowedAt`:坐标精确匹配、只在真正要挖的那一瞬间打开、
用完立刻关。**形状和 `placeAllowedAt` 完全一样** —— 那个形状已经被上千次拦截验证过了。

配套的三条:
1. **方块白名单**,不做通用的"挖"(石头 / 圆石 / 深板岩 / 铁矿 / 煤矿……别的一律不挖)
2. **复用 `manmadeNear`**:周围有人造方块就不挖 —— 这条已经在线上验证过有效
3. **三份 Movements 的 `canDig` 全部保持 `false`**,挖掘只走自己那条带闸门的路径,
   **绝不靠放开 `canDig` 来实现功能**

## 能带走的一条

> **每建一道闸门,都问一句:这个能力的"反操作"有闸门吗?**

放 ↔ 挖、写 ↔ 删、加 ↔ 减、连 ↔ 断。
我们很容易给"会造成可见后果"的那一半设防,而另一半因为"现在没人用"就空着 ——
**直到有人用。**

而且在我们这里,空着的恰恰是**破坏性更强**的那一半:
放错一块方块,别人看得见、可以拆掉;**挖错一块,别人的东西就没了。**
