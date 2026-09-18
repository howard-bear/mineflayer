# 麦家目标树 —— 照着 MC 进度树重建(设计稿,只读调研,未改任何线上文件)

> 写给:Owner / 实现这张表的会话
> 日期:2026-09-18 · 版本:Java 1.21.4 · 状态:**草稿,等拍板**
> 依据:线上 `scripts.new.json`(29 条脚本)、`目标表-v2/scripts.v2.json`(8G/57M/161J/29A/9T)、`缺的判据和动作.json`、`roles.json`、`prednames.json`、Owner 已定的规矩(记忆 + v2 表里的原话)。

---

## 0. 一页看懂

**为什么现在「做完就站着」**:线上 29 条脚本几乎全在「砍树—存箱子—种麦子—做面包」这一个小圈里,圈转完就没下一件。v2 表把后面一路写到了打龙,但卡在两处:① 缺「会挖矿、会烧东西、会穿甲」这几样最基础的本事,所以石器以后的活**全都开不了工**;② 中间几乎没有「在家附近就能做、做很久也做不完」的活(钓鱼、养牲口、种树、扩田、攒书架),麦娘和麦豆只要麦田一忙完就闲下来。

**这份设计怎么解决**:
1. 用 MC 进度树当骨架(故事 → 下界 → 末地,旁边挂冒险和农牧)。**每个能做的进度 = 一个小目标**,另外再补上「通向这个进度必须先做的准备活」。
2. 每个大目标里都有**一直做不完的长尾活**(田扩到 64→128 格、牲口圈养到 6→12 头、书架 15 个、全家换铁甲……),再加一层「家底常备」(面包、原木、圆石、煤、火把掉下去就补)。这样直到打完龙之前,永远有下一件能做。
3. **只要新增一个判据 `拿到过进度(id)`**,读服务器发给机器人的进度数据,所有「照着进度走」的小目标就有了现成的、不会作假的完成条件。
4. 严格守 Owner 的规矩:只在家附近放方块、不碰别人的东西、不进别人领地、麦豆 24 格内且不打架、打怪按那套规矩、钻石只动 6 颗(箱底 21 颗不碰)、5 个铁锭先给麦娘做头盔。

**数字**:1.21.4 的五个分页一共 **121** 个进度(故事 16、下界 23、末地 9、冒险 44、农牧 29;1.21.6 以后加的几个不算)。
- 设成目标的 **41** 个。其中 5 个今天就有人能拿到(Minecraft、来硬的、钻石!、甜蜜的梦、开荒垦地),其余 36 个要先补动作或判据
- 不设成主动目标、顺带拿到后只验收的:**3** 个(冒险根、怪物猎人、农牧根)
- 故意不做的:**77** 个(理由见第 4.3 节)

设计出 **14 个大目标**(G1 是现有的状态维持层)、**102 个小目标**(其中 10 个是「家底常备」这种掉下去就补的)、**约 95 条脚本**(约 25 条直接沿用线上或 v2 的)。**要新写 21 个动作**(后期再加 v2 已经列过的 7 个)、**约 40 个判据**。前 10 件先写,就能打开大部分小目标(见第 4.1 节)。

---

## 1. Java 1.21.4 进度树(五个分页)

说明:
- 「要求」按 Java 版实际判定写。**标 ⚠️ 的是我不完全确定的地方**,实现前要用服务器里的进度数据核一遍(`/advancement` 命令,或看 `world/advancements/<uuid>.json`)。
- 中文名是凭记忆写的常见简中译名,个别可能和游戏里的不完全一样;以英文名和 id 为准。
- 已核实:**Heart Transplanter**(嘎枝之心)和 **Stay Hydrated!**(干燥恶魂)都是 **1.21.6** 才加的;**Mob Kabob**(长矛)更晚,所以 1.21.4 服务器上都没有。Wiki 汇总页上的「Uh Oh」(硫磺方块)也不是 1.21.4 的内容。这几个都不列。
- 🔑 **很多故事线进度只看「背包里出现过某样东西」**,不管是怎么拿到的。比如从家里箱子拿出一颗钻石就算「钻石!」,拿出一个铁锭就算「来硬的」。这让麦娘和麦豆可以低风险拿到很多进度。

### 1.1 故事线(Minecraft,16 个)

| # | 进度(id) | 中文名 | 父进度 | 要求(Java 实际判定) | 类型 |
|---|---|---|---|---|---|
| 1 | Minecraft `story/root` | Minecraft | — | 背包里有工作台 | 普通 |
| 2 | Stone Age `story/mine_stone` | 石器时代 | 1 | 背包里有圆石(或圆石类:深板岩圆石、黑石) | 普通 |
| 3 | Getting an Upgrade `story/upgrade_tools` | 获得升级 | 2 | 背包里有石镐 | 普通 |
| 4 | Acquire Hardware `story/smelt_iron` | 来硬的 | 3 | 背包里有铁锭 | 普通 |
| 5 | Suit Up `story/obtain_armor` | 整装上阵 | 4 | 背包里有任意一件铁护甲 | 普通 |
| 6 | Hot Stuff `story/lava_bucket` | 热腾腾的 | 4 | 背包里有岩浆桶 | 普通 |
| 7 | Isn't It Iron Pick `story/iron_tools` | 这不是铁镐么 | 4 | 背包里有铁镐 | 普通 |
| 8 | Not Today, Thank You `story/deflect_arrow` | 不吃这套,谢谢 | 5 | 用盾牌挡下一个弹射物 | 普通 |
| 9 | Ice Bucket Challenge `story/form_obsidian` | 冰桶挑战 | 6 | 背包里有黑曜石 | 普通 |
| 10 | Diamonds! `story/mine_diamond` | 钻石! | 7 | 背包里有钻石 | 普通 |
| 11 | We Need to Go Deeper `story/enter_the_nether` | 勇往直下 | 9 | 进入下界 | 普通 |
| 12 | Cover Me with Diamonds `story/shiny_gear` | 用钻石包裹我 | 10 | 背包里有任意一件钻石护甲 | 普通 |
| 13 | Enchanter `story/enchant_item` | 附魔师 | 10 | 在附魔台附魔一件物品 | 普通 |
| 14 | Zombie Doctor `story/cure_zombie_villager` | 僵尸科医生 | 11 | 治愈僵尸村民(虚弱状态下喂金苹果,等它变回村民) | 目标 |
| 15 | Eye Spy `story/follow_ender_eye` | 隔墙有眼 | 11 | 进入要塞 | 普通 |
| 16 | The End? `story/enter_the_end` | 结束了? | 15 | 进入末地 | 普通 |

### 1.2 下界(Nether,23 个)

| # | 进度(id) | 中文名 | 父进度 | 要求 | 类型 |
|---|---|---|---|---|---|
| 1 | Nether `nether/root` | 下界 | — | 进入下界 | 普通 |
| 2 | Return to Sender `nether/return_to_sender` | 见鬼去吧 | 1 | 用火球打死恶魂 | 挑战 |
| 3 | Uneasy Alliance `nether/uneasy_alliance` | 不稳定的同盟 | 2 | 把恶魂带回主世界并杀死 | 挑战 |
| 4 | Those Were the Days `nether/find_bastion` | 光辉岁月 | 1 | 进入堡垒遗迹 | 普通 |
| 5 | War Pigs `nether/loot_bastion` | 猪猪战争 | 4 | 打开堡垒遗迹里的箱子 | 普通 |
| 6 | Hidden in the Depths `nether/obtain_ancient_debris` | 深藏不露 | 1 | 背包里有远古残骸 | 普通 |
| 7 | Cover Me in Debris `nether/netherite_armor` | 残骸裹身 | 6 | 背包里有全套下界合金甲 | 挑战 |
| 8 | Subspace Bubble `nether/fast_travel` | 曲速泡 | 1 | 借下界在主世界移动 7 km | 挑战 |
| 9 | A Terrible Fortress `nether/find_fortress` | 阴森的要塞 | 1 | 进入下界要塞 | 普通 |
| 10 | Spooky Scary Skeleton `nether/get_wither_skull` | 惊悚恐怖骷髅头 | 9 | 背包里有凋灵骷髅头颅 | 普通 |
| 11 | Withering Heights `nether/summon_wither` | 凋零山庄 | 10 | 召唤凋灵 | 普通 |
| 12 | Bring Home the Beacon `nether/create_beacon` | 带信标回家 | 11 | 放下信标并让它生效 | 普通 |
| 13 | Beaconator `nether/create_full_beacon` | 信标工程师 | 12 | 满级信标 | 目标 |
| 14 | Into Fire `nether/obtain_blaze_rod` | 与火共舞 | 9 | 背包里有烈焰棒 | 普通 |
| 15 | Local Brewery `nether/brew_potion` | 本地酿造厂 | 14 | 从酿造台里取出一瓶药水 | 普通 |
| 16 | A Furious Cocktail `nether/all_potions` | 狂乱的鸡尾酒 | 15 | 同时有所有药水效果 | 挑战 |
| 17 | How Did We Get Here? `nether/all_effects` | 为什么会变成这样呢? | 16 ⚠️ | 同时有所有状态效果(隐藏) | 挑战 |
| 18 | Who is Cutting Onions? `nether/obtain_crying_obsidian` | 谁在切洋葱? | 1 | 背包里有哭泣的黑曜石 | 普通 |
| 19 | Not Quite "Nine" Lives `nether/charge_respawn_anchor` | 锚定九生 ⚠️译名 | 18 | 把重生锚充满 | 普通 |
| 20 | Oh Shiny `nether/distract_piglin` | 金光闪闪 | 1 | 用金子让猪灵分心 | 普通 |
| 21 | This Boat Has Legs `nether/ride_strider` | 这船有腿 | 1 | 用诡异菌钓竿骑炽足兽 | 普通 |
| 22 | Feels Like Home `nether/ride_strider_in_overworld_lava` | 温暖如家 | 21 | 在主世界岩浆湖上骑炽足兽走 50 格 | 普通 |
| 23 | Hot Tourist Destinations `nether/explore_nether` | 热门景点 | 21 ⚠️ | 去过下界所有生物群系 | 挑战 |

### 1.3 末地(The End,9 个)

| # | 进度(id) | 中文名 | 父进度 | 要求 | 类型 |
|---|---|---|---|---|---|
| 1 | The End `end/root` | 末地 | — | 进入末地 | 普通 |
| 2 | Free the End `end/kill_dragon` | 解放末地 | 1 | 杀死末影龙 | 普通 |
| 3 | The Next Generation `end/dragon_egg` | 下一世代 | 2 | 背包里有龙蛋 | 目标 |
| 4 | Remote Getaway `end/enter_end_gateway` | 远程折跃 | 2 | 穿过末地折跃门 | 普通 |
| 5 | The End... Again... `end/respawn_dragon` | 再战末影龙 | 2 | 重新召唤末影龙 | 目标 |
| 6 | You Need a Mint `end/dragon_breath` | 你需要来点薄荷糖 | 2 | 用玻璃瓶收集龙息 | 目标 |
| 7 | The City at the End of the Game `end/find_end_city` | 在游戏尽头的城市 | 4 | 进入末地城 | 普通 |
| 8 | Sky's the Limit `end/elytra` | 天空即为极限 | 7 | 背包里有鞘翅 | 目标 |
| 9 | Great View From Up Here `end/levitate` | 这上面的风景不错 | 7 | 被潜影贝弄得飘起 50 格 | 挑战 |

### 1.4 冒险(Adventure,44 个,1.21.4 已有的)

