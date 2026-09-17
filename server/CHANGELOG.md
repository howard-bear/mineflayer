# 羊羊服务器变更日志

> **这个文件存在的唯一理由是 Owner 的一句话:「以后好查询 不然你很快就会失忆的」。**
>
> 维护这台服务器的是 AI 助手,而助手的会话记忆会被压缩 —— 今天查清的东西,下一次可能就没了。
> 所以规矩是:**服务器的每一次改动,都要在这里留一行。** 包括改了哪个文件、改前改后、以及**怎么回滚**。
>
> 时间一律用 **JST**(服务器所在时区)。带 `md5` 的地方是为了让下一次能确认"线上跑的是不是这一版"。

---

## 怎么读这个文件

每条至少要有四样东西,少一样就是没写完:

| 要素 | 为什么必须有 |
|---|---|
| **改了什么** | 半年后你不会记得 |
| **改了哪个文件** | 不写就得重新翻一遍服务器 |
| **为什么改** | 决定了以后能不能放心改回去 |
| **怎么回滚** | 出事的时候没人想现场推理 |

---

## 2026-09-17

### 🆕 资源世界:第 6 次起每次 1 金币

**为什么**:Owner 要"象征意义地"收一下,让每天第 6 次之后的随机传送有点成本。

**改哪儿**:`plugins/DeluxeMenus/gui_menus/resworld.yml`
(**不是** ResWorld 插件本身 —— 插件源码已经找不到了,只剩 jar;而且它不依赖 Vault、自己收不了钱、
超过 `daily-limit` 会硬拒,所以只能在菜单层做。)

**怎么做的**:免费按钮(钻石矿石)和付费按钮(金锭)**占同一个格子**,靠 `view_requirement` 二选一:

```yaml
# 免费:%resworld_left% 不等于 '0'
# 付费:%resworld_left% 等于 '0' → 要求 has money 1 → [givepermission] 临时不限次 → res go → 收回
```

`ResWorld/config.yml` 的 `daily-limit: 5` **没有改动** —— 那 5 次仍然是免费额度。

**🔴 上线后立刻出过一次事故,值得单独记**:
第一版**漏了 `priority` 字段**,结果**按钮直接从菜单里消失**,孩子反馈"传送按钮没了",线上坏了约 20 分钟。
DeluxeMenus 官方示例(`requirements_menu.yml:180-229`)写得很清楚:

> `priority` is used in case you have multiple items on the same slot. A lower number equals a higher priority.
> When the requirements aren't met and an item with lower priority occupies the same slot, will it be displayed instead.

同一格子放多个 item **必须写 `priority`**(数字小 = 优先级高)。现在是免费 `priority: 0`、付费 `priority: 1`。

**回滚**:
```bash
# 回到没有收费的原始菜单
sudo cp plugins/DeluxeMenus/gui_menus/resworld.yml.bak-paid-20260917-192730 \
        plugins/DeluxeMenus/gui_menus/resworld.yml
sudo mc-rcon "dm reload"
```

**顺带查清的两条**(以后别再重新试错):
- 本服 **LuckPerms 没挂 PlaceholderAPI 钩子**(活跃钩子里没有它),所以用不了 `%luckperms_*%`
  来判断权限,也没法用它验证 `lp permission settemp` 的效果 → 改用 DeluxeMenus 自带的
  `[givepermission]` / `[takepermission]`(它们是插件内部同步执行的)。
- **`%vault_eco_balance%` 和 `/balance` 的数字对不上**(placeholder 返回 `5.69`,命令说 `$805.68`)
  → 所以**没有**把余额写进菜单说明。给孩子显示一个错的余额比不显示更坏。

---

### AI 玩家小麦:换到 Node 22

**为什么**:mineflayer 从 4.26.0 起声明 `engines.node >= 22`,而 Debian 13 只带 20 —— 一直低于最低版本。

**改哪儿**:systemd drop-in `/etc/systemd/system/mcbot.service.d/node22.conf`。
**没有**加第三方 apt 源、**没有**碰系统的 `/usr/bin/node`(仍是 Debian 的 20)。
官方 tarball 解压到 `/usr/local/lib/nodejs/`,sha256 对过官方 `SHASUMS256.txt`,稳定软链 `node22`。

**回滚**:
```bash
sudo rm /etc/systemd/system/mcbot.service.d/node22.conf
sudo systemctl daemon-reload && sudo systemctl restart mcbot
```

顺带:部署脚本的语法关原来用 `node --check`(拿系统的 v20 去检一份实际跑在 v22 上的文件 ——
**用旧解释器检新语法会静默放过**)。已改成从 systemd 单元里抠出真正的解释器。

---

### AI 玩家小麦:会自己给地盘圈领地了

**为什么**:它的东西**一格保护都没有**,而且已经因此吃过一次亏。

实测查出来的处境(都是当天从服务器读的):
- 它名下**已经有**一块领地 `ClaimData/113.yml`(x −2~6, z 135~143, 81 格)。
  那是 GriefPrevention 的 `AutomaticNewPlayerClaimsRadius: 4` 在它
  **第一次放下箱子的同一秒**自动圈的 —— 它自己不知道,而且后来搬家了,
  所以那块地现在保护的是一片空地。
- 现在的房子 `(-19,63,160)` 4×4、新箱子 `(-18,64,160)`、重生点 `(-17,158)`
  **都在任何领地之外**(21 个 claim 文件逐个算过边界)。
- 而隔壁孩子当天 10:27 UTC 圈了 `x -15~21 / z 156~219`,它的**老箱子** `(-15,63,159)`
  正好落在那块地最西边那一列上 → 右键被 GP 取消、`windowOpen` 不回包 →
  连着 5 次「打不开箱子」,里面十几组木头至今锁着。
