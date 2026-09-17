# 插件选型,以及"别把调试界面开到公网上"

> 我们是一台**公网** Minecraft 服务器,25565 被人当过 DDoS 反射器烧流量,
> 而且**有一群小孩正在上面玩**。所以这一篇里"稳定性"和"端口"的权重高于功能。

## 🔴 三个会默认在公网裸奔的插件

| 插件 | 默认行为 | 为什么危险 |
|---|---|---|
| `mineflayer-web-inventory` | `index.js:28` 是 `http.listen(port, …)`,**没有 host 参数** → Node 绑 `0.0.0.0`;默认端口 3000;`startOnLoad` 默认为**开** | **`loadPlugin` 那一刻就在全网 3000 端口裸奔,零认证**。启动日志原文就是 `running on *:3000` |
| `prismarine-viewer` | `lib/mineflayer.js:81` 同样 `http.listen(port)` 无 host;签名 `{viewDistance, firstPerson, port, prefix}` **没有 host 选项**;默认端口**也是 3000** | 同上,而且它是**双向**的:`worldView.on('blockClicked', …)` 会把网页端的点击喂回 bot。另外 `WorldView` 是**每条 socket 建一份** —— 有人开 N 条连接就是对服务器做区块推送 DoS |
| `mineflayer-statemachine` 的 `StateMachineWebserver` | 默认 8934、无绑定、无认证 | 同类问题 |

**要用就必须**:`startOnLoad: false` + 自建 http server + `listen(port, '127.0.0.1')` + SSH 隧道。
不要相信"反正没人知道端口"。

**另外**:想看机器人背包,其实**不需要任何端口** —— `bot.inventory.items()` 直接就有,
主手/副手补一下 `bot.inventory.slots[45]`。我们一开始绕了远路去用 RCON 查(还被截断骗了),
其实自己进程里就有。

## ⚠️ 照着社区建议改之前,先验一遍版本

我们对四份调研报告做了一次源码复核,**拦下了三条照做会出事的建议**:

1. **`bot.dig(block, 'raycast')`** —— 参数位置错了。
   `digging.js:18-24` 的签名是 `dig(block, forceLook, digFace)`,
   这样写等于 `forceLook='raycast'`(truthy → 走**瞬间扭头**分支)+ `digFace='auto'`。
   **不抛错、不警告**,只是变成"瞬时转头 + 挖顶面" —— 恰恰是最容易被反作弊判的形态。
   正确写法只有 `bot.dig(block, false, 'raycast')`。

2. **把别人仓库里针对 mineflayer 4.33.0 的 patch 打到 4.39.0 上** ——
   其中一条把 `place_block.js` 的 timeout 从 5000 压到 500ms。
   但 4.39.0 已经改成"服务器明确拒绝就立刻 reject",5000ms 只在服务器一声不吭时才走到。
   压到 500ms 只会把"慢但成功"的放置变成假失败。

3. **`canOpenDoors = true`** —— 上游 `movements.js:101` 的原注释是
   `canOpenDoors = false // Causes issues.`,是特意从 true 改回来的。
   而且对我们来说,"去开别人家的门"本身就违规。

**共同点:三条都来自"看起来很权威"的来源(知名开源项目的 patch、维护者的回帖)。**
版本差一点、参数位置差一个,结论就反了。

## `physicTick` 那行警告:是噪音,不是 bug

`mineflayer-pvp/lib/PVP.js:51` 用的是 `physicTick`(少一个 s),
mineflayer 每次注册都会警告一次,日志里能刷出上百条。

但 `mineflayer/lib/plugins/physics.js:85-86` 是这样的:

```js
bot.emit('physicsTick')
bot.emit('physicTick') // Deprecated, only exists to support old plugins.
```

**两个都发。** 所以 pvp 照常工作,这纯粹是日志噪音。

⚠️ **别把它数进"崩溃重启"里** —— 我们就干过:用
`awk '$0 >= "2026-09-16 16:40"'` 筛时间窗,而以字母开头的行(`Mineflayer detected…`)
在字符串比较里永远大于 `2026-…`,于是整个文件的警告都漏了进来,
被数成"122 次崩溃"。真实重启次数是 0(`systemctl show mcbot -p NRestarts` 说了算)。

## 反作弊(GrimAC):一个有价值的**负**结果

我们这台服务器**真的装着 GrimAC**,而且理论风险是实打实的:
GitHub 上 **#3800 / #3791** 都报过 mineflayer 机器人被 Grim 的 `TickTimer` 检测踢掉 ——
因为 mineflayer 从来不发那个收尾包。

⚠️ 包名在 minecraft-data 1.21.4 里是 **`tick_end`**,不是社区里常写的 `client_tick_end`。
**写错了不报错,只是永远不触发** —— 又一个"静默失效"。

但在我们这台服上的实测是:

```
grep -i grim logs/latest.log                 → 28 行
grep -i grim logs/latest.log | grep -c 机器人名  → 0
```

**反作弊从头到尾没管过这个机器人。** 跑了一整晚,零告警、零踢出。

→ 结论要带条件:**理论风险真实存在,但在这套配置下没有发生。**
别因为这段就以为"装了 Grim 就一定跑不了",也别因为没出事就以为它不存在。

## 一个还没解决的:`mineflayer-tool` 可能无限递归

`collectblock` 依赖并自动加载 `mineflayer-tool`。
`Tool.js:107-137`:当 `itemList.length === 0` 且 `getFromChest: true` 时,
会调 `retrieveTools`(`chestLocations` 默认 `[]`,`Tool.js:58`)→ 立即返回 →
然后**无条件** `yield this.equipForBlock(block, options)` 递归。

看起来是可验证的崩溃级缺陷,**但我们没有复现过**,所以标为待验证。
规避方式:调 `equipForBlock` 时显式传 `getFromChest: false`。

## 版本与环境

- mineflayer 4.39.0 的 `package.json` 里 `engines.node` 是 **`>=22`**;
  我们这台跑的是 **Node v20.19.2**。目前一切正常,但这是个已知的不匹配,记在这里。
- `minecraft-data` 由 mineflayer 锁 `^3.114.0`,不需要单独升级。