| # | 进度(id) | 中文名 | 父进度 | 要求 | 类型 |
|---|---|---|---|---|---|
| 1 | Adventure `adventure/root` | 冒险 | — | 杀死任意生物,或被任意生物杀死 | 普通 |
| 2 | Voluntary Exile `adventure/voluntary_exile` | 自愿流放 | 1 | 杀死袭击队长(隐藏) | 普通 |
| 3 | Hero of the Village `adventure/hero_of_the_village` | 村庄英雄 | 2 | 成功守住村庄、打赢一次袭击 | 挑战 |
| 4 | Is It a Bird? `adventure/spyglass_at_parrot` | 那是鸟吗? | 1 | 用望远镜看鹦鹉 | 普通 |
| 5 | Is It a Balloon? `adventure/spyglass_at_ghast` | 那是气球吗? | 4 | 用望远镜看恶魂 | 普通 |
| 6 | Is It a Plane? `adventure/spyglass_at_dragon` | 那是飞机吗? | 5 | 用望远镜看末影龙 | 普通 |
| 7 | Monster Hunter `adventure/kill_a_mob` | 怪物猎人 | 1 | 杀死任意敌对生物 | 普通 |
| 8 | Monsters Hunted `adventure/kill_all_mobs` | 资深怪物猎人 | 7 | 每种敌对生物各杀一只 | 挑战 |
| 9 | Take Aim `adventure/shoot_arrow` | 瞄准目标 | 7 | 用箭射中任意东西 | 普通 |
| 10 | Sniper Duel `adventure/sniper_duel` | 狙击手的对决 | 9 | 在 50 格外射死骷髅 | 挑战 |
| 11 | Bullseye `adventure/bullseye` | 正中靶心 | 9 | 在 30 格外射中标靶的正中心 | 挑战 |
| 12 | A Throwaway Joke `adventure/throw_trident` | 抛掷玩笑 | 7 | 把三叉戟扔向某个东西 | 普通 |
| 13 | Very Very Frightening `adventure/very_very_frightening` | 非常非常恐怖 | 12 | 用引雷三叉戟劈村民 | 普通 |
| 14 | Postmortal `adventure/totem_of_undying` | 超越生死 | 7 | 用不死图腾逃过一死 | 目标 |
| 15 | It Spreads `adventure/kill_mob_near_sculk_catalyst` | 它蔓延了 | 7 | 在幽匿催发体附近杀生物 | 挑战 |
| 16 | What a Deal! `adventure/trade` | 成交! | 1 | 和村民交易 | 普通 |
| 17 | Star Trader `adventure/trade_at_world_height` | 星际商人 | 16 | 在建筑高度上限和村民交易 | 普通 |
| 18 | Hired Help `adventure/summon_iron_golem` | 招募援兵 | 16 | 造一个铁傀儡 | 目标 |
| 19 | Sticky Situation `adventure/honey_block_slide` | 胶着状态 | 1 | 贴着蜂蜜块滑落 | 普通 |
| 20 | Ol' Betsy `adventure/ol_betsy` | 老乡,开弓没有回头箭 ⚠️译名 | 1 | 用弩射击 | 普通 |
| 21 | Who's the Pillager Now? `adventure/whos_the_pillager_now` | 现在谁才是掠夺者? | 20 | 用弩射死掠夺者 | 普通 |
| 22 | Two Birds, One Arrow `adventure/two_birds_one_arrow` | 一箭双雕 | 20 | 用穿透箭一次射死两只幻翼 | 挑战 |
| 23 | Arbalistic `adventure/arbalistic` | 劲弩手 | 20 | 弩的一次射击杀死五种不同的生物(隐藏) | 挑战 |
| 24 | Surge Protector `adventure/lightning_rod_with_villager_no_fire` | 电涌保护器 | 1 | 用避雷针保护村民不被雷劈又不起火 | 普通 |
| 25 | Caves & Cliffs `adventure/fall_from_world_height` | 上山下海 ⚠️译名 | 1 | 从建筑上限自由落体到世界底部并活下来 | 普通 |
| 26 | Sneak 100 `adventure/avoid_vibration` | 潜行 100 级 | 1 | 在幽匿感测体或监守者附近潜行不被察觉 | 普通 |
| 27 | Sweet Dreams `adventure/sleep_in_bed` | 甜蜜的梦 | 1 | 睡床改变重生点 | 普通 |
| 28 | Adventuring Time `adventure/adventuring_time` | 探索的时光 | 27 | 去过所有(主世界)生物群系 | 挑战 |
| 29 | Sound of Music `adventure/play_jukebox_in_meadows` | 音乐之声 | 27 | 在草甸用唱片机放唱片 | 普通 |
| 30 | Light as a Rabbit `adventure/walk_on_powder_snow_with_leather_boots` | 轻功雪上飘 | 27 | 穿皮革靴走在细雪上 | 普通 |
| 31 | Country Lode, Take Me Home `adventure/use_lodestone` | 天涯共此石 ⚠️译名 | 1 | 对着磁石用指南针 | 普通 |
| 32 | The Power of Books `adventure/read_power_of_chiseled_bookshelf` | 知识就是力量 ⚠️译名 | 1 | 用比较器读出雕纹书架的信号 | 普通 |
| 33 | Crafting a New Look `adventure/trim_with_any_armor_pattern` | 旧貌换新颜 | 1 | 在锻造台给护甲加纹饰 | 普通 |
| 34 | Smithing with Style `adventure/trim_with_all_exclusive_armor_patterns` | 化腐朽为神奇 ⚠️译名 | 33 | 用齐几种稀有纹饰模板 | 挑战 |
| 35 | Respecting the Remnants `adventure/salvage_sherd` | 探古寻源 ⚠️译名 | 1 | 用刷子刷可疑方块拿到陶片 | 普通 |
| 36 | Careful Restoration `adventure/craft_decorated_pot_using_only_sherds` | 精心修复 | 35 | 用 4 块陶片做饰纹陶罐 | 普通 |
| 37 | Minecraft: Trial(s) Edition `adventure/minecraft_trials_edition` | Minecraft:试炼版! | 1 | 走进试炼密室 | 普通 |
| 38 | Under Lock and Key `adventure/under_lock_and_key` | 锁中之物 ⚠️译名 | 37 | 用试炼钥匙打开宝库 | 普通 |
| 39 | Revaulting `adventure/revaulting` | 厄运宝库 ⚠️译名 | 38 | 用不祥试炼钥匙打开不祥宝库 | 目标 |
| 40 | Lighten Up `adventure/lighten_up` | 焕然一新 ⚠️译名 | 37 | 用斧刮铜灯让它变亮 | 普通 |
| 41 | Who Needs Rockets? `adventure/who_needs_rockets` | 还要啥火箭? ⚠️译名 | 37 | 用风弹把自己弹高 8 格 | 普通 |
| 42 | Blowback / Over-Overkill / Crafters Crafting Crafters | — | 37 / 37 / 1 | 用反弹的风弹打死旋风人 / 用重锤一击打出 50 颗心的伤害 / 在合成器旁看它合成一个合成器 | 挑战 / 挑战 / 普通 |

