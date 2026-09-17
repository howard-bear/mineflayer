# 我一直在让它去一个不存在的地方,然后怪它走不到

> 这是整个项目里**收益最大的单点修复**:`explore` 成功率 35% → 62~100%,
> 「只挪了 N 格」从 5.5 小时 497 条降到 0~8 条,`Digging aborted` 59 → 0。
> 而改动只有一件事:**走路的目标不要带高度。**

## 症状

机器人老是"走不动":日志里刷的是

```
失败:往西北只挪了 2 格,前面是死路(墙/悬崖/水),换个方向
失败:想去「林子」但只挪了 1 格,路可能不通,换个走法
```

`explore` 一度占到 57% 的决策,而且大部分都是这种半步就回来的。
我查过地形、查过 `blocksToAvoid`、查过是不是被别的东西打断 —— 都不是。

## 真因:`GoalNear` 是三维的

`mineflayer-pathfinder` 2.4.5 的 `lib/goals.js`:

```js
class GoalNear {                       // 构造:(x, y, z, range)
  isEnd (node) {
    const dx = this.x - node.x
    const dy = this.y - node.y         // ← 算高度
    const dz = this.z - node.z
    return (dx * dx + dy * dy + dz * dz) <= this.rangeSq
  }
}

// 库作者自己的注释:
// Useful for finding builds that you don't have an exact Y level for,
// just an approximate X and Z level
class GoalNearXZ {                     // 构造:(x, z, range)  ← 没有 y
  isEnd (node) {
    const dx = this.x - node.x
    const dz = this.z - node.z         // ← 只算水平
    return (dx * dx + dz * dz) <= this.rangeSq
  }
}
```

而我们的代码里,所有"往某个方向走 N 格"都写成:

```js
new goals.GoalNear(目标x, bot.entity.position.y, 目标z, 4)
//                        ^^^^^^^^^^^^^^^^^^^^^ 当前高度
```

**这等于在要求:走到 30 格外,而且那里的地面高度必须和我现在站的地方一样(±4)。**

丘陵地形上这几乎不可能成立。**目标本身就是不可达的** —— A\* 找不到解,
于是要么超时(`Took to long to decide path to goal!`),要么走几步就放弃。

> **不是它走不动。是我给的目的地不存在。**

运行时实证(同一个坐标,只差一个类):

```
GoalNearXZ.isEnd({x:102, y:9999, z:200})  →  true
GoalNear  .isEnd({x:102, y:9999, z:200})  →  false
```

改法就是把这些目标换成 `GoalNearXZ`(只给 x/z):

```js
new goals.GoalNearXZ(目标x, 目标z, 4)
```

## 前后对照

| 判据 | 修前 | 修后 |
|---|---|---|
| `explore` 成功率 | 35% | **62~100%** |
| 「只挪了 N 格」 | 497 条 / 5.5 小时 | **0~8 条** |
| `Digging aborted` | 59 | **0** |
| 决策利用率 | 70% | 74~79% |
| 失败时的平均位移 | 7.0 格 | **0~1.8 格** |

## 🔴 同一个写法还藏着一个保命 bug

`actFlee`(逃跑)也是这么写的:`GoalNear(24 格外, 当前高度, 半径 3)`。

**所以在山坡上、在任何高低不平的地方,它根本逃不掉 —— 站着被打死。**

这条对"为什么死亡率高"是直接因果,而它和"走路走不远"是**同一个 bug 的两副面孔**。
修一处,两个症状一起好。

## 顺带:`goto` 的 resolve 不等于"到了"

`lib/goto.js:22-24`:

```js
function noPathListener (results) {
  if (results.path.length === 0) {
    cleanup()                                              // ← 无错误 resolve!
  } else if (results.status === 'noPath') {
    cleanup(error('NoPath', 'No path to the goal!'))
  } else if (results.status === 'timeout') {
    cleanup(error('Timeout', 'Took to long to decide path to goal!'))
  }
}
```

**"路径长度为 0"这个分支排在最前面,而且不带错误。**
所以 `await bot.pathfinder.goto(goal)` 正常返回,完全可以意味着**一格都没动**。

### 上游修了 —— 但你装不到

master 上的提交 **`84c3bd29a7`(2026-09-14)** 正是修这个的:

> `fix: goto rejects an unreachable goal instead of resolving, and stop() no longer latches while idle (#375)`
>
> *A\* reconstructs its best node on failure, and when the best node is the start that path is empty,
> so goto's li…*

修完之后的 `goto.js`(注意空路径分支挪到了**最后**,而且要求 `status === 'success'`):

```js
// A search that fails or is still slicing reconstructs its best node, which is the start node
// and so an empty path. Only a 'success' with nothing to walk means the goal is already met.
if (results.status === 'noPath') {
  cleanup(error('NoPath', 'No path to the goal!'))
} else if (results.status === 'timeout') {
  cleanup(error('Timeout', 'Took to long to decide path to goal!'))
} else if (results.status === 'success' && results.path.length === 0) {
  cleanup()
}
```

**但 npm 上装不到。** `mineflayer-pathfinder` 最后一次发版是 **2.4.5 / 2023-09-04**,
`dist-tags` 里只有 `latest`,没有 `next` 或 `beta`。
master 很活跃(8 个 open PR、三天前还在提交),**但三年没发过版**。

> **"我们已经是最新版"和"我们有最新的修复"是两回事。**
> 查 npm 只能回答前者。踩到坑之后要去 master 上搜一遍 —— 修复可能早就在那儿躺着了。

同一个提交还修掉了另一个我们记在 [06](06-error-dictionary.md) 里的坑(`stop()` 空闲时留闩):

```js
bot.pathfinder.stop = () => {
  // Nothing is running, so there is nothing to stop; the flag would otherwise survive until the
  // next goal and stop that one instead.
  if (!stateGoal && path.length === 0) return      // ← 新增的守卫
  stopPathing = true
}
```

**我们不打算装 master。** 两个 bug 我们都已经在自己代码里绕开了
(走路目标全换成 `GoalNearXZ`、从不调 `pathfinder.stop()`、14 处自己量位移),
而把一个核心依赖换成未发布的 git 版本、装在孩子们正在玩的服务器上,换不来对应的收益。
**记在这里是为了将来它真发版时知道该看什么。**

> **不要把 `goto` 的 resolve 当成"到了"。一律自己量位移。**

我们现在每个走路动作都记录前后坐标、按实际位移判成败 ——
上面那张表里的"失败时的平均位移"就是这么来的,也正是靠它才发现目标不可达。

## 教训

1. **先怀疑"目标对不对",再怀疑"走得动走不动"。**
   一个不可达的目标和一个走不动的机器人,在日志里长得一模一样。
2. **库里名字相近的类,语义可能差一个维度。**
   `GoalNear` / `GoalNearXZ` / `GoalXZ` / `GoalY` 四个名字排在一起,
   而作者已经在注释里写清楚了各自的用途 —— 是我没读。
3. **一个 API 用错了,症状会分散到好几个看起来无关的功能上**
   (走路走不远 + 逃跑逃不掉 + 挖掘被中断),让人误以为是三个问题。
