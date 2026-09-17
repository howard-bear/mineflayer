# 背包满了是隐形的总开关

> 一个不报错、不崩溃、只表现为"它好像有点笨"的硬阻塞。
> 找了很久,最后是靠 **逐槽位点名 + 负对照** 一次点出来的。

## 症状

- 砍树成功率 **14%**:4.5 小时里 `gather_wood` 被选中 178 次,只有 25 次真拿到木头。
- 日志里"砍不动"的报错分布:

  | 次数 | 报错 |
  |---|---|
  | 36 | `Digging aborted` |
  | 25 | `The goal was changed before it could be completed!` |
  | **20** | **`There are no defined chest locations!`** |
  | 7 | `Took to long to decide path to goal!` |

- 另外还有一类一直没想通的失败:
  `失败:合成跑完了,但背包里没多出 crafting_table(等了 1.2 秒也没出现)`。
  当时以为是 **时序问题**,还专门加长了等待。没用。

## 真因

`mineflayer-collectblock` 在挖之前会先检查背包:

```js
// mineflayer-collectblock/lib/Inventory.js
function emptyInventoryIfFull (bot, chestLocations, itemFilter, cb) {
  if (bot.inventory.emptySlotCount() > 0) return          // 有空格 → 直接返回
  return await emptyInventory(bot, chestLocations, itemFilter)
}
function emptyInventory (bot, chestLocations, itemFilter, cb) {
  if (chestLocations.length === 0) {
    throw error('NoChests', 'There are no defined chest locations!')   // ← 第 48 行
  }
  ...
}
```

也就是说:**背包一格不剩 + 没设 `bot.collectBlock.chestLocations` = 每一次挖都必然抛错。**
不是概率性失败,是 100% 失败,和附近有没有树、树能不能砍、寻路走不走得到 **完全无关**。

而 "合成跑完了但背包里没多出来" 是同一个原因的另一个表现:
**背包满了,合成出来的东西没地方放。**

## 怎么点出来的

RCON 直接查整份背包 **会在 118 字符处截断**,而且
`Inventory[{id:"minecraft:oak_log"}]` 这种按 id 查的写法会骗人
(说"没有",逐槽位却查得到)。所以只能逐槽位点名:

```bash
for s in $(seq 0 35); do
  mc-rcon "data get entity <BOT> Inventory[{Slot:${s}b}]"
done
# 再加一个负对照,证明"查不到"这个结果本身是可信的:
mc-rcon 'data get entity <BOT> Inventory[{Slot:99b}]'   # 必须返回 Found no elements
```

结果:**36 格全满,0 个空格**。负对照通过。

塞满它的全是杂物:41 泥土、31 树苗、25 木棍、13 腐肉、13 线、9 沙、
8 蜘蛛眼、6 骨头、5 箭(它连弓都没有)、4 羽毛、2 铁轨、各种种子。
—— 机器人捡东西时什么都捡,而从来没有人教它扔掉。

## 修法

```js
// 只扔【对当前目标毫无用处】的东西。宁可少扔,也不扔错。
const JUNK_RE = /^(rotten_flesh|spider_eye|poisonous_potato|arrow|feather|egg|rail|
                   wheat_seeds|pumpkin_seeds|melon_seeds|beetroot_seeds|bone|white_wool)$/
let lastTidyAt = 0

async function tidyInventory () {
  if (bot.inventory.emptySlotCount() > 0) return 0     // ← 和 collectblock 同一个判据
  if (Date.now() - lastTidyAt < 30000) return 0
  lastTidyAt = Date.now()

  const junk = bot.inventory.items().filter((i) => JUNK_RE.test(i.name))
  if (!junk.length) {
    // 这条日志本身就是"下一步该做什么"的判据:
    // 如果它反复出现,说明背包是被【有用的东西】塞满的,
    // 那时该加的是"满了就回家存箱子"的硬规则,而不是继续扩大可扔清单。
    log(`背包全满、却没有可以扔的杂物 —— 砍树和合成都会一直失败,得回家存箱子`)
    return 0
  }
  for (const it of junk) {
    await bot.tossStack(it)
    await new Promise((r) => setTimeout(r, 120))   // 别一梭子丢完,服务器可能装着反作弊
  }
  log(`背包满了(0 空格)—— 扔掉 ${junk.length} 样杂物,现在空出 ${bot.inventory.emptySlotCount()} 格`)
}
```

调用点有三处,缺一不可:
1. `actGatherWood` 开头 —— 砍树前
2. `actCraft` 开头 —— 合成前(合成出来的东西要有地方放)
3. 反射层里每秒兜一次 —— **不能等大脑想起来选动作**,因为背包满会让大部分动作失败,
   而失败会让连败计数上涨,最后把这些动作全冷却掉

## 效果(部署前后同一台机器、同一个世界)

`🧹` 在部署后 30 秒触发了一次,扔掉 10 样杂物、空出 10 格。之后:

| 判据 | 修之前(4.5 小时窗口) | 修之后(21 分钟窗口) |
|---|---|---|
| `There are no defined chest locations!` | 25 次 | **0 次** |
| 成功拿到木头 | 25 次 / 4.5 小时 | **24 次 / 21 分钟** |
| 背包里的木头 | 长期 0~2 块 | **max 45,平均 19** |
| **存进箱子的累计量** | **+37 块 / 4.5 小时(≈8/小时)** | **+68 块 / 21 分钟(≈194/小时)** |
| 背包空格 | 0 | 10 |
| 反射层出错 / `ReferenceError` / 崩溃 | — | 0 / 0 / 0 |

**存货速度差了大约 23 倍。**

剩下的两类"砍不动"没有被这个修复覆盖,它们是独立的问题:
`Digging aborted`(10 次)和 `The goal was changed before it could be completed!`(9 次)——
两者都指向"挖到一半被别的东西打断",是下一个要查的方向。

## 三条可以带走的教训

1. **屏蔽逻辑和执行器不能只是"用同一个判据",必须是"同一个函数"。**
   菜单里说"能砍树"、执行器必然失败 —— 小模型会一次次撞同一堵墙,
   而且撞够次数之后连败计数会把这个动作永久冷却,变成"它就是不干活了"。

   这个项目里这类 bug **一晚上犯了四次**:
   ① collectblock 的"背包满不满" ② `store_items` 的"有没有箱子"
   ③ `store_items` 的"有没有东西可存" ④ 第三次修完之后,
   把门槛改成 `有木料 || 空格≤2`,而执行器在"空格≤2 且既没木料也没可清家当"时仍然失败。

   **第四次才改对做法**:把判据抽成**唯一的一个函数** `storableNow()`,菜单和执行器共用它。

   ```js
   // 菜单
   if (storableNow()) avail.push('store_items')
   // 执行器
   if (!storableNow()) return '失败:现在没有可存的东西'
   ```

   > **只要是两份代码,就一定会再漂。** 对齐一次只能管到下一次改动;
   > 共用一个函数才是结构上不可能漂。

2. **`bot.blockAt()` 返回 `null` 只代表"区块没加载",不代表"那东西没了"。**
   拿它当判据会让机器人一走远就把好东西忘掉。涉及远处的东西,
   要用 **记下来的坐标** 算,不要用当前视野。

3. **测量工具本身会骗人。** RCON 查背包会截断、按 id 查会漏、
   `cut -c` 截断中文会产生非法 UTF-8 让 `grep` 直接罢工(一条输出都不给)。
   **每一次查询都配一个负对照** —— 否则你分不清"真的没有"和"我的查询式子写错了"。