- 自动圈地**只对名下零领地的玩家触发**,113 还在,就不会有第二次。

**🔑 实现上最关键的发现**:这台服务器的 GP **支持命令式圈地**。
直接问服务器,它回的是用法串 `/claim [optional radius]`。
所以**不需要**「领金铲子 → 走到角 1 右键 → 走到角 2 右键」那一套
(而且 `land.yml` 那个菜单根本**没有 `open_command`**,金铲子那条路反而更难走)。
一条命令,少了四个会失败的环节。

**改哪儿**:`~/mcbot/bot.real.js` + `~/mcbot/roles.json`
(动作清单 16 → 17 个,多了 `claim_land`。**`roles.json` 是执行闸不是菜单** ——
不加进去整套逻辑就是死码,这条当天已经吃过一次亏)。

**怎么做的**:
- 范围**在运行时从它自己的 `house.json` / `mychest.json` / `home.json` 算**,不写死坐标 ——
  Owner 的指令是「让他自己给自己的地盘圈领地」。
- 半径下限 5:GP 的门槛是 `MinimumArea: 100` + `MinimumWidth: 5`,而 `/claim r` 出来的是
  (2r+1)²,所以 r=5 → 11×11 = 121 格刚好过线。它有 3772 格可用。
- 离目标 >24 格就先 `/home base` 传送 —— 走路预算 15 秒,而实测速度中位只有
  0.86 格/秒(全天 5878 个位移样本),15 秒撑死 36 格,而它经常在 50~150 格外游荡。
- **成败只认 GP 的回执原文**,分类正则逐字来自 `GriefPreventionData/messages.yml`。
  **不看「命令发出去没报错」** —— 那正是同一天在资源世界菜单上栽过的坑
  (「配置加载成功」不等于「玩家看得见」)。
- 撞重叠就**一步挪到位**:把东边余量整个去掉,让领地东边界正好贴在最东那件资产上。
  用真实数据模拟过两轮:第一次 站 (−18,160) `/claim 5` → x −23~−13 **必然重叠**;
  第二次 站 (−21,160) `/claim 5` → x −26~−16,**盖住全部资产、零重叠、121 格** ✅。
  (原来写的「每次往西挪 2 格」要三次、十几分钟才碰对。)

**回滚**:
```bash
# 代码:换回上一版 d8eb936e832a
# 动作清单:
sudo cp ~/mcbot/roles.json.bak-claim-20260917-214106 ~/mcbot/roles.json
sudo systemctl restart mcbot
```

**⚠️ 还没验到的**:部署时是夜里、它血只有 6、离家 58 格 ——
硬规则的三道门槛(白天 / 血>14 / 5 分钟节流)**全部按设计拦住了**,所以还没真跑过一次。
`land.json` 还不存在就是证据。天亮之后才能看到结果。

---

### AI 玩家小麦:加了"做床 + 天黑睡觉"

**为什么**:实测它的死亡有 **61% 发生在重生点 8 格内**(样本 33),而重生点由服务端插件决定
(EssentialsX `respawn-at-home: true`),客户端写任何"别回家"的规则都管不了。
睡觉能从根上拿掉"夜晚"这个变量,而且 `respawn-at-home-bed: true` 让重生点跟着床走。

**改哪儿**:`~/mcbot/bot.real.js` + `~/mcbot/roles.json`(给它的动作清单加了 `sleep`)。
**注意 `roles.json` 是执行闸不是菜单** —— 不加进去的话整套睡觉逻辑是死码。

**效果**:2026-09-17 20:26 JST 第一次真睡着,夜被跳过。它睡的是一张**村庄自然生成的床**
(CoreProtect 里全服没有任何玩家放过床的记录),不是孩子的。

**回滚**:环境变量 `SLEEP_AT_DUSK=0` 一键关掉这套行为,不用改代码;
`roles.json` 的备份是 `roles.json.bak-sleep-20260917-123914`。

---

## 更早的改动(来自助手的笔记,**日期未逐条复核**)

⚠️ 下面这些是从助手的记忆整理的,不是当场从服务器验的 —— 引用时请自己确认一次。

| 时间 | 改动 | 要点 |
|---|---|---|
| 2026-07-19 | 认证换成 nLogin 2.0.18 | 替掉 LibreLogin(它和 Via/Floodgate 一起会静默断连);**不要再装回 LibreLogin** |
| 2026-07-02 | 移除 WorldEdit | Owner 要求(和指南针导航冲突);若重装要锁 ≤7.4.2 并重修指南针 |
| — | EssentialsX 固定 2.21.0 | **不要升到 2.22.0+**,那之后放弃了 1.21.4 支持 |
| — | 开放基岩版 | Geyser + Floodgate,端口 19132;要同时关 Paper 的 `perform-username-validation` 并放宽 nLogin 的名字正则,否则带点号的名字进不来 |
| — | BlueMap 取消管理员密码、49 个资源世界全部上图 | **`render-thread-count` 必须 = 2**;调到 6 会吃掉 11/16 核,玩家卡在「加载地形中」而 TPS 仍显示 20.0 |
| — | FreedomChat 1.7.2 | 治「无法验证聊天消息」那个提示;必须把 `claim-secure-chat-enforced` 设成 `true`,而且要**完整重启**(没有 reload 命令) |
| — | 备份到 Google Drive | 每天 04:00 JST;曾连续 3 天**静默失败**(tar 对热的 plugins 目录返回 rc=1),已改成容忍 rc=1 |

---

## 写新条目时的模板

```markdown
### 〈一句话说清改了什么〉

**为什么**:

**改哪儿**:〈文件路径〉

**怎么做的**:〈关键配置/代码,贴出来〉

**回滚**:
```bash
〈一条命令〉
```

**⚠️ 没核实的**:〈老实列出来〉
```
