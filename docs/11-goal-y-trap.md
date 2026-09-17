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

上游 master 有一条未发布的修复承认这是 bug,但 npm 上最新仍是 **2.4.5(2023-09-04)**,没有版本可升。

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
