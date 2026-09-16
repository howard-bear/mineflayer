# 三份 Movements 的战争,以及 `canDig` 会静默吃掉整个功能

> 这一篇是我们踩得最深、也最难自己发现的一类问题:
> **没有报错、没有崩溃,功能只是"静静地不干活"。**

## 你以为只有一份,其实有三份

| 谁的 | 在哪创建 | 什么时候变成全局生效的那一份 |
|---|---|---|
| **你自己的** | 你 `bot.pathfinder.setMovements(moves)` | 你设的时候 |
| **collectblock 的** | `CollectBlock.js:153` `new Movements(bot)` | 每次 `collect()` 开头(`:192-195`) |
| **pvp 的** | `PVP.js:50` `new Movements(bot, mcData)` | 每次 `attack()` (`:71`) |

后两份都是 `new Movements(...)` 的**默认值** —— 也就是
`allow1by1towers = true`、`scafoldingBlocks = [dirt, cobblestone]`、`canDig = true`。

**所以:你精心配置的"不许搭塔、不许挖路、绕开浆果丛",一场架打下来就全没了。**

我们是靠 CoreProtect 发现的:机器人在 `x=49,50,51,52` 同一高度放了一排圆石 ——
**横向搭桥过沟**,而我们当时只禁掉了"垂直搭塔"。材料是它自己挖石头掉的。

三份都要配:

```js
for (const mv of [myMoves, bot.collectBlock?.movements, bot.pvp?.movements]) {
  if (!mv) continue
  mv.allow1by1towers = false
  mv.scafoldingBlocks = []
  mv.canOpenDoors = false
  for (const id of avoidIds) mv.blocksToAvoid.add(id)
}
```

## 🔴 但是:**千万不要把自己那份直接赋给 collectblock**

这是社区里一个看着很合理、实际会把功能打到 0 的建议
(「让 collectBlock 用你自己那份 Movements,这样护栏就统一了」)。

**为什么会死**(源码链,我在实际安装的包里逐行核过):

```js
// mineflayer-collectblock/lib/CollectBlock.js:70  —— mineBlock 的第一句
if (… || !bot.pathfinder.movements.safeToBreak(block)) {
  options.targets.removeTarget(block)
  return                                    // ← 静默返回,不抛错
}

// mineflayer-pathfinder/lib/movements.js:252  —— safeToBreak 的第一句
safeToBreak (block) {
  if (!this.canDig) return false
  …
}
```

如果你和我们一样,为了"不许挖穿别人的建筑"把 `canDig` 设成了 `false`,
那么把这份 Movements 交给 collectblock 的结果是:

> **每一棵树都被静默跳过,`collect()` 正常 resolve,零木头、零报错。**

**今天砍树还能有成功率,恰恰是因为 `collect()` 把全局 Movements 换成了它自己那份 `canDig = true` 的。**
那不是 bug,那是唯一让功能跑起来的机制。

同理:`safeToBreak` 里的 `dontCreateFlow`(默认 `true`)会让**任何紧邻水的方块**也返回 false。
collectblock 自己那份在 `:193` 把它设成 `false` —— 换成你的,靠水边的树也会静默跳过。

## 更隐蔽的一层:`mineBlock` 读的是【全局当前】那份

注意 `:70` 读的是 `bot.pathfinder.movements`,**不是** collect() 开头装上的那份。

`collect()` 的顺序是:**设置自己的 Movements → 寻路走过去(几秒)→ `mineBlock`**。

在"走过去"那几秒里,如果有别的东西调了 `setMovements`(例如 `pvp.attack()`),
等走到时全局 Movements 已经是另一份了。如果那一份 `canDig = false` ——
**这棵树就被静默跳过。**

我们给 pvp 那份设 `canDig = false` 正是为了防止它挖穿别人的地。
**两个都对的决定,凑在一起产生了一个谁也没预料到的失败。**

⚠️ 写下这段时我们还在取证阶段:已经从源码确认了机制,
并上线了一条诊断日志(挖完却一块没多时,打出当前全局 Movements 是哪一份、`canDig` 是多少)。
**证实之前不改行为** —— 因为 `canDig` 同时管着"寻路能不能挖路开道",
直接放开会让机器人挖穿别人的建筑,那是我们的红线。

## 教训

1. **一个插件"顶掉你的全局配置"不一定是 bug,可能是它唯一能工作的方式。**
   拆掉之前,先弄清它为什么要这么做。
2. **同一个配置项被两个子系统赋予了不同含义**(`canDig` = "寻路可以挖路开道" vs
   "允许挖这个目标方块"),就一定会出这种事。
3. **最贵的失败是不报错的失败。** 报错至少能被计数、被分类、被搜索;
   静默跳过只会表现为"它好像有点笨"。