(Isn't It Scute? 见 1.5 节,⚠️ 它在「冒险」还是「农牧」分页我不确定,Wiki 两处说法不一。不影响设计。)

### 1.5 农牧(Husbandry,1.21.4 已有的 29 个)

| # | 进度(id) | 中文名 | 父进度 | 要求 | 类型 |
|---|---|---|---|---|---|
| 1 | Husbandry `husbandry/root` | 农牧业 | — | 吃任意一样能吃的东西 | 普通 |
| 2 | A Seedy Place `husbandry/plant_seed` | 开荒垦地 | 1 | 种下一颗种子(小麦/南瓜/西瓜/甜菜/火把花/瓶子草) | 普通 |
| 3 | A Balanced Diet `husbandry/balanced_diet` | 均衡饮食 | 2 | 所有能吃的东西都吃过一遍 | 挑战 |
| 4 | Serious Dedication `husbandry/obtain_netherite_hoe` | 终极奉献 | 2 | 用下界合金锭升级锄头 | 挑战 |
| 5 | Planting the Past `husbandry/plant_any_sniffer_seed` | 种下往昔 ⚠️译名 | 2 ⚠️ | 种下嗅探兽找到的种子 | 普通 |
| 6 | The Parrots and the Bats `husbandry/breed_an_animal` | 我从哪儿来? | 1 | 让两只动物繁殖 | 普通 |
| 7 | Two by Two `husbandry/bred_all_animals` | 成双成对 | 6 | 所有能繁殖的动物都繁殖过 | 挑战 |
| 8 | Best Friends Forever `husbandry/tame_an_animal` | 永恒的伙伴 | 1 | 驯服一只动物 | 普通 |
| 9 | A Complete Catalogue `husbandry/complete_catalogue` | 百猫全书 | 8 | 驯服所有花色的猫 | 挑战 |
| 10 | The Whole Pack `husbandry/whole_pack` | 狼群大团结 ⚠️译名 | 8 | 驯服所有种类的狼 | 挑战 |
| 11 | Good as New `husbandry/repair_wolf_armor` ⚠️ | 完好如初 | 8 | 用犰狳鳞甲修好受损的狼铠 | 普通 |
| 12 | Shear Brilliance `husbandry/remove_wolf_armor` ⚠️ | 剪之有道 ⚠️译名 | 8 | 用剪刀给狼脱下狼铠 | 普通 |
| 13 | Fishy Business `husbandry/fishy_business` | 腥味十足的生意 | 1 | 钓到一条鱼 | 普通 |
| 14 | Tactical Fishing `husbandry/tactical_fishing` | 战术性钓鱼 | 13 | 不用钓竿,用桶抓一条鱼 | 普通 |
| 15 | The Cutest Predator `husbandry/axolotl_in_a_bucket` | 最萌捕食者 | 14 | 用桶抓一只美西螈 | 普通 |
| 16 | The Healing Power of Friendship! `husbandry/kill_axolotl_target` | 友谊的治愈力! | 15 | 和美西螈并肩作战并赢下来 | 普通 |
| 17 | Bee Our Guest `husbandry/safely_harvest_honey` | 蜂情小说 ⚠️译名 | 1 | 在营火上方用玻璃瓶从蜂巢取蜂蜜,不惹怒蜜蜂 | 普通 |
| 18 | Total Beelocation `husbandry/silk_touch_nest` | 举巢搬迁 | 1 | 用精准采集把住着 3 只蜜蜂的巢搬走 | 普通 |
| 19 | Wax On `husbandry/wax_on` | 涂蜡 | 17 | 给铜块涂蜡 | 普通 |
| 20 | Wax Off `husbandry/wax_off` | 脱蜡 | 19 | 把铜块上的蜡刮掉 | 普通 |
| 21 | Whatever Floats Your Goat! `husbandry/ride_a_boat_with_a_goat` | 羊帆起航 ⚠️译名 | 1 | 和山羊坐同一条船 | 普通 |
| 22 | Glow and Behold! `husbandry/make_a_sign_glow` | 闪闪生辉! | 1 | 让告示牌的字发光 | 普通 |
| 23 | Bukkit Bukkit `husbandry/tadpole_in_a_bucket` | 蝌蚪带回家 ⚠️译名 | 1 | 用桶抓一只蝌蚪 | 普通 |
| 24 | When the Squad Hops into Town `husbandry/leash_all_frog_variants` | 呱呱队出动 ⚠️译名 | 23 | 三种青蛙都拴过绳 | 普通 |
| 25 | You've Got a Friend in Me `husbandry/allay_deliver_item_to_player` | 我的好朋友 ⚠️译名 | 1 | 让悦灵给你送东西 | 普通 |
| 26 | Birthday Song `husbandry/allay_deliver_cake_to_note_block` | 生日快乐歌 | 25 | 让悦灵把蛋糕送到音符盒旁 | 普通 |
| 27 | Smells Interesting `husbandry/obtain_sniffer_egg` | 气味很有趣 ⚠️译名 | 1 | 拿到嗅探兽蛋 | 普通 |
| 28 | Little Sniffs `husbandry/feed_snifflet` | 小小嗅探兽 | 27 | 喂小嗅探兽 | 普通 |
| 29 | Isn't It Scute? `husbandry/brush_armadillo` ⚠️分页 | 刷子刷刷 ⚠️译名 | 1 | 用刷子从犰狳身上刷下鳞甲 | 普通 |

---

## 2. 每个进度:麦家今天能不能做、归谁

图例:
- 🟢 **能做**:今天就有的动作和判据就够了(最多差一个「只验收」的判据)
- 🟡 **缺东西才能做**:要补动作或判据(括号里写缺什么)
- 🔴 **不适合 / 违反规矩**:要碰别人的东西、打真人、搞破坏,或者对孩子太危险,或者投入太大、不值
- 负责人:**麦**=小麦(儿子,出门干重活)· **娘**=麦娘(妻子,守家做后勤)· **豆**=麦豆(孩子,24 格内、不打架)

### 2.1 故事线

| 进度 | 判定 | 缺什么 / 为什么 | 负责人 |
|---|---|---|---|
| Minecraft | 🟢 麦(大概已经拿到)/ 🟡 娘豆 | 娘:`craft` 已有,只差完成判据 `拿到过进度`;豆:做工作台不在 Owner 批的清单里,要 Owner 点头 | 麦 娘 豆 |
| Stone Age | 🟡 | 缺 `mine` 挖矿动作、去资源世界的动作;娘豆从箱子里拿一块圆石就算(🟢 等箱子里有圆石以后) | 麦(挖)、娘豆(拿) |
| Getting an Upgrade | 🟡 | 等圆石;`craft stone_pickaxe` 大概率能用(⚠️ 3×3 配方要站在工作台旁,需要实测) | 麦(娘豆也可以各做一把) |
| Acquire Hardware | 🟢 娘豆 / 🟡 麦 | 箱子里现在就有 5 个铁锭:**娘拿出来做头盔时就算拿到**;麦自己挖铁要 `mine` + `smelt` | 娘 → 麦 豆 |
| Suit Up | 🟡 | 缺 `wear_armor`(不穿其实也算:进度只看背包里有没有铁护甲 ⚠️,但穿上才有用);娘:5 铁锭 → 铁头盔 | 娘(先)→ 麦 |
| Hot Stuff | 🟡 | 缺 `fill_bucket`;装岩浆有危险,只让小麦在资源世界装,**装回来当熔炉燃料**,不往地上倒 | 麦 |
| Isn't It Iron Pick | 🟡 | 铁要自己挖(那 5 个铁锭先给娘做头盔) | 麦 |
| Not Today, Thank You | 🟡 | 缺 `raise_shield` 举盾动作 + 盾牌;和 A6「挡箭跑开」合在一起做 | 麦 |
| Ice Bucket Challenge | 🟡 | 要钻石镐 + 在资源世界找现成的黑曜石(岩浆遇水形成的、废弃传送门的) | 麦 |
| Diamonds! | 🟢 | 从箱子领那 2 颗做剑的钻石时就拿到了。Owner 已批三人各领 2 颗 | 麦 娘 豆 |
| We Need to Go Deeper | 🟡 | 缺 `build_portal`、`use_portal`;**门放在哪要 Owner 批** | 麦 |
| Cover Me with Diamonds | 🟡 | **不能动箱底那 21 颗**:只能用小麦自己挖的钻石 | 麦 |
| Enchanter | 🟡 | 附魔台(2 钻石 + 4 黑曜石 + 1 书)+ 青金石 + 经验;缺 `enchant` | 娘(在家附魔)、麦(备料) |
| Zombie Doctor | 🔴 | 要用虚弱药水 + 金苹果,村民一般在村子或别人家里;弄不好会害死别人的村民 | — |
| Eye Spy | 🟡 | 末影之眼、`throw_eye`、下到要塞 | 麦 |
| The End? | 🟡 | 填末地门框、进末地 | 麦 |

### 2.2 下界

| 进度 | 判定 | 缺什么 / 为什么 | 负责人 |
|---|---|---|---|
| Nether | 🟡 | 和「勇往直下」一起拿 | 麦 |
| A Terrible Fortress | 🟡 | 缺下界探路 + 判据 `记得下界要塞` | 麦 |
| Into Fire | 🟡 | 按打怪规矩烈焰人不算普通怪 → 要给「打烈焰人」单独定规矩(要 Owner 定) | 麦 |
| Local Brewery | 🟡 | 酿造台 + 玻璃瓶 + 下界疣 + 缺 `brew`;在家做,**很适合麦娘** | 娘 |
| Oh Shiny | 🟡 | 戴金头盔扔一个金锭给猪灵;缺 `drop_item` 丢东西 | 麦 |
| Hidden in the Depths | 🟡(很晚) | 下界深处挖矿,岩浆多,风险高;往后放,可以不做 | 麦 |
| Who is Cutting Onions? | 🟡(很晚) | 废弃传送门的哭泣黑曜石(要钻石镐),在资源世界挖 | 麦 |
| Return to Sender / Uneasy Alliance | 🔴 | 要和恶魂硬碰硬,违反「只打 1~2 只普通近战怪」 | — |
| Those Were the Days / War Pigs | 🔴 | 堡垒遗迹里猪灵蛮兵多,极危险 | — |
| Cover Me in Debris | 🔴 | 要堡垒遗迹才有的锻造模板 + 大量远古残骸 | — |
| Subspace Bubble | 🔴 | 在下界跑 875 格以上,风险高、没用处 | — |
| Spooky Scary Skeleton / Withering Heights / Bring Home the Beacon / Beaconator | 🔴 | 凋灵会炸地形,搞不好就毁了公共区域 | — |
| A Furious Cocktail / How Did We Get Here? | 🔴 | 要几乎所有药水和状态效果,极难,还要主动挨打 | — |
| Not Quite "Nine" Lives | 🔴 | 重生锚在主世界用会爆炸;没必要 | — |
| This Boat Has Legs / Feels Like Home / Hot Tourist Destinations | 🔴 | 在岩浆上骑炽足兽、跑遍下界,风险高、没用处 | — |

### 2.3 末地

| 进度 | 判定 | 缺什么 / 为什么 | 负责人 |
|---|---|---|---|
| The End | 🟡 | 和「结束了?」一起拿 | 麦 |
| Free the End | 🟡 | 缺 `dragon_fight`;龙如果已经被别人打死,要 Owner 批准复活 | 麦 |
| The End... Again... | 🟡(要 Owner 批) | 复活龙会影响全服所有人,必须 Owner 同意;末地水晶要恶魂之泪,很难拿 | 麦 |
| You Need a Mint | 🟡(顺手) | 打龙时拿玻璃瓶装龙息;缺 `bottle_breath` | 麦 |
| Remote Getaway | 🟡(要 Owner 批) | 往折跃门扔末影珍珠;过去以后外岛有虚空和潜影贝 | 麦 |
| The Next Generation | 🔴 | 龙蛋只有第一次打龙时有,服务器上多半早被人拿走;就算有,也算「别人也想要的公共物」 | — |
| The City at the End… / Sky's the Limit / Great View… | 🔴 | 末地城有潜影贝、会飘、会掉进虚空 | — |

### 2.4 冒险

| 进度 | 判定 | 缺什么 / 为什么 | 负责人 |
|---|---|---|---|
| Adventure(根) | 🟢 | 杀任意生物(打猎就算)或被杀;不单独设目标,只验收 | 麦(豆别特意去拿) |
| Sweet Dreams | 🟢 麦 / 🟡 娘豆 | 娘豆 `sleep` 没放行;还要有自己的床 | 麦 娘 豆 |
| Monster Hunter | 🟢 麦 | 按打怪规矩顺带就拿到。**不做成「主动去找怪打」的目标**;娘豆在全家有剑有甲以后由反射层顺带拿 | 麦(娘豆顺带) |
| Take Aim | 🟡 | 弓、箭、缺 `shoot_bow`;远远射比贴身砍更安全 | 麦 |
| Ol' Betsy | 🟡 | 弩(要 1 铁 + 绊线钩)、`shoot_bow` 也能用来射弩 | 麦 |
| Bullseye | 🟡(长尾) | 家门口放一个标靶(要红石),站 30 格外射;安全又能练手 | 麦 |
| Is It a Bird? / Is It a Balloon? / Is It a Plane? | 🟡 | 望远镜(2 铜锭 + 1 紫水晶碎片)+ 缺 `spyglass_look`;鹦鹉在丛林,恶魂在下界,龙在末地,都是顺路拿 | 麦 |
| Light as a Rabbit | 🟡 | 皮革靴 + 雪坡上的细雪;在资源世界找 | 麦 |
| Respecting the Remnants / Careful Restoration | 🟡(长尾) | 刷子 + 可疑的沙子或沙砾;**只在资源世界刷**(沙漠神殿有 TNT 机关,不去) | 麦 |
| What a Deal! | 🔴(先不做) | 村民多半在村子里或别人家里;交易本身无害,但要找「野外没人的村子」,开不了这个头 | — |
| Hired Help / Star Trader | 🔴 | 铁傀儡要 36 个铁、会乱打;在建筑上限交易要把村民运上去 | — |
| Voluntary Exile / Hero of the Village / Who's the Pillager Now? | 🔴 | 杀了袭击队长会给村子招来袭击,危险,还会连累别人的村子 | — |
| Two Birds, One Arrow / Arbalistic / Sniper Duel | 🔴 | 附魔弩 + 高难度射击;幻翼只在长时间不睡觉时出现(我们要天天睡) | — |
| Monsters Hunted | 🔴 | 要打监守者、远古守卫者、凋灵…… | — |
| A Throwaway Joke / Very Very Frightening | 🔴 | 三叉戟要打溺尸(在水里,违反规矩);劈村民是伤害村民 | — |
| Postmortal | 🔴 | 不死图腾要打唤魔者(林地府邸或袭击) | — |
| It Spreads / Sneak 100 | 🔴 | 远古城市里有监守者,碰上就死 | — |
| Caves & Cliffs | 🔴 | 从建筑上限跳下去,专门找死 | — |
| Surge Protector | 🔴 | 要在村民旁边放避雷针等雷暴,要碰村子 | — |
| Sticky Situation | 🔴(不值) | 要蜂蜜块(要营火和蜂巢),没用处 | — |
| Adventuring Time | 🔴 | 要跑遍所有生物群系,会走进别人的地盘 | — |
| Sound of Music | 🔴 | 唱片只能从别处的箱子里找,或者让骷髅射死苦力怕 | — |
| Country Lode, Take Me Home | 🔴(很晚) | 磁石要下界合金锭 | — |
| The Power of Books | 🔴(不值) | 要做红石读书架,没用处 | — |
| Crafting a New Look / Smithing with Style | 🔴 | 纹饰模板在各种遗迹里,要去翻箱子 | — |
| 试炼密室这一整组(Trial(s) Edition、Under Lock and Key、Revaulting、Lighten Up、Who Needs Rockets?、Blowback、Over-Overkill) | 🔴 | 刷怪笼一次出好几只旋风人、骷髅,违反「最多 1~2 只普通怪」 | — |
| Crafters Crafting Crafters | 🔴(不值) | 要搭红石电路;以后想要可以再加 | — |

### 2.5 农牧

| 进度 | 判定 | 缺什么 / 为什么 | 负责人 |
|---|---|---|---|
| Husbandry(根) | 🟢 | 吃东西就算,三个人大概都已经拿到;只验收 | 麦 娘 豆 |
| A Seedy Place | 🟢 娘 / 🟡 豆 | 娘已经在种;豆要放行 `plant_seeds`,还得先补「自家田登记」(记忆里记着:豆的家和娘的田中心不一样,会扫到别人的地) | 娘 豆 |
| Fishy Business | 🟡 | 钓竿(3 木棍 + 2 线,箱子里有线)+ 缺 `fish` + 判据「家附近能钓鱼的水」 | 豆(主)娘 |
| The Parrots and the Bats | 🟡 | 缺 `breed`,还要先把牲口弄回家圈起来(缺 `build_pen` 和 `lure_animal`) | 娘 豆 |
| Tactical Fishing | 🟡 | 水桶 + 缺 `bucket_mob`(用桶舀鱼) | 娘 |
| Best Friends Forever | 🟡(要 Owner 批) | 用骨头驯狼。狼会跟着主人打架、会跑进别人的地盘;要 Owner 点头,驯好了就让它坐在家里 | 麦 |
| Isn't It Scute? | 🟡(长尾) | 刷子 + 在热带草原找犰狳;在资源世界找 | 麦 |
| A Balanced Diet | 🔴 | 要吃附魔金苹果、紫颂果、河豚、毒马铃薯……;只做「家里常备 3 种吃的」 | — |
| Serious Dedication | 🔴 | 升级模板只有堡垒遗迹里有 | — |
| Two by Two | 🔴 | 要繁殖所有动物(嗅探兽、骆驼、犰狳、疣猪兽……);只繁殖牛羊鸡 | — |
| A Complete Catalogue / The Whole Pack / Good as New / Shear Brilliance | 🔴 | 要驯齐所有花色的猫和狼、要狼铠 | — |
| The Cutest Predator / The Healing Power of Friendship! | 🔴 | 美西螈在繁茂洞穴深处,还要一起在水里打仗 | — |
| Bee Our Guest / Wax On / Wax Off / Total Beelocation | 🔴(先不做) | 要在别人可能在用的蜂巢下面放营火;要精准采集附魔 | — |
| Whatever Floats Your Goat! | 🔴(不值) | 山羊会把人顶下山 | — |
| Glow and Behold! | 🔴 | 发光墨囊要去深水里打发光鱿鱼 | — |
| Bukkit Bukkit / When the Squad Hops into Town | 🔴(不值) | 沼泽里抓蝌蚪、给青蛙拴绳,没用处 | — |
| You've Got a Friend in Me / Birthday Song | 🔴 | 悦灵在掠夺者前哨站和林地府邸,都是危险的地方 | — |
| Smells Interesting / Little Sniffs / Planting the Past | 🔴 | 嗅探兽蛋要去海底刷可疑的沙子 | — |

**小结**:121 个进度 = 设成目标的 41 个(故事 15、下界 5、末地 5、冒险 10、农牧 6)+ 只验收的 3 个 + 不做的 77 个(故事 1、下界 18、末地 4、冒险 32、农牧 22)。

---

## 3. 目标树

### 3.0 约定

**优先级**:数字越小越先做。先比大目标,大目标一样再比小目标。同一档里有两件以上能做的,**才问一次模型**,其他情况都由代码直接排。

**前置**:小目标之间是有向无环图(前面的做完才开后面的,不会绕回来),沿着进度的「父 → 子」画。前置沿用 v2 的「锁存」规则(做完一次就一直算做完,后台可以重置),以及「**前置判断不了 = 不挡路**」。

**五道共用的安全门**(写在「还要满足」里,引擎展开成一条条判据,不用每条脚本手抄):

| 门 | 展开以后的判据 | 用在哪 |
|---|---|---|
| 【白天门】 | 血量 ≥ 14、饱食度 ≥ 8、天黑了 = 0、**8格内怪数** = 0(新判据,替换现在读错字段、一直返回 0 的「8格内有怪」) | 所有在外面干活的脚本 |
| 【出门门】 | 【白天门】+ **离天黑秒数** ≥ 300(新)+ 背包空格 ≥ 6 + **身上有(吃的)** ≥ 4(新) | 离家超过 32 格的脚本 |
| 【资源世界门】 | 【出门门】+ **资源世界今天剩余次数** ≥ 1(新)+ **离定时重启分钟数** ≥ 30(新,每天 05:00 JST 重启)+ **最好的镐等级** ≥ 1(新) | 所有去资源世界的脚本 |
| 【麦豆门】 | 离家距离 ≤ 24、天黑了 = 0、血量 ≥ 16、**离最近真人玩家距离** ≥ 16(新) | 麦豆的每一条脚本 |
| 【放方块门】 | 离家距离 ≤ 24、**脚下是别人领地** = 0(新)、沿用盖房时定的硬约束 ①~⑨(不堵自己、不堵门、自家箱子正上方永远空着……) | 所有要放方块的脚本 |

**新增判据**(用得最多、要最先写的几个,是带参数的通用判据):

| 新判据 | 一句话定义 |
|---|---|
| `身上有(物品)` | 背包里这样东西的数量。可以写具体物品(`钻石`),也可以写一类(`吃的`、`任意木板`、`粗铁`) |
| `家里有(物品)` | 麦家所有共用箱子里这样东西的数量(读 family.json 里记的箱子内容)。**钻石自动减掉 21 颗保底;铁锭在麦娘做出头盔前自动减掉 5 个** |
| `拿到过进度(id)` | 我自己有没有拿到这个进度(0/1)。数据来源:服务器登录时和每次进度变化时发给客户端的进度数据包。⚠️ 要先实测 mineflayer 4.39 在 1.21.4 上能不能收到;收不到就退回用「我们自己记的账」 |
| `全家拿到过进度(id)` | 三个人里拿到这个进度的有几个 |
| `最好的镐等级` / `最好的剑等级` | 身上和家里加起来最好的一把:0 没有、1 木或金、2 石、3 铁、4 钻石、5 下界合金 |
| `穿着的护甲件数`、`在线家人里护甲空槽数` | 身上 4 个护甲槽里有几个不空;全家在线的人一共还空着几格 |
| `全家都有剑和护甲` | 三个人都有剑、4 格护甲都不空 → 1。**这是麦豆可以还手的开关**(Owner 定的规矩) |
| `在主世界` / `在资源世界` / `在下界` / `在末地` | 我现在在哪个维度 |
| `家N格内有(方块)` | 家周围 N 格内有几个这种方块(熔炉、火把、床、酿造台、附魔台、围栏……) |
| `圈里的动物(种类)` | 自家圈里有几只这种动物(只数没有名字、没拴绳、在我们自己围栏里的) |
| `Owner批准(事项)` | 后台开关,0/1。事项:`资源世界`、`下界门位置`、`驯狼`、`复活末影龙`、`麦豆做东西清单扩大`、`资源世界放方块` |
| `我领过钻石` | 代码记账,每个人一辈子最多领 2 颗 |

**新增动作**(用得最多的):`mine`(挖矿)、`go_world`(去资源世界 / 回主世界)、`smelt`(烧东西)、`place_at_home`(在家附近放方块)、`wear_armor`(穿护甲)、`fish`(钓鱼)、`fill_bucket`(装水或岩浆)、`breed`(喂食繁殖)、`lure_animal`(拿着吃的把牲口引回家)、`build_pen`(围牲口圈)、`plant`(种甘蔗、树苗)、`shoot_bow`(射箭)、`raise_shield`(举盾)、`brew`(酿药)、`enchant`(附魔),还有后期的传送门、要塞、末地那几个(沿用 v2 的名字)。每个的定义见第 4.2 节。

**要改的现有动作**:
- `store_items` 和 `take_from_chest` 要允许存取**剑、盔甲、工具**。现在剑存不进箱子,于是家里人之间递不了装备,每个人都只能自己做。
- `hunt` 加护栏:**不打有名字的、拴着绳的、在别人围栏里的、在别人领地里的动物**。⚠️ 我没法确认现在的 `hunt` 有没有这层判断,上线打牛任务之前必须先核实。
- `craft`:麦豆的「能做的东西」清单,现在 Owner 批的是吃的、木板、原木、种子、小麦、钻石和木棍。这里想**加上工作台、钓竿、皮革护甲**(要 Owner 点头)。

**写法**:脚本那一列是「开工条件(任一成立)/ 还要满足(全部成立)/ 步骤 / 完成条件(全部成立)」;步骤写成 `动作(参数)[跳过:条件]`。标 ★ 的是新动作或新判据。进度名写在【】里。

---

### G1 活着(不属于这棵树,放在状态维持层)

优先级 0。沿用 v2 的 A1~A29(吃、跑、苦力怕、弓箭手、别憋死、别烧死、别摔死、卡住自救……),不重写。**这棵树里所有脚本都会被它随时打断,打断后从原来那一步接着做。**

---

### G2 安家:有家、有床、天黑睡自己的床(优先级 1)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M2-1 家里有工作台和箱子 | 0 | 麦 | — | `有箱子` ≥ 1 | Minecraft(麦) |
| M2-2 三张床(每人一张) | 1 | 娘(主)麦(打羊补羊毛) | M2-1 | v2 的`全家床数` ≥ 3 | — |
| M2-3 床摆进自家屋里,记在各人名下 | 2 | 娘 | M2-2 | v2 的`没床的家人数` = 0 | — |
| M2-4 每人都在自己床上睡着过 | 3 | 麦 娘 豆 | M2-3 | ★`全家拿到过进度(adventure/sleep_in_bed)` = 3 | Sweet Dreams |
| M2-5 娘和豆各揣过一个工作台 | 6 | 娘 豆 | M2-1 | ★`全家拿到过进度(story/root)` = 3 | Minecraft(娘豆) |
| M2-6 家门口 16 格内插满 12 支火把,晚上家附近少刷怪 | 4 | 麦 | M5-6 | ★`家16格内有(火把)` ≥ 12 | — |
| M2-7 搬新家 / 盖 9×9 新房 | 5 | 麦 娘 | 沿用 v2 的 G3、G4 | 沿用 v2 | —(Owner 暂停中,等拍板) |

脚本:

| 脚本 | 属于 | 开工条件 / 还要满足 | 步骤 | 完成条件 |
|---|---|---|---|---|
| make_base(沿用线上) | M2-1 | 背包木头 ≥ 4 或 背包木板 ≥ 4 | build_base | 有箱子 |
| J2-2a 用线做床 | M2-2 | ★`家里有(线)` ≥ 12 / 【白天门】、身上有(床)=0 | go_home[跳过:离家距离≤8] → take_from_chest(线 12) → craft(white_wool)×3 → take_from_chest(木板 3)[跳过:背包木板≥3] → craft(white_bed) → store_items(床)★(要先让箱子能放床) | ★`家里有(床)` + ★`身上有(床)` 增加 1 |
| J2-2b 小麦打一只野羊补羊毛 | M2-2 | ★`家里有(线)` < 12 且 ★`家里有(白色羊毛)` < 3 / 【出门门】、有剑 | goto_place(记得的动物)[跳过:附近有羊] → hunt(羊)(★要带护栏)→ go_home → store_items | ★`家里有(白色羊毛)` ≥ 3 |
| J2-3 摆床 | M2-3 | ★`身上有(床)` ≥ 1 / 【放方块门】 | go_home → ★place_at_home(床, 挨着墙) → sleep(只点一下,设重生点) | v2 的`没床的家人数` = 0 |
| sleep_night(沿用;娘豆要放行 sleep) | M2-4 | 天黑了 / 有床(改成 v2 的`我有自己的床`) | sleep | 天黑了 = 0 |
| J2-5a 麦娘做一个工作台 | M2-5 | 背包木板 ≥ 4 / — | craft(crafting_table) → store_items | ★`拿到过进度(story/root)` = 1 |
| J2-5b 麦豆做一个工作台(要 Owner 批准清单扩大) | M2-5 | ★`家里有(木板)` ≥ 4 / 【麦豆门】、★`Owner批准(麦豆做东西清单扩大)` | go_home → take_from_chest(木板 4) → craft(crafting_table) → store_items(豆要放行) | 同上 |
| J2-6 插火把 | M2-6 | ★`家里有(火把)` ≥ 1 或 ★`身上有(火把)` ≥ 1 / 【白天门】、【放方块门】 | go_home → take_from_chest(火把) → ★place_at_home(火把, 按代码算好的点位:围着家每隔 6 格一支、不放在别人的方块上) | ★`家16格内有(火把)` ≥ 12 |

---

### G3 吃饱:自家田养活全家(优先级 1)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M3-1 锄头和种子 | 0 | 娘 | — | 有锄头 ≥ 1、有种子 ≥ 3 | — |
| M3-2 第一块 9 格麦田 | 0 | 娘 | M3-1 | 耕好的地 ≥ 9、空着的耕地 = 0 | A Seedy Place(娘) |
| M3-3 收麦 → 做面包 → 存进粮箱,走通一圈 | 0 | 娘 | M3-2 | 有粮箱 ≥ 1、v2 的`粮箱里的面包` ≥ 3 | Husbandry(根) |
| M3-4 粮箱面包补到 18 个 | 1 | 娘 | M3-3 | 粮箱里的面包 ≥ 18 | — |
| M3-5 麦豆也种下过种子 | 3 | 豆 | M3-2 | ★`拿到过进度(husbandry/plant_seed)` = 1(豆) | A Seedy Place(豆) |
| M3-6 麦田扩到 64 格(长尾:之后 128 格) | 4 | 娘 | M3-4、M6-3(水桶) | v2 的`田格余量` ≥ 0、空着的耕地 ≤ 4 | — |
| M3-7 家里常备第二种吃的:熟牛肉或熟鱼 ≥ 10 | 5 | 娘 | M5-5(熔炉)、M7-2 或 M7-6 | ★`家里有(熟肉或熟鱼)` ≥ 10 | — |
| M3-8 家门口水边种 16 株甘蔗(做纸 → 书) | 6 | 娘 豆 | M3-2 | ★`家24格内有(甘蔗)` ≥ 16 | — |
| M3-9 三人都吃过东西 | — | 三人 | — | ★`全家拿到过进度(husbandry/root)` = 3 | Husbandry(只验收,不设脚本) |

脚本:
- **M3-1 ~ M3-4 全部沿用线上的**:wife_make_hoe、wife_find_seeds、wife_gather_seeds、wife_till、wife_plant、wife_harvest、wife_bread、wife_store_crop、wife_get_crop_chest、wife_craft_chest、wife_logs_to_planks,再加 v2 的 J-M1-9。
- **J3-5 麦豆种一颗种子**:开工 v2 的`空着的耕地` ≥ 1(★只算自家登记过的田)/ 【麦豆门】、有种子 ≥ 1 → 步骤 go_home → plant_seeds(豆要放行)→ 完成 `拿到过进度(husbandry/plant_seed)` = 1。🔴 **前提是先补「自家田登记 + 以田为圆心扫描」**(记忆里记着:现在麦豆会扫到别人的地)。
- **J3-6 扩田**:沿用 v2 的 J-M1-7。
- **J3-7a 烤肉烤鱼**:开工 ★`家里有(生肉或生鱼)` ≥ 4 / ★`家16格内有(熔炉)` ≥ 1 → go_home → take_from_chest(生肉) → ★smelt(生肉, 燃料用木板) → store_crop → 完成 `家里有(熟食)` ≥ 10。
- **J3-8 种甘蔗**:开工 ★`身上有(甘蔗)` ≥ 1 或 ★`家里有(甘蔗)` ≥ 1 / 【放方块门】 → go_home → ★plant(甘蔗, 家 24 格内挨着水的沙子或泥土)→ 完成 `家24格内有(甘蔗)` ≥ 16。第一根甘蔗要小麦从河边拔回来(J3-8b:explore → ★`gather(甘蔗)`,可以并进 gather_seeds 的逻辑)。

---

### G4 全家有剑有甲(优先级 2,Owner 点名要的)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M4-1 每人从家里箱子领 2 颗钻石 | 0 | 麦 娘 豆 | M2-1 | ★`我领过钻石` = 2(每人) | Diamonds! ×3 |
| M4-2 每人一把钻石剑 | 0 | 麦 娘 豆 | M4-1 | ★`最好的剑等级` ≥ 4(每人) | — |
| M4-3 麦娘用那 5 个铁锭做铁头盔戴上 | 1 | 娘 | — | ★`穿着(铁头盔)` = 1 | Acquire Hardware + Suit Up(娘) |
| M4-4 麦豆用那 8 张皮革做皮胸甲穿上 | 1 | 豆(或娘做好放箱子) | — | ★`穿着(皮革胸甲)` = 1 | — |
| M4-5 箱子里攒够给娘豆补齐护甲的皮革(长尾) | 3 | 麦 | M7-4 或野牛 | ★`家里有(皮革)` ≥ 还缺的皮革(代码现算) | — |
| M4-6 每人 4 格护甲都不空 | 2 | 三人 | M4-3、M4-4、M4-5 | v2 的`在线家人里护甲空槽数` = 0 | — |
| M4-7 全家齐装 = 麦豆可以还手的开关 | — | — | M4-2、M4-6 | ★`全家都有剑和护甲` = 1 | 只验收 |

脚本:

| 脚本 | 属于 | 开工 / 还要满足 | 步骤 | 完成条件 |
|---|---|---|---|---|
| J4-1 领钻石 | M4-1 | ★`家里有(钻石)` ≥ 2(已经减掉 21 颗保底)/ ★`我领过钻石` = 0、离家 ≤ 120 | go_home → take_from_chest(钻石 2) → 代码记账 | `我领过钻石` = 2 |
| J4-2 做钻石剑 | M4-2 | ★`身上有(钻石)` ≥ 2 / ★`家8格内有(工作台)` ≥ 1 | craft(planks)[跳过:背包木板≥2] → craft(stick)[跳过:★身上有(木棍)≥1] → craft(diamond_sword) | 最好的剑等级 ≥ 4 |
| J4-3 麦娘做铁头盔 | M4-3 | ★`家里有铁锭(不减保留)` ≥ 5 / ★`穿着(铁头盔)` = 0 | go_home → take_from_chest(铁锭 5) → craft(iron_helmet) → ★wear_armor | `穿着(铁头盔)` = 1 |
| J4-4a 麦豆自己做皮胸甲(要 Owner 批清单) | M4-4 | ★`家里有(皮革)` ≥ 8 / 【麦豆门】、★`Owner批准(麦豆做东西清单扩大)` | go_home → take_from_chest(皮革 8) → craft(leather_chestplate) → ★wear_armor | 穿着(皮革胸甲) = 1 |
| J4-4b 麦娘做好放进箱子,麦豆去拿(另一种做法) | M4-4 | 同上 / 麦娘有空 | 娘:take_from_chest(皮革) → craft → store_items(护甲)★;豆:take_from_chest(皮革胸甲) → ★wear_armor | 同上 |
| J4-5 打野牛拿皮革 | M4-5 | 箱子里皮革不够 / 【出门门】、有剑、★`8格内有可打的野牛` | goto_place(记得的动物) → hunt(牛)(★带护栏)→ go_home → store_items | `家里有(皮革)` ≥ 目标数 |
| J4-6 做一件缺的皮甲穿上 | M4-6 | ★`我空着的护甲槽` ≥ 1 且家里皮革够做 / — | go_home → take_from_chest(皮革 N) → craft(缺的那一件) → ★wear_armor | 我空着的护甲槽 = 0 |

---

### G5 石器时代:会挖石头、有熔炉、有煤(优先级 3)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M5-1 小麦有一把木镐 | 0 | 麦 | M2-1 | ★`最好的镐等级` ≥ 1 | — |
| M5-2 学会去资源世界、再回家(Owner 批准以后) | 0 | 麦 | M5-1 | ★`去过资源世界次数` ≥ 1、★`在主世界` = 1 | — |
| M5-3 挖回 64 块圆石存进家里箱子 | 1 | 麦 | M5-2 | ★`家里有(圆石)` ≥ 64 | Stone Age(麦) |
| M5-4 小麦做石镐、石斧 | 2 | 麦 | M5-3 | 最好的镐等级 ≥ 2 | Getting an Upgrade(麦) |
| M5-5 家里放一个熔炉 | 2 | 娘 | M5-3 | ★`家16格内有(熔炉)` ≥ 1 | — |
| M5-6 挖煤,家里存 32 块 | 3 | 麦 | M5-4 | ★`家里有(煤)` ≥ 32 | — |
| M5-7 麦娘换石锄;娘豆各拿一块圆石、各做一把石镐 | 5 | 娘 豆 | M5-3 | ★`全家拿到过进度(story/upgrade_tools)` = 3 | Stone Age + Getting an Upgrade(娘豆) |
| M5-8 做 16 支火把存进箱子 | 3 | 娘 | M5-6 | ★`家里有(火把)` ≥ 16 | —(给 M2-6 用) |

脚本:

| 脚本 | 属于 | 开工 / 还要满足 | 步骤 | 完成条件 |
|---|---|---|---|---|
| J5-1 做木镐 | M5-1 | 背包木板 ≥ 3 或 背包木头 ≥ 1 / — | craft(planks)[跳过:背包木板≥3] → craft(stick)[跳过:身上有(木棍)≥2] → craft(wooden_pickaxe) | 最好的镐等级 ≥ 1 |
| J5-2 去资源世界走一趟 | M5-2 | ★`Owner批准(资源世界)` / 【资源世界门】 | go_home → ★go_world(资源世界) → wander(30 秒) → ★go_world(主世界) | 去过资源世界次数 ≥ 1 |
| J5-3 挖石头(v2 的 J-M5-3b 改写) | M5-3 | ★`家里有(圆石)` < 64 / 【资源世界门】 | go_home[跳过:离家≤8] → take_from_chest(镐)[跳过:身上的镐≥1] → take_from_chest(面包 4)[跳过:身上有(吃的)≥4] → ★go_world(资源世界) → ★mine(石头, 直到背包里的加上家里的 ≥ 64,最多 15 分钟) → ★go_world(主世界) → store_items | `家里有(圆石)` ≥ 64 |
| J5-4 做石头工具 | M5-4 | ★`家里有(圆石)` ≥ 6 / 在工作台旁 | take_from_chest(圆石 6) → craft(stone_pickaxe) → craft(stone_axe) | 最好的镐等级 ≥ 2 |
| J5-5 麦娘放熔炉 | M5-5 | `家里有(圆石)` ≥ 8 / 【放方块门】 | go_home → take_from_chest(圆石 8) → craft(furnace) → ★place_at_home(熔炉, 挨着箱子、头顶留空) | `家16格内有(熔炉)` ≥ 1 |
| J5-6 挖煤 | M5-6 | ★`家里有(煤)` < 32 / 【资源世界门】、镐等级 ≥ 1 | (同 J5-3,只把 mine 的目标换成煤矿;顺手挖到的铁矿也带回来) | `家里有(煤)` ≥ 32 |
| J5-7a 麦娘换石锄 | M5-7 | 家里有圆石 ≥ 2 / — | go_home → take_from_chest(圆石 2) → craft(stone_hoe) | 拿到过进度(story/mine_stone) = 1 |
| J5-7b 麦豆拿一块圆石(要放行 take_from_chest) | M5-7 | 家里有圆石 ≥ 1 / 【麦豆门】 | go_home → take_from_chest(圆石 1) | 拿到过进度(story/mine_stone) = 1 |
| J5-8 做火把 | M5-8 | 家里有(煤) ≥ 4 / — | go_home → take_from_chest(煤 4) → craft(stick) → craft(torch)×4 → store_items | 家里有(火把) ≥ 16 |

---

### G6 铁器时代(优先级 4)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M6-1 小麦挖粗铁,麦娘在家烧成铁锭,家里攒 11 个 | 0 | 麦(挖)娘(烧) | M5-4、M5-5 | ★`家里有(铁锭)` ≥ 11 | Acquire Hardware(麦) |
| M6-2 小麦做铁镐 | 1 | 麦 | M6-1 | 最好的镐等级 ≥ 3 | Isn't It Iron Pick |
| M6-3 两个水桶(小麦一个保命用,麦娘一个浇地、舀鱼用) | 1 | 麦 娘 | M6-1 | ★`身上有(水桶)` ≥ 1(两人各一) | — |
| M6-4 装一桶岩浆带回家当熔炉燃料 | 4 | 麦 | M6-3 | ★`拿到过进度(story/lava_bucket)` = 1 | Hot Stuff |
| M6-5 小麦有盾牌,并用它挡下一支箭 | 3 | 麦 | M6-1 | ★`拿到过进度(story/deflect_arrow)` = 1 | Not Today, Thank You |
| M6-6 小麦穿全套铁甲(24 个铁锭) | 2 | 麦 | M6-1 | ★`穿着的铁或更好护甲件数` = 4 | Suit Up(麦) |
| M6-7 剪刀(给自家羊剪毛) | 5 | 娘 | M6-1 | ★`身上有(剪刀)` ≥ 1 | — |
| M6-8 打火石(1 铁 + 1 燧石) | 6 | 麦 | M6-1 | ★`家里有(打火石)` + 身上有 ≥ 1 | —(给 G10 用) |
| M6-9 娘豆换成铁甲、全家备一把铁剑(长尾,约 50 个铁锭) | 7 | 麦(挖)娘(做) | M6-6 | ★`全家穿着的铁或更好护甲件数` ≥ 12 | Suit Up(豆) |

脚本:

| 脚本 | 属于 | 开工 / 还要满足 | 步骤 | 完成条件 |
|---|---|---|---|---|
| J6-1a 小麦挖铁 | M6-1 / M6-6 / M6-9 | ★`铁还差多少` ≥ 1 / 【资源世界门】、镐等级 ≥ 2 | go_home → 拿镐和口粮(同 J5-3) → ★go_world(资源世界) → ★mine(铁矿, 直到身上粗铁 ≥ 还差的数,或背包剩 4 格,或 15 分钟) → ★go_world(主世界) → store_items(粗铁) | `家里有(粗铁)` + `家里有(铁锭)` ≥ 目标数 |
| J6-1b 麦娘烧铁 | M6-1 | ★`家里有(粗铁)` ≥ 1 / 熔炉在、燃料够 | go_home → take_from_chest(粗铁) → take_from_chest(木板或煤或岩浆桶) → ★smelt(粗铁) → store_items(铁锭) | `家里有(粗铁)` = 0 |
| J6-2 做铁镐 | M6-2 | 家里有铁锭 ≥ 3 / 在工作台旁 | take_from_chest(铁锭 3) → craft(stick)[跳过] → craft(iron_pickaxe) | 镐等级 ≥ 3 |
| J6-3 做水桶、装水 | M6-3 | 家里有铁锭 ≥ 3 / — | take_from_chest(铁锭 3) → craft(bucket) → ★fill_bucket(水, 家 24 格内的水源) | `身上有(水桶)` ≥ 1 |
| J6-4 装岩浆 | M6-4 | ★`身上有(空桶)` ≥ 1 / 【资源世界门】、★`身上有(水桶)` ≥ 1(失手了能灭火)、只在主世界型的资源世界里 | ★go_world(资源世界) → ★fill_bucket(岩浆, 只装站在实心方块上、离边 ≥ 1 格就够得着的地表岩浆)→ ★go_world(主世界) → 交给麦娘:★smelt 的时候拿它当燃料 | 拿到过进度 = 1 |
| J6-5a 做盾 | M6-5 | 家里有铁锭 ≥ 1、背包木板 ≥ 6 / — | craft(shield) → ★wear_armor(副手) | ★`身上有(盾牌)` ≥ 1 |
| J6-5b 举盾挡箭(做进反射层 A6) | M6-5 | v2 的`被远程怪盯上` = 1 / 有盾 | ★raise_shield(对着射箭的怪,举 2 秒)→ 照 A6 原来的办法跑开 | 拿到过进度(story/deflect_arrow) = 1 |
| J6-6 做铁甲穿上 | M6-6 / M6-9 | 家里铁锭够做缺的那一件 / — | take_from_chest(铁锭 N) → craft(iron_xxx) → ★wear_armor;换下来的皮甲 store_items★ | 铁甲件数达标 |
| J6-7 做剪刀 | M6-7 | 家里有铁锭 ≥ 2 / — | take_from_chest(铁锭 2) → craft(shears) | 有剪刀 |
| J6-8 做打火石 | M6-8 | 家里有铁锭 ≥ 1、★`家里有(燧石)` ≥ 1 / — | take_from_chest ×2 → craft(flint_and_steel) → store_items★ | 有打火石 |

**铁的记账**:代码算出 `铁还差多少` = 所有还没做完的铁目标要的铁锭加起来(镐 3 + 桶 6 + 盾 1 + 剪刀 2 + 打火石 1 + 小麦铁甲 24,之后再加娘豆的铁甲),减去家里现有的。**那 5 个铁锭在麦娘头盔做出来之前不算进来。**

---

### G7 牧场和钓鱼:在家附近就能一直做的活(优先级 5)

这一组是**麦娘和麦豆的主要长尾活**,全都在家 24 格内。

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M7-1 做钓竿,在家门口的水里钓到第一条鱼 | 0 | 豆(主)娘 | M2-1 | ★`全家拿到过进度(husbandry/fishy_business)` ≥ 2 | Fishy Business |
| M7-2 麦豆常去钓鱼,家里鱼存 10 条(长尾,吃掉了就再钓) | 3 | 豆 | M7-1 | ★`家里有(鱼)` ≥ 10 | — |
| M7-3 家门口围一个 7×7 的牲口圈,带门 | 1 | 麦 | M2-1 | ★`家24格内有自家围栏圈` = 1 | — |
| M7-4 用麦子把 2 头牛、2 只羊引回圈里 | 2 | 麦 | M7-3、M3-3 | ★`圈里的动物(牛)` ≥ 2、★`圈里的动物(羊)` ≥ 2 | — |
| M7-5 喂麦子让牲口繁殖一次 | 2 | 娘 豆 | M7-4 | ★`全家拿到过进度(husbandry/breed_an_animal)` ≥ 2 | The Parrots and the Bats |
| M7-6 圈里养到牛 6、羊 6、鸡 4(长尾,之后 12) | 4 | 娘 豆(喂)麦(引鸡) | M7-5 | 圈里的动物数达标 | — |
| M7-7 圈里超过 6 头的,由小麦宰掉拿皮革和肉;麦娘给羊剪毛 | 5 | 麦(宰)娘(剪) | M7-6、M6-7 | ★`家里有(皮革)` ≥ 8、★`家里有(羊毛)` ≥ 9 | — |
| M7-8 麦娘用水桶在家门口舀一条鱼 | 4 | 娘 | M6-3 | ★`拿到过进度(husbandry/tactical_fishing)` = 1 | Tactical Fishing |
| M7-9 驯一只狼看家 | 8 | 麦 | ★`Owner批准(驯狼)`、M4-2 | ★`拿到过进度(husbandry/tame_an_animal)` = 1 | Best Friends Forever |
| M7-10 家门口种一片树(16 棵),以后小麦在家边就能砍树 | 3 | 豆(种)麦(收树苗) | M2-1 | ★`家32格内有自家种的树苗或树` ≥ 16 | — |

脚本:

| 脚本 | 属于 | 开工 / 还要满足 | 步骤 | 完成条件 |
|---|---|---|---|---|
| J7-1a 麦娘做钓竿 | M7-1 | ★`家里有(线)` ≥ 2 / — | take_from_chest(线 2) → craft(stick)[跳过] → craft(fishing_rod) | ★`身上有(钓竿)` ≥ 1 |
| J7-1b 钓鱼(娘豆共用) | M7-1 / M7-2 | ★`身上有(钓竿)` ≥ 1 且 ★`家24格内能钓鱼的水` ≥ 1 / 【麦豆门】(豆)或【白天门】(娘),背包空格 ≥ 2 | goto_place(家门口钓鱼点) → ★fish(钓到 N 条或 5 分钟) → go_home → store_items(娘)或交给家人(豆,用 v2 的 A27) | 拿到过进度 = 1 / `家里有(鱼)` ≥ 10 |
| J7-3 围圈 | M7-3 | 背包木板 ≥ 32 或家里木板 ≥ 32 / 【放方块门】、白天 | go_home → take_from_chest(木板 32) → craft(stick) → craft(oak_fence)×8 → craft(fence_gate) → ★build_pen(7×7, 代码挑一块平地:家 24 格内、不压田、不压别人的方块、不在别人领地) | `家24格内有自家围栏圈` = 1 |
| J7-4 引牲口回家 | M7-4 / M7-6 | ★`记得野生的(牛/羊/鸡)` ≥ 1 / 【出门门】、身上有(小麦) ≥ 4(引鸡用种子) | goto_place(记得的动物) → ★lure_animal(牛, 手里拿着麦子,慢慢走回圈里,关上门;**只引没有名字、没拴绳、不在别人围栏里、不在别人领地里的**) | 圈里的动物(牛) ≥ 目标数 |
| J7-5 喂牲口繁殖 | M7-5 / M7-6 | ★`圈里能繁殖的对数` ≥ 1 / 身上有(小麦) ≥ 2、离家 ≤ 24 | go_home → take_from_chest(小麦 2)[跳过] → ★breed(牛) | 拿到过进度 / 圈里的数达标 |
| J7-7a 宰多出来的 | M7-7 | ★`圈里的动物(牛)` > 6 / 有剑、【白天门】 | go_home → hunt(牛, **只限自家圈里**) → store_items | `家里有(皮革)` ≥ 8 |
| J7-7b 剪羊毛 | M7-7 | ★`圈里没剪过毛的羊` ≥ 1 / 有剪刀 | go_home → ★shear(羊) → store_items | `家里有(羊毛)` ≥ 9 |
| J7-8 用桶舀鱼 | M7-8 | ★`身上有(水桶)` ≥ 1 且 家 24 格内的水里有鱼 / 【白天门】 | goto_place(家门口的水) → ★bucket_mob(鳕鱼或鲑鱼) → go_home → store_items★ | 拿到过进度 = 1 |
| J7-9 驯狼(Owner 批准才开) | M7-9 | ★`家里有(骨头)` ≥ 5 且 ★`记得野狼` / 【出门门】 | goto_place → ★tame(狼, 骨头) → lead_home(沿用 v2) → 让它在家里坐下 | 拿到过进度 = 1 |
| J7-10a 小麦砍树时顺手把树苗带回家 | M7-10 | 改 chop_wood:挖到的树苗也收起来 | (改 gather_wood,不新增脚本) | — |
| J7-10b 麦豆在家门口种树苗 | M7-10 | ★`家里有(树苗)` ≥ 1 / 【麦豆门】、【放方块门】 | go_home → take_from_chest(树苗 4) → ★plant(树苗, 代码算好的格子:家 16~32 格、隔 3 格一棵) | 家门口的树 ≥ 16 |

---

### G8 打怪的本事(优先级 6,只有小麦)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M8-1 按规矩打死过一只怪 | — | 麦 | — | ★`拿到过进度(adventure/kill_a_mob)` = 1 | Monster Hunter(只验收,**不做成「主动出去找怪」**) |
| M8-2 做弓,家里攒 32 支箭 | 1 | 麦 | M5-6(燧石从沙砾里挖)、M7-6(鸡毛) | ★`身上有(弓)` ≥ 1、★`家里有(箭)` + 身上有(箭) ≥ 32 | — |
| M8-3 用弓射中一只怪 | 2 | 麦 | M8-2 | ★`拿到过进度(adventure/shoot_arrow)` = 1 | Take Aim |
| M8-4 做一把弩并射一次 | 3 | 麦 | M6-1、M8-2 | ★`拿到过进度(adventure/ol_betsy)` = 1 | Ol' Betsy |
| M8-5 家门口放一个标靶,站 30 格外射中靶心(长尾练习) | 8 | 麦 | M8-2、红石 | ★`拿到过进度(adventure/bullseye)` = 1 | Bullseye |

脚本:
- **J8-2** 做弓:`家里有(线)` ≥ 3 → craft(stick) → craft(bow);做箭:`家里有(燧石)` ≥ 1 且 `家里有(羽毛)` ≥ 1 → craft(arrow) 直到 32 支。燧石在挖石头时顺手挖沙砾得到(J5-3 的 mine 加一个「顺带挖」参数)。
- **J8-3** 射一只怪:开工 ★`16格内有可射的怪` ≥ 1(只算僵尸、骷髅、蜘蛛;**射出去的方向上 3 格内不能有真人、宠物、村民、马**)/ 【白天门】、有弓有箭、血量 ≥ 16 → ★shoot_bow(目标) → 怪靠近到 4 格内就交给反射层按规矩打或跑。
- **J8-4** 弩:材料 3 木棍 + 2 线 + 1 铁锭 + 1 绊线钩(铁锭 + 木棍 + 木板)→ craft → ★shoot_bow(用弩,对准家门口的一块自家方块或一只怪)。
- **J8-5** 标靶:要红石(资源世界)+ 干草块 → ★place_at_home(标靶) → 走到 30 格外 → ★shoot_bow。

---

### G9 钻石时代(优先级 7)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M9-1 小麦自己在资源世界挖到 3 颗钻石 | 0 | 麦 | M6-2、M6-3、M6-6 | ★`自挖钻石累计` ≥ 3 | —(麦的「钻石!」在 M4-1 已经拿到) |
| M9-2 钻石镐 | 1 | 麦 | M9-1 | 最好的镐等级 ≥ 4 | — |
| M9-3 用自己挖的钻石做一件钻石护甲(先做头盔) | 2 | 麦 | M9-1(再挖 5 颗) | ★`拿到过进度(story/shiny_gear)` = 1 | Cover Me with Diamonds |
| M9-4 做出第一本书(3 张纸 + 1 张皮革) | 1 | 娘 | M3-8、M4-5 | ★`家里有(书)` ≥ 1 | — |
| M9-5 附魔台放在家里,麦娘附魔一件东西 | 3 | 娘(麦备 2 钻石、4 黑曜石、青金石) | M9-4、M10-1、M9-1 | ★`拿到过进度(story/enchant_item)` = 1 | Enchanter |
| M9-6 附魔台周围摆 15 个书架(长尾,约 45 本书) | 6 | 娘 | M9-5 | ★`家8格内有(书架)` ≥ 15 | — |
| M9-7 小麦全套钻石甲(长尾,24 颗自挖钻石) | 7 | 麦 | M9-3 | 穿着的钻石护甲件数 = 4 | — |

脚本:
- **J9-1 深处挖钻石**:开工 ★`自挖钻石累计` < 目标 / 【资源世界门】、镐等级 ≥ 3、血量 ≥ 18、铁甲 4 件、`身上有(水桶)` ≥ 1、★`身上有(火把)` ≥ 16 → go_world(资源世界) → ★mine(钻石矿, 先下到 Y≈-58,在 Y -50~-58 挖 1×2 支巷;**碰到岩浆、听到监守者的声音、看到幽匿块就掉头**;每挖 8 格插一支火把)→ go_world(主世界) → store_items。完成 `自挖钻石累计` ≥ 目标。存进箱子的钻石会让 `家里有(钻石)` 超过 21,**多出来的才能用**。
- **J9-4 做书**:`家里有(甘蔗)` ≥ 3 且 `家里有(皮革)` ≥ 1 → take → craft(paper) → craft(book) → store_items★。
- **J9-5 附魔**:需要新动作 ★`enchant`(站在附魔台前,放一件工具,付 1~3 颗青金石,挑经验等级够得上的最便宜那一档)。经验靠烧东西和挖矿自己攒;新判据 ★`我的经验等级`。
- **J9-6 书架**:3 本书 + 6 块木板 → craft(bookshelf) → ★place_at_home(书架, 代码算好的附魔台周围一圈)。

---

### G10 通往下界(优先级 8,要 Owner 批准)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M10-1 家里攒 14 块黑曜石(门框 10 + 附魔台 4) | 0 | 麦 | M9-2 | ★`家里有(黑曜石)` ≥ 14 | Ice Bucket Challenge |
| M10-2 打火石 | 0 | 麦 | M6-8 | 有打火石 | — |
| M10-3 Owner 在后台批准传送门放在哪 | 0 | Owner | — | ★`Owner批准(下界门位置)` = 1 | — |
| M10-4 搭门、点火、进下界,马上回来 | 1 | 麦 | M10-1、M10-2、M10-3、M6-6 | ★`拿到过进度(story/enter_the_nether)` = 1 | We Need to Go Deeper + Nether(根) |

脚本:
- **J10-1 挖黑曜石**:在资源世界里找现成的黑曜石(岩浆遇水形成的、废弃传送门的)→ ★mine(黑曜石, 要钻石镐)。**不自己往岩浆上倒水**,除非 Owner 批准 `资源世界放方块`;批准以后才启用 v2 的 `cast_obsidian`。
- **J10-4**:★build_portal(Owner 批的那个坐标, 4×5 框)→ ★light_portal → ★use_portal(进)→ 在下界那头站 5 秒 → ★use_portal(回)。🔴 **风险**:下界那头的门是游戏自动生成的,可能出现在别人的下界基地附近,甚至直接连到别人的门上。第一次进去只看、不动任何东西;下界那头的坐标记下来给 Owner 看。

---

### G11 下界(优先级 9,麦出门,娘在家做后勤)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M11-1 下界远征装备齐:金头盔 + 另外三件铁甲 + 铁剑 + 盾 + 16 份吃的 + 64 圆石 | 0 | 麦(挖金)娘(备粮) | M10-4 | v2 的`下界远征缺口` = 0 | — |
| M11-2 找到下界要塞,记下位置 | 1 | 麦 | M11-1 | ★`记得下界要塞` = 1 | A Terrible Fortress |
| M11-3 打烈焰人,拿 7 根烈焰棒 | 2 | 麦 | M11-2、★Owner 定烈焰人的规矩 | ★`家里有(烈焰棒)` ≥ 7 | Into Fire |
| M11-4 要塞里收 4 个下界疣带回家 | 2 | 麦 | M11-2 | ★`家里有(下界疣)` ≥ 4 | — |
| M11-5 麦娘放酿造台、做 3 个玻璃瓶(沙子烧玻璃) | 3 | 娘(麦挖沙子) | M11-3、M5-5 | ★`家16格内有(酿造台)` ≥ 1、★`家里有(玻璃瓶)` ≥ 3 | — |
| M11-6 麦娘酿第一瓶药(粗制的药水就算) | 4 | 娘 | M11-4、M11-5 | ★`拿到过进度(nether/brew_potion)` = 1 | Local Brewery |
| M11-7 麦娘酿 3 瓶治疗药水给小麦远征用(长尾) | 6 | 娘 | M11-6(闪烁的西瓜片要金粒和西瓜) | ★`家里有(治疗药水)` ≥ 3 | — |
| M11-8 戴着金头盔给猪灵扔一个金锭 | 7 | 麦 | M11-1 | ★`拿到过进度(nether/distract_piglin)` = 1 | Oh Shiny |
| M11-9 攒 12 颗末影珍珠 | 5 | 麦 | M11-1 | v2 的`做眼还缺的末影珍珠` = 0 | — |
| M11-10 麦娘在家种下界疣(灵魂沙从下界带回来) | 8 | 娘 | M11-4 | ★`家16格内有(下界疣)` ≥ 4 | — |

脚本沿用 v2 的 J-M8-8a/8b(远征准备)、J-M8-9(找要塞)、J-M8-10(烈焰棒)、J-M8-11(末影珍珠),再加:
- **J11-4** 收下界疣:★harvest_crop 扩展到下界疣,只收要塞里天然长的。
- **J11-5** ★mine(沙子)(资源世界)→ 麦娘 ★smelt(沙子)→ craft(glass_bottle);烈焰棒 + 3 圆石 → craft(brewing_stand) → ★place_at_home。
- **J11-6** ★fill_bucket(水)→ 装满玻璃瓶 → ★brew(水瓶 + 下界疣 → 粗制的药水)。
- **J11-8** ★drop_item(金锭, 朝 6 格内的一只猪灵扔过去)→ 马上走开。
- 🔴 **打烈焰人要 Owner 定规矩**:按现在「只打 1~2 只普通近战怪」的规矩,烈焰人是远程怪,只能跑。建议的特例:只在要塞里、身上有 ≥ 2 瓶治疗药水、只有 1 只烈焰人、借墙角躲火球时才打。

---

### G12 末地:大结局(优先级 10)

| 小目标 | 优先级 | 负责人 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|---|
| M12-1 麦娘做末影之眼,做够为止 | 0 | 娘 | M11-3、M11-9 | v2 的`末影之眼缺口` = 0 | — |
| M12-2 扔眼找到要塞,走进去 | 1 | 麦 | M12-1 | ★`拿到过进度(story/follow_ender_eye)` = 1 | Eye Spy |
| M12-3 找到末地门框,记下还空几格 | 2 | 麦 | M12-2 | v2 的`记得末地门框` = 1 | — |
| M12-4 一张弓、64 支箭 | 1 | 麦 | M8-2 | v2 的`有弓` ≥ 1、`箭的家底` ≥ 64 | — |
| M12-5 填眼、点亮末地门、进末地 | 3 | 麦 | M12-3 | ★`拿到过进度(story/enter_the_end)` = 1 | The End? + The End(根) |
| M12-6 龙已经被别人打死的话,Owner 同意后复活它 | 4 | 麦 | M12-5、★`Owner批准(复活末影龙)` | v2 的`需要复活末影龙` = 0 | The End... Again...(复活了才算) |
| M12-7 打败末影龙 | 5 | 麦 | M12-4、M12-5、M12-6 | v2 的`打败过末影龙` = 1 | Free the End |
| M12-8 打龙的时候顺手用玻璃瓶装龙息 | 6 | 麦 | M12-7 那一趟 | ★`拿到过进度(end/dragon_breath)` = 1 | You Need a Mint |
| M12-9 往折跃门扔一颗珍珠,马上回来 | 9 | 麦 | M12-7、★`Owner批准(去末地外岛)` | ★`拿到过进度(end/enter_end_gateway)` = 1 | Remote Getaway |

脚本沿用 v2 的 J-M8-12 ~ J-M8-17b。🔴 末地里**绝不放床**(床在末地会爆炸);麦娘和麦豆**永远不进传送门**。

**大结局**:M12-7 做完,而且 G14 家底都满 → 真的没有候选了 → 按 T0 记成「大结局」,不标红。

---

### G13 远方见闻(优先级 11,麦白天在资源世界里做,可有可无的长尾)

| 小目标 | 优先级 | 前置 | 完成条件 | 进度 |
|---|---|---|---|---|
| M13-1 做望远镜(2 铜锭 + 1 紫水晶碎片,都在资源世界挖) | 0 | M6-1 | ★`身上有(望远镜)` ≥ 1 | — |
| M13-2 用望远镜看一只鹦鹉 | 1 | M13-1、资源世界刚好是丛林 | 拿到过进度(adventure/spyglass_at_parrot) = 1 | Is It a Bird? |
| M13-3 在下界用望远镜看一只恶魂 | 2 | M13-1、M11-1 | 拿到过进度(adventure/spyglass_at_ghast) = 1 | Is It a Balloon? |
| M13-4 打龙的时候看它一眼 | 3 | M13-3、M12-5 | 拿到过进度(adventure/spyglass_at_dragon) = 1 | Is It a Plane? |
| M13-5 穿皮革靴在细雪上走一段 | 2 | M4-6 | 拿到过进度(adventure/walk_on_powder_snow_with_leather_boots) = 1 | Light as a Rabbit |
| M13-6 做刷子(羽毛 + 铜锭 + 木棍),刷一只犰狳 | 3 | M13-1 | 拿到过进度(husbandry/brush_armadillo) = 1 | Isn't It Scute? |
| M13-7 在资源世界的古迹废墟刷出一块陶片;攒 4 块做一个饰纹陶罐 | 5 | M13-6 | 拿到过进度(adventure/salvage_sherd) = 1 → craft_decorated_pot… = 1 | Respecting the Remnants → Careful Restoration |

新动作 ★`spyglass_look`(拿出望远镜对准目标 1 秒)、★`brush`(用刷子刷方块或犰狳)。新判据 ★`资源世界的生物群系`(用来判断这一趟有没有丛林、雪坡、热带草原)。这一组**只在资源世界里做**,碰上合适的生物群系就顺手做,不专门为了它们跑一趟。

---

### G14 家底常备(优先级 12,掉下去就补的「维持」目标)

这些是「一直做不完」的保底。每条都是**低于门槛才开工、补到目标就停**,所以不会空转。

| 小目标 | 负责人 | 开工(低于) | 补到 | 靠哪些脚本 |
|---|---|---|---|---|
| M14-1 共用箱子至少留 9 个空格 | 麦 娘 | 空格 < 9 | 做一个箱子贴着放(v2 的 place_chest) | wife_craft_chest + ★place_at_home |
| M14-2 原木 | 麦 | < 64 | 128 | chop_wood、store_wood(优先砍家门口自家种的树) |
| M14-3 圆石 | 麦 | < 32 | 64 | J5-3 |
| M14-4 煤 | 麦 | < 16 | 32 | J5-6 |
| M14-5 面包(粮箱) | 娘 | < 18 | 34(给远征留 16) | 麦田那一串 |
| M14-6 熟肉或熟鱼 | 娘 豆 | < 6 | 12 | J7-1b、J7-7a、J3-7a |
| M14-7 火把 | 娘 | < 8 | 16 | J5-8 |
| M14-8 箭 | 麦 | < 16 | 64 | J8-2 |
| M14-9 每人手上的剑:钻石剑坏了先换石剑(**不再动箱底那 21 颗钻石**,到时候再问 Owner) | 三人 | 某人没剑 | 每人 1 把 | J5-4 改做石剑 / J6 改做铁剑 |
| M14-10 皮革、线(给床和护甲换新用) | 麦 | < 8 | 16 | J7-7a、J2-2b |

---

### 3.1 前后顺序(有向无环图,箭头 = 「先做完才开」)

```
G2 安家 ─ M2-1 ─┬─ M2-2 ─ M2-3 ─ M2-4 【Sweet Dreams】
               ├─ M2-5 【Minecraft ×3】
               ├─ M4-1 【Diamonds! ×3】─ M4-2 钻石剑 ──┐
               ├─ M5-1 木镐 ─ M5-2 资源世界 ─ M5-3 【Stone Age】
               │                                ├─ M5-4 【Getting an Upgrade】─ M5-6 煤 ─ M5-8 火把 ─ M2-6
               │                                ├─ M5-5 熔炉
               │                                └─ M5-7 【娘豆的石器】
               ├─ M7-1 【Fishy Business】─ M7-2 钓鱼长尾
               ├─ M7-3 围圈 ─ M7-4 引牲口 ─ M7-5 【Parrots&Bats】─ M7-6 ─ M7-7
               └─ M7-10 种树
G3 吃饱 ─ M3-1 ─ M3-2 【Seedy Place】─ M3-3 ─ M3-4 ─ M3-6 扩田
                          └─ M3-5 【豆的 Seedy】   M3-8 甘蔗 ─ M9-4 书
G4 ─ M4-3 【娘:Acquire Hardware + Suit Up】  M4-4 豆皮甲 ─ M4-6 ─ M4-7(麦豆可以还手)
M5-4 + M5-5 ─ M6-1 【Acquire Hardware】─┬─ M6-2 【Iron Pick】─ M9-1 挖钻石 ─ M9-2 ─ M10-1 【Ice Bucket】
                                         ├─ M6-3 水桶 ─ M6-4 【Hot Stuff】 / M7-8 【Tactical Fishing】 / M3-6
                                         ├─ M6-5 【Not Today】
                                         ├─ M6-6 【Suit Up】─ M6-9 全家铁甲
                                         └─ M6-8 打火石 ─┐
M9-1 ─ M9-3 【Cover Me w/ Diamonds】   M9-4 + M10-1 ─ M9-5 【Enchanter】─ M9-6 书架
M10-1 + M10-2 + M10-3(Owner) ─ M10-4 【Deeper / Nether】─ M11-1 ─ M11-2 【Fortress】─ M11-3 【Into Fire】
      ─ M11-5 ─ M11-6 【Local Brewery】─ M11-7 ;  M11-9 珍珠 ─ M12-1 眼 ─ M12-2 【Eye Spy】─ M12-3
      ─ M12-5 【The End? / End】─ M12-6 ─ M12-7 【Free the End】─ 大结局
```

### 3.2 谁干什么

| 阶段(大约) | 小麦(出门) | 麦娘(守家) | 麦豆(24 格内) |
|---|---|---|---|
| 第 1 周:今天就能做的 + 前三刀 | 领钻石做剑、砍树、围圈、做木镐、第一次去资源世界、挖石头 | 种田做面包、做床摆床、做铁头盔、做钓竿、放熔炉 | 领钻石做剑、种一颗种子、在家门口钓鱼、睡自己的床、跟着妈妈 |
| 第 2 周:石器到铁器 | 挖煤、挖铁、引牲口、打牛拿皮革 | 烧铁、做火把、做水桶、喂牲口、扩田、烤肉 | 钓鱼(长尾)、喂牲口、种树苗、穿上皮甲 |
| 第 3 周:铁器 | 全套铁甲、盾挡箭、装岩浆、做弓射箭、挖钻石 | 剪羊毛、种甘蔗、做纸和书、用桶舀鱼、做娘豆的铁甲 | 钓鱼、喂牲口、种树(麦豆在全家齐装以后,可以按规矩还手) |
| 第 4 周以后:钻石到下界 | 钻石镐、黑曜石、(Owner 批准后)下界门、要塞、烈焰棒 | 附魔台、书架、酿造台、酿药、备远征口粮、做末影之眼 | 照旧:家门口的长尾活 |
| 最后:末地 | 扔眼、要塞、末地门、打龙 | 备口粮、治疗药水 | 看家,**永远不进传送门** |

---

## 4. 先做哪些

### 4.1 最先要写的 10 件(按打开的小目标数排)

| # | 要做的 | 种类 | 打开的小目标(大约) | 为什么排在这里 |
|---|---|---|---|---|
| 1 | **`身上有(物品)` / `家里有(物品)` 两个通用判据**(带钻石 21 颗、铁锭 5 个的保底)+ **修好「8格内怪数」** | 判据 | 约 70 个小目标的开工或完成条件都要用 | 整棵树几乎每一条都要问「身上或家里有几个 X」。「8格内有怪」现在一直返回 0,等于【白天门】形同虚设 |
| 2 | **`拿到过进度(id)` / `全家拿到过进度(id)`** | 判据 | 约 30 个(每个照进度设的小目标) | 一个判据就给所有进度目标配上了不会作假的完成条件。⚠️ 先实测能不能收到数据包;收不到就退回用自己记的账 |
| 3 | **`wear_armor` 穿护甲** + 判据 `穿着(X)`、`在线家人里护甲空槽数`、`全家都有剑和护甲` | 动作 + 判据 | M4-3、M4-4、M4-6、M4-7、M6-5、M6-6、M6-9、M9-3、M9-7 | Owner 点名要的「全家有甲」;还是麦豆能不能还手的开关 |
| 4 | **`store_items` / `take_from_chest` 允许存取剑、甲、工具** + **给角色放行动作**(娘:sleep;豆:take_from_chest、craft、sleep、plant_seeds、store_items) | 改动作 + 改 roles.json | M2-4、M2-5、M3-5、M4-1、M4-2(麦豆)、M4-4、M5-7、M7-1(麦豆)… 约 12 个 | 几乎不用写新代码,却马上让麦娘和麦豆有一批活可做 |
| 5 | **`go_world`(去资源世界 / 回主世界)+ `mine` 挖矿**(带「只挖资源世界」的总闸)+ 判据 `在资源世界`、`资源世界今天剩余次数`、`最好的镐等级`、`离定时重启分钟数` | 动作 + 判据 | G5 到 G13 大约 25 个 | 整个石器以后的所有东西都卡在这里。要 Owner 批准机器人用资源世界(每人每天 5 次,**机器人绝不付第 6 次的金币**) |
| 6 | **`place_at_home(方块)`**(熔炉、火把、床、箱子、酿造台、附魔台、书架、标靶;套上【放方块门】和盖房时定的硬约束 ①~⑨) | 动作 | M2-3、M2-6、M5-5、M9-5、M9-6、M11-5、M14-1 … 约 10 个 | 一个动作包下所有「在家附近放东西」的活 |
| 7 | **`smelt` 烧东西**(用家里的熔炉,燃料用木板、煤或岩浆桶) | 动作 | M3-7、M6-1、M11-5、M14-6 … 约 8 个(铁的整条链) | 麦娘当家里的「烧炉工」,分工很自然 |
| 8 | **`fish` 钓鱼** + 判据 `家24格内能钓鱼的水` | 动作 + 判据 | M7-1、M7-2、M14-6 | 麦豆最好的长尾活:离家近、没危险、做不完 |
| 9 | **`build_pen` + `lure_animal` + `breed`** + 判据 `圈里的动物(种类)`、`记得野生的(种类)`,**再给 `hunt` 加护栏**(不打有名字的、拴着的、别人圈里的) | 动作 + 判据 | M7-3 ~ M7-7、M4-5、M14-10 | 麦娘和麦豆第二个长尾活;皮革、羊毛、肉从此不愁 |
| 10 | **`fill_bucket`(水 / 岩浆)+ `plant(甘蔗 / 树苗)`** | 动作 | M3-6、M3-8、M6-3、M6-4、M7-8、M7-10、M9-4 | 水桶能浇地、能保命、能做黑曜石;种树苗让小麦在家门口就能砍树 |

排在第 11 名以后的:`shoot_bow` / `raise_shield`(G8、M6-5)→ `enchant` / `brew`(M9-5、M11-6)→ `Owner批准(事项)` 后台开关(G10 以后都要用;做法简单,可以和第 5 件一起写)→ 传送门、要塞、末地那几个(沿用 v2 的 `build_portal` / `use_portal` / `throw_eye` / `fill_portal_frame` / `dragon_fight`)。

**前 4 件做完、第 5 件还没做**的时候(粗估,没有逐条跑过),能做的小目标从现在大约 10 个涨到大约 30 个。三个人都至少有 5~8 件在家附近能做的活,那时候就不会再出现「全家站着」了。

### 4.2 新动作一览(一句话定义)

| 新动作 | 做什么 |
|---|---|
| `go_world(资源世界/主世界)` | 用资源世界插件的入口(v2 写的是 `/res go`,⚠️ 要核实机器人能不能用;如果只能走指南针菜单,就要点 GUI)去资源世界;回来用 `/home base` |
| `mine(方块, 数量, 顺带挖)` | 只在资源世界里挖(总闸:不在资源世界就直接失败);按方块种类找最近的一块,挖下来捡起来;顺带把看到的煤、铁、沙砾也挖了 |
| `smelt(物品)` | 用家里的熔炉:放原料、放燃料、等烧好、取出来 |
| `place_at_home(方块, 位置规则)` | 在家 24 格内按代码算好的格子放方块;套用【放方块门】和盖房的硬约束 ①~⑨ |
| `wear_armor` | 把身上最好的护甲和盾牌穿戴上 |
| `fish(条数/分钟)` | 站在家门口的水边抛竿,咬钩就收,直到钓够或时间到 |
| `fill_bucket(水/岩浆)` | 对着够得着的水源或岩浆源用空桶;装岩浆必须站在实心方块上 |
| `bucket_mob(鱼)` | 拿水桶对着水里的鱼用 |
| `build_pen(7×7)` | 在代码挑好的平地上围一圈围栏,留一扇门 |
| `lure_animal(种类)` | 手里拿着它爱吃的东西,慢慢走回圈里(每走 3 格回头看一眼它跟没跟上),进圈后关门 |
| `breed(种类)` | 在圈里给两只成年的喂吃的 |
| `shear(羊)` | 用剪刀剪自家圈里的羊 |
| `plant(甘蔗/树苗)` | 在代码算好的格子上种 |
| `shoot_bow(目标)` | 用弓或弩对准目标射出去;射的方向上有人、宠物、村民、马就不射 |
| `raise_shield` | 对着射箭的怪举盾,举 2 秒 |
| `brew` | 用酿造台酿:放水瓶、放材料、等酿好、取出来 |
| `enchant` | 用附魔台附魔:放一件工具和青金石,挑最便宜的一档 |
| `drop_item(物品)` | 朝一个方向丢一件东西(给猪灵扔金锭用) |
| `spyglass_look(目标)` / `brush(目标)` / `tame(狼)` | 看一眼 / 刷一下 / 喂骨头直到驯服 |
| 后期(沿用 v2 的名字) | `build_portal`、`use_portal`、`throw_eye`、`fill_portal_frame`、`dragon_fight`、`bottle_breath`、`lead_home` |

### 4.3 故意不做的进度(77 个)和原因

| 原因 | 进度 |
|---|---|
| **要碰别人的东西或村民**(Owner 规矩:别人的床、箱子、庄稼、动物、村民都不碰) | Zombie Doctor、What a Deal!、Star Trader、Hired Help、Very Very Frightening、Surge Protector、Bee Our Guest、Total Beelocation、Wax On、Wax Off |
| **会招来袭击、连累别人** | Voluntary Exile、Hero of the Village、Who's the Pillager Now? |
| **凋灵会炸地形 / 公共破坏** | Spooky Scary Skeleton、Withering Heights、Bring Home the Beacon、Beaconator |
| **违反打怪规矩**(不是 1~2 只普通近战怪) | Return to Sender、Uneasy Alliance、Monsters Hunted、Postmortal、It Spreads、Sneak 100、A Throwaway Joke、Two Birds One Arrow、Arbalistic、Sniper Duel、试炼密室整组 7 个(Trial(s) Edition、Under Lock and Key、Revaulting、Lighten Up、Who Needs Rockets?、Blowback、Over-Overkill)、The Healing Power of Friendship! |
| **本身就是找死** | Caves & Cliffs、Great View From Up Here、Those Were the Days、War Pigs、The City at the End of the Game、Sky's the Limit、Feels Like Home、This Boat Has Legs、Hot Tourist Destinations、Subspace Bubble、Glow and Behold!、The Cutest Predator |
| **要跑遍世界、会闯进别人的地盘** | Adventuring Time |
| **要的东西只在危险的遗迹里** | Cover Me in Debris、Serious Dedication、Crafting a New Look、Smithing with Style、Sound of Music、You've Got a Friend in Me、Birthday Song、Smells Interesting、Little Sniffs、Planting the Past |
| **做不到或做起来极难** | A Furious Cocktail、How Did We Get Here?、A Balanced Diet、Two by Two、A Complete Catalogue、The Whole Pack、Good as New、Shear Brilliance、The Next Generation(龙蛋多半早没了) |
| **没用处,不值得写动作** | Sticky Situation、Whatever Floats Your Goat!、Bukkit Bukkit、When the Squad Hops into Town、The Power of Books、Crafters Crafting Crafters、Country Lode Take Me Home、Not Quite "Nine" Lives(重生锚在主世界会爆炸)、Who is Cutting Onions?、Hidden in the Depths(这两个可以以后当长尾再加) |

(注:最后一行里 Who is Cutting Onions? 和 Hidden in the Depths 在 2.2 节标的是「🟡 很晚」,这里算「先不做」;Owner 想要可以随时加回 G11。)

### 4.4 Owner 已拍板(2026-09-18 约 22:5x JST,在主会话里逐条回的,原话)

| # | 事项 | Owner 原话 | 对设计的影响 |
|---|---|---|---|
| 1 | 机器人能不能用资源世界 | 「可以」 | 【资源世界门】生效;每人每天 5 次、绝不付第 6 次的规矩照旧 |
| 2 | 资源世界里能不能临时放方块 | 「可以」 | 垫脚、插火把、倒水做黑曜石都可以(只限资源世界) |
| 3 | 麦豆「能做的东西」清单 | 「只要能做得出来的都加啊」 | 麦豆的 craft 不再限清单:材料够、能做出来的都可以做 |
| 4 | 下界传送门放哪 | 「传送门随便放」 | 不用等批准,放在家附近合适的地方(仍守「只在家附近放方块」「不进别人领地」) |
| 5 | 打烈焰人的特例 | 「到时候再说」 | 做到下界那一步时再问 |
| 6 | 驯狼 | 「要」 | 新增「驯一条狼看家」小目标(要骨头 → 打骷髅掉的或箱子里的) |
| 7 | 复活末影龙 | 「到时候再说」 | 做到末地那一步时再问 |
| 8 | 钻石 | 「钻石该用就用 没有什么舍不得的」 | **取消「箱底 21 颗不动」的保底**;`家里有(钻石)` 不再减 21;钻石镐、钻石甲都可以做 |

### 4.4(原文)要 Owner 拍板的几件事(已按上表回复)

1. **机器人能不能用资源世界**(每人每天 5 次,绝不付第 6 次的金币)。**这是石器以后整条线的开关。**
2. 资源世界里能不能**临时放方块**(往岩浆上倒水做黑曜石、挖矿时垫脚、插火把)。不批的话就只挖现成的黑曜石,火把挖完也不收回。
3. 麦豆「能做的东西」清单要不要加上**工作台、钓竿、皮革护甲、石镐**。
4. **下界传送门放在哪**;第一次进下界只看、不碰任何东西。
5. **打烈焰人的特例规矩**(按现在的规矩只能跑,就拿不到烈焰棒,末地整条线都会卡住)。
6. 要不要**驯狼**看家。
7. 龙如果已经死了,要不要**复活**(会影响全服的人)。
8. 钻石剑用坏以后换石剑、铁剑,**箱底 21 颗钻石继续不动**(沿用 Owner 16:50 的「到时再问」)。

### 4.5 实现时要当心的(从以前踩过的坑来)

- **判据名对得上 ≠ 意思对得上**。比如「家24格内」要以谁的家为圆心?麦豆的家是小麦的泥土房,麦娘的家是麦田,两个中心隔着大约 16 格。所有「家附近」的判据都要统一用**全家共用的家址**。
- **空的完成条件 = 永远做不完**(引擎的 `allOf([])` 算不成立)。这份表里每个小目标都写了完成条件;每条脚本进表之前还要再核一遍。
- **完成条件只能是代码判据**,不能问模型。所有「照进度设的」小目标都用 `拿到过进度`;数据包收不到时的退路是「自己记账」,**不能退回问模型**。
- 做木棍那一步要有跳过条件(`身上有(木棍) ≥ N`),不然被打断后从第 1 步重来,会把做剑用的木板吃掉。
- 新判据还没进进程时,引擎把它当「不认识 = 不成立」,新脚本会**悄悄地不跑**。每上线一批,都要在后台看「为什么没开工」,不能只看有没有报错。
- 挖矿的总闸必须写在**动作里面**(不在资源世界就直接失败),不能只靠脚本的开工条件挡:硬规则、Owner 在游戏里叫它做事,都可能绕过开工条件。
- 所有「引野生动物」「打牛」的动作,**护栏要写在动作里面**:有名字的、拴着绳的、在别人围栏里的、在别人领地里的,一律跳过。
