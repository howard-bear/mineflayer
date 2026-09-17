'use strict'
/*
 * XiaoMai —— AI 玩家机器人
 *   第1步:常驻 + 寻路 + 跟随
 *   第2步:接上 5060 的模型当「大脑」—— 从固定动作清单里挑一个
 *   第3步(本版):大目标 + 进度 + 会存盘的经验记忆 + 危险感知/打架/逃跑/吃东西
 *
 * 安全底线:模型只能"选动作",不能直接驱动身体,也不能发游戏命令。
 * 不合法的选择一律丢弃并退回 idle(见 brain.js 的校验)。玩家的话永远优先于大脑。
 *
 * ⚠️ 最重要的一条工程教训(别改回去):
 * **成功与否必须用「目标有没有真的推进」判定,不能用「动作跑完了」判定。**
 * 一开始我用后者,结果它在出生点保护区连砍 7 轮、每轮报"砍到6块"、背包一块没多,
 * 还把 8 条假成功记进了经验库 —— 结果记错了,它学到的就全是错的。
 */
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const collectBlock = require('mineflayer-collectblock').plugin
const pvp = require('mineflayer-pvp').plugin
// ⚠️ plan 也必须在这里引进来:planLoop 用到它,而 node --check 查不出"用了没导入"这种运行时错误,
// 漏掉的话是【开机即 ReferenceError】,机器人根本起不来。
const { decide, plan, chat, designHouse } = require('./brain')
const memory = require('./memory')
/*
 * 地图记忆(Owner:「得让他脑子里有地图啊,不能限制他的活动范围啊」)。
 * 它原来只知道"周围 24~32 格有什么",不记得任何地方,所以每轮从零摸索,
 * 我只好用"半径 64""离家 24 格"这类硬边界兜底 —— 边界越多越像笼子。
 * 有了地图,它才能【有理由地走远】,而不是靠放宽半径。
 */
const places = require('./places')
const roles = require('./roles')

/*
 * 🔴 角色档案 —— 一份代码跑三个角色。启动时就定死身份,认不出就【当场退出】。
 *
 * 为什么不许有默认值:一个 ROLE 写错(或 env 文件被旧备份覆盖)如果悄悄回落到默认角色,
 * 就等于把那个角色的动作白名单整份换掉 —— 那是"静默丢掉全部护栏",
 * 这套代码今天已经因为静默失效付过一整夜的学费。宁可起不来,不许带错身份跑。
 */
let ROLE = null
try {
  ROLE = roles.load(process.env.ROLE)
} catch (e) {
  console.error(`\n❌ 角色没定好,拒绝启动:${e.message}`)
  console.error(`   请在 /etc/mcbot.env 里设 ROLE=<角色>,档案文件:${roles.FILE}\n`)
  process.exit(1)
}

const CFG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  // 登录名由角色档案决定(MC_NAME 仍可覆盖,方便临时调试)
  username: process.env.MC_NAME || ROLE.login,
  password: process.env.MC_PW || '',
  followRange: parseFloat(process.env.MC_FOLLOW_RANGE || '2'),
  brain: {
    /*
     * 主脑走【晴海的 AI 网关】(iMac1),不再直连 5060。实测依据(2026-09-16,真实系统提示各 5 次):
     *   204 网关(不指定模型)  1358 ms  可用 5/5   —— /health 显示它自动选了 5060 的 qwen3:8b
     *   204 网关(指定 8b)     1529 ms  可用 5/5
     *   201 直连 + think:false  684 ms  可用 5/5
     *   201 直连 不关思考      5196 ms  可用 0/5   ← 对照组,证明思考坑真实存在
     * 多付约 0.7 秒换三件事,值:
     *   ① 5060 关机/老板在打游戏时自动换后端 —— 那正是 XiaoMai 变木头人的根因;
     *   ② 网关自己会关掉 qwen3 的思考,少一处我必须记得的坑;
     *   ③ 网关跑在 iMac1 上,晴海实测断电后 29 秒自启、60 秒内全部服务自愈。
     * 备用入口 http://<AI-GATEWAY-BACKUP>(M1,同一份代码),两边各自兜底本机、互不依赖。
     * ⚠️ 网关默认把回复截到 150 token,我们在 options.num_predict 里显式覆盖(200/300),已实测生效。
     */
    url: process.env.BRAIN_URL || 'http://127.0.0.1:11434/api/chat',
    /*
     * 主脑 qwen2.5:14b → qwen3:8b(Owner 2026-09-16 指定,5060 上已就绪)。
     * ⚠️ 光改这里【不生效】:/etc/mcbot.env 里钉着 BRAIN_MODEL=qwen2.5:14b,
     *    环境变量优先。那个文件已同步改掉(备份 /etc/mcbot.env.bak-*)。
     * ⚠️ qwen3 必须配合 brain.js 里的 think:false,见那里的实测记录。
     */
    model: process.env.BRAIN_MODEL || 'qwen3:8b',
    timeoutMs: parseInt(process.env.BRAIN_TIMEOUT_MS || '60000', 10),
  },
  /*
   * 规划师跑在 M1 上(<AI-GATEWAY-BACKUP>)。
   * 分工依据是【延迟敏感度】:5060 快,管"现在做什么"(怪贴脸时慢一秒就是命);
   * M1 慢 1.8 秒但几分钟才换一次计划,慢一点毫无影响 —— 两块显卡同时有活干。
   * ⚠️ 用新的变量名(PLAN_*),因为 /etc/mcbot.env 是 root 的、我改不了。
   */
  planner: {
    /*
     * 规划师也走网关、也用 qwen3:8b —— Owner 2026-09-16:
     * 「我们MC服务器调用的ai模型全部走网关,模型只用 qwen3:8b,
     *   这样3台本地ai模型的机器的内存不会被反复刷」。
     *
     * 这条指示有实测支撑(我当时正好量到了"被反复刷"的现场,M1 是 8GB 共享内存):
     *     起点内存里是 qwen2.5:7b(4.6G)      ← 规划师的
     *     老麦调一次 qwen3:8b → 12781ms,内存里变成【空】(8GB 留不住 8b,keep_alive 也没用)
     *     规划师调一次 7b     →  5569ms,7b 又装回来
     *     老麦再调一次        → 30757ms,内存里又变【空】
     *     老麦第三次(本该热着)→ 32729ms      ← 根本热不起来
     *   每一次调用都要重新从磁盘加载整个模型。
     * 全部收敛到"网关 + 单一 qwen3:8b"之后,所有请求都落到 5060 那一个常驻模型上,不再互踢。
     */
    url: process.env.PLAN_URL || 'http://127.0.0.1:11434/api/chat',
    model: process.env.PLAN_MODEL || 'qwen3:8b',
    timeoutMs: parseInt(process.env.PLAN_TIMEOUT_MS || '60000', 10),
  },
  /*
   * 主脑掉线时的【备用入口】:晴海那套网关的第二个入口(M1 上的 11435)。
   * ⚠️ 为什么不能再拿 CFG.planner 当备用:规划师现在也指向 204 网关了,
   *    再拿它当备用等于原地踏步 —— 同一个入口挂了就是一起挂。
   * 两个入口跑同一份代码、各自兜底本机、互不依赖,所以 204 整机挂掉时这个还在。
   */
  backup: {
    url: process.env.BACKUP_URL || 'http://127.0.0.1:11434/api/chat',
    model: process.env.BACKUP_MODEL || 'qwen3:8b',
    timeoutMs: 20000,
  },
  // 计划多久算过期(过期才允许换,免得它每 2 秒改一次主意)
  planFreshSec: parseInt(process.env.PLAN_FRESH_SEC || '60', 10),
  /*
   * 决策间隔 25 → 8 秒。
   * 实测 5060 的占空比只有约 2%(2小时19分里只被调用 170 次,每次 1.00 秒、只生成 8 个 token),
   * Owner:「你让他跑起来呀,多用 ai 算力来解决问题」。
   * 8 秒一次 ⇒ 调用频率约 3 倍,而且反应也更快(25 秒才想一次,怪都打完了它还没反应)。
   */
  /*
   * ⚠️ 变量名从 BRAIN_EVERY_SEC 改成 BRAIN_SEC 是【有意的】:
   * /etc/mcbot.env 里写死了 BRAIN_EVERY_SEC=25,那个文件是 root 的、改它要主人的密码。
   * 换个名字,旧那行就盖不住这里的 8 秒了。
   * 等主人给了密码,应该把 /etc/mcbot.env 里那行过时的 BRAIN_EVERY_SEC=25 删掉,免得以后看着困惑。
   */
  brainEverySec: parseInt(process.env.BRAIN_SEC || '8', 10),
  brainEnabled: (process.env.BRAIN_ENABLED || '1') !== '0',
  /*
   * ⚠️ 放置方块【默认关闭】,必须由 Owner 显式打开(ALLOW_PLACE=1)。
   * 原因:这是一台有孩子在玩的生存服,到处是保护区和别人的建筑,
   * 而我这个放置逻辑只会"在自己脚边找个空位就放" —— 它不看那是谁的地方。
   * Owner 亲眼看到它在受保护区域放方块。默认不许放,是唯一负责任的默认值。
   */
  allowPlace: (process.env.ALLOW_PLACE || '0') === '1',
  // 它自己安家之后,允许在家周围这么多格内建造(Owner 的方案:只在自己地盘上动土)
  buildRadius: parseFloat(process.env.BUILD_RADIUS || '24'),
  // 安家必须离出生点这么远 —— 出生点一带是保护区,把家安那儿等于白安
  /*
   * 120 → 80。原来那个 120 是我【猜】的,而且猜得太大,害它一路往远处跑、
   * 撞进别人的领地被拒 15 次、半夜在野外被围殴。
   * 2026-09-15 实测(probe.js,只破坏杂草的非破坏式探测,出生点 8,15):
   *   北:24 格受保护、40 格外自由   ← 区间最窄、最可信
   *   南:24 格受保护、104 格外自由
   *   西:8 格受保护、88 格外自由
   *   东:56 格仍是「管理员」领地(72 格那次是 <PLAYER> 的私人领地,不算出生点保护圈)
   * 取 80:比确认到的管理员领地最远处(56)还多留 24 格余量,又远小于原来的 120。
   * ⚠️ 这仍是个估计值(很多采样点没杂草可测),但比原来那个纯猜的数字有据得多。
   * ⚠️ 真正可靠的不是这个半径,而是【服务器自己说的话】—— 见 claimDenyPos 那套:
   *    被拒时记下位置并绕开,那是事实,不是估计。
   */
  homeMinDist: parseFloat(process.env.HOME_MIN_DIST || '80'),
  goalCount: parseInt(process.env.GOAL_COUNT || '64', 10),
  goalText: process.env.GOAL_TEXT || ROLE.goalText || '收集 64 块木头',
}

/*
 * 世界出生点的【真实坐标】,查服务器得到:setworldspawn → "Set the world spawn point to 8, 65, 15"。
 * ⚠️ 我之前在两处硬写成 (8,20) 估算值,导致它在 (76,114) 那次被判成"离出生点才115格"而拒绝安家 ——
 * 按真坐标重算其实是 120.1 格,本来就够格。**估算值散落在多处最容易悄悄算错,统一成一个常量。**
 */
const SPAWN = { x: 8, z: 15 }
/*
 * 每个动作最多允许占用多久。超时就掐掉,让大脑能接着想。
 * 30 秒是按实测定的:正常砍一棵树/走一段路都在 30 秒内完成,
 * 而卡死的那次占了 197 秒,把大脑整整堵了 3 分多钟。
 */
const ACT_CAP_MS = 30000

/*
 * 保命动作清单 —— **必须放在模块顶层**。
 * 🔴 它原来声明在 buildState() 内部,而 actTick() 也要用它:
 *    actTick 的"过期丢弃"判断早就引用了它(埋了几小时的雷),
 *    只因前面有 `waited > 20000` 短路、从未被求值,所以一直没崩;
 *    而新加的"耗时动作只让紧急情况打断"每轮都会踩到它 —— 那就是必崩。
 * ⚠️ `node --check` 查不出这种跨函数作用域错误(今晚 plan 忘了 import、
 *    ACT_CAP_MS 没定义,都是同一类)。**改动涉及跨函数引用时,一定要查声明位置。**
 */
const SURVIVAL = ['flee', 'fight', 'eat']

const NAME_RE = /小麦|xiaomai/i
const RE_FOLLOW = /跟我|跟着我|跟上|follow me/i
const RE_STOP = /在这等|别跟|停下|停一下|别动|stop|wait here/i
const RE_WHERE = /你在哪|你在那|在哪儿|where are you/i
const RE_GOAL = /目标|进度|收集了多少|多少木头/i

// 会主动打人的怪(凋灵骷髅、幻翼之类都算)
const HOSTILE_RE = /zombie|skeleton|creeper|spider|enderman|witch|drowned|husk|stray|pillager|vindicator|ravager|slime|phantom|blaze|piglin|hoglin|silverfish|guardian/i
const FOOD_RE = /bread|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon|beetroot|cookie|pumpkin_pie|rabbit|berries|stew|soup/i
/*
 * 🔴 救命食物:腐肉。
 *
 * 实测(2026-09-16 17:42~17:50,RCON 实据):
 *   背包 {count: 27, id: "minecraft:rotten_flesh"} ← 27 块能吃的东西就在身上
 *   foodLevel 4 → 3 → 2 → 1 → 0
 *   日志「执行结果: 失败:背包里没有吃的」
 *   随后 血9.5(饱食度不够,血根本不回升)→ 被 pillager 打死
 * 原因只有一个:FOOD_RE 不收 rotten_flesh,于是 foodItem() 返回 null。
 * **它抱着食物被自己的代码判定成"没有吃的",活活饿死。**
 *
 * 腐肉有 80% 概率食物中毒(饥饿 II,30 秒),但【饿死是 100%】—— 快饿死时必须吃。
 * ⚠️ 单开一条正则,【绝不并进 FOOD_RE】:
 *   actHunt 靠 countItem(FOOD_RE) 前后比对来判断"到底打到肉没有",
 *   而僵尸也掉腐肉 —— 混进去会让它把僵尸掉的腐肉当成打猎的战果,把失败读成成功。
 */
const EMERGENCY_FOOD_RE = /rotten_flesh/i
/*
 * 腐肉的可食门槛。
 * ⚠️ 原来是 12,实测证明太低:Minecraft 只有【饱食度够高才会自然回血】,
 * 而 12 这个上限让它永远停在 9~14 一带 —— 吃得着,却吃不到能回血的水平。
 * 实测(排除死亡重生后,两小时只有 5 次真回血):干净的三次【全在饱食度 20】。
 * 抬到 17:吃一块回 4 点,17+4=21 会溢出一点点,但比"永远回不了血"划算得多。
 */
const EMERGENCY_FOOD_AT = 17
/*
 * 冲向弓箭手的最大距离。超过这个距离一律改成"挡箭 + 拉开距离"。
 * 5 格 = 一步能跨到、骷髅来不及射第二箭的距离(实测 ≤5 格的冲锋只占 180/1354)。
 */
const RANGED_RUSH_MAX = 5
/*
 * 「站上去/穿过去就掉血」的方块 —— 寻路必须绕开。
 * ⚠️ 这份清单要同时喂给【两份 Movements】:我自己那份,和 collectBlock 自建的那份。
 *    只喂一份是无效的(详见 collectBlock 处的实测记录:被浆果丛扎死 4 次)。
 */
const AVOID_BLOCKS = ['sweet_berry_bush', 'cactus', 'powder_snow', 'magma_block',
  'wither_rose', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'lava']
let lastRangedRunAt = 0
let lastForcedCraftAt = 0
let lastForcedStoreAt = 0
let craftStallUntil = 0
let craftSameWant = 0
let craftLastWant = ''
let craftLastPlanks = -1

let bot = null
let following = null
let reconnectDelay = 5000
let ready = false
let followTicker = null

/*
 * 我自己配好的寻路设置(禁搭塔、禁脚手架、绕水)。必须留一份引用,因为——
 * ⚠️ mineflayer-collectblock 每次砍树都会 `new Movements(bot)`(默认设置:允许搭塔、
 * 脚手架=泥土+圆石)然后 `bot.pathfinder.setMovements(...)` **把全局设置覆盖掉且不还原**。
 * 这才是它在别人地盘上堆柱子的完整真因:砍一次树之后,后面所有寻路都能搭塔。
 */
let myMoves = null
let lastDropLimit = -1
let lastAnimalNoteAt = 0
let brainTimer = null
let actTimer = null
/*
 * 连续思考的循环只能启动一次。
 * ⚠️ 掉线重连会再走一遍启动流程 —— 若每次都开一个 `for(;;)` 循环,
 * 循环会一次次叠加、对显卡的调用成倍增长,而且没有句柄可以关掉它们。
 */
let brainLoopStarted = false
/*
 * 当前阶段目标 —— 由 M1 上的规划师自己定,不是我写死的。
 * planLoop 会【连续不断】地想下一个目标(让 M1 也忙起来),
 * 但只在"还没有计划"或"计划过期"时才真正换 —— 想得勤、换得少,
 * 否则计划每 2 秒变一个,它会永远在改主意、什么也做不完。
 */
let currentPlan = null
let planSetAt = 0
let planLoopStarted = false
let planning = false
/*
 * 「想」和「做」拆成两个独立循环 —— 这是让显卡真正忙起来的关键。
 *   thinking      正在问模型(防止同时问两遍)
 *   acting        身体正在做一个动作
 *   pendingAction 大脑已经想好、还没轮到做的那一步(只保留最新的一个)
 * 合在一起时,身体走路/砍树的几十秒里大脑一次都不许想,显卡整段空转;
 * 拆开之后,身体在干活的同时显卡就在想下一步。
 */
let thinking = false
let acting = false
let pendingAction = null
/*
 * 🔴 任务连续性的三个状态 —— Owner 2026-09-16 的要求:
 *   「让他先完成手上已经在跑的任务 再去想后面在做什么,
 *     除非被危险或者玩家打断,然后紧急处理,处理完之后还是回到原来的任务上」
 *
 * actingAction  手上这个动作的【完整对象】(原来只存了名字 actingName,
 *               名字不够——要回到原来的任务得知道 item/direction/place 这些参数)
 * queuedNext    大脑在"手上还有活"期间想出来的下一步。
 *               ⚠️ 原来这里是直接 `pendingAction = null` 丢掉的,于是动作一跑完
 *               就得从头再想一遍 —— 那 1~4 秒的空白正是 Owner 看到的"走几步停下来发呆"。
 *               现在存起来,活一干完立刻接上。
 * resumeAction  被【真紧急】腰斩的那个耗时活,险情过去后原样捡回来接着做。
 */
let actingAction = null
let queuedNext = null
let resumeAction = null
let queuedUsed = 0
let resumeTries = 0
let lastQueueLogAt = 0
// 正在执行的是哪个动作、从什么时候开始 —— 用来判断"新判断是不是该打断它"
let actingName = ''
let actingSince = 0
let brainPausedUntil = 0
let lastAction = '无'
let lastOutcome = '刚上线'
/*
 * 快被打死时传送回家的冷却。
 * 实测(2026-09-15):它和 pillager/skeleton 这类【远程】怪在空地上"往反方向跑"根本拉不开距离
 * ——日志里连续 5 秒都是「血量 10,pillager 在 5 格外」,对方一直在射,最后血量 1 → 死。
 * 141 秒内死了 3 次,16 次决策里 9 次是 flee,整条命都在逃却逃不掉。
 * 它明明有家,但传送自救只在"卡住/泡水"时触发,全历史 0 次 —— 唯独不在"快死了"时触发。
 */
let lastHomeEscapeAt = 0
/*
 * 「把自己的想法说出来」的冷却。
 * Owner:「不要让 XiaoMai 看起来那么傻」—— 它傻在玩家只看见一个乱走乱逃的木头人,
 * 看不见它其实在想事情。现在让它偶尔把理由说给大家听。
 * ⚠️ 公屏上都是小学生,必须限频(2 分钟一句),不然就成了刷屏。
 */
let lastWhyAt = 0
/*
 * 从什么时候开始一直待在地下(y<55)。
 * 实测它能在 y=41~45 的洞里连续转 27 次决策都出不来,而"卡住自救"按位移判定 ——
 * 它一直在动,所以永远不触发。**走来走去 ≠ 卡住**,得单独盯高度。
 */
let undergroundSince = 0
let lastUndergroundEscapeAt = 0
/*
 * 「大脑给了非法动作」这条日志的限流 + 连续非法计数。
 * 实测(2026-09-15 16:15~16:21):模型连续 6 分钟每 2.3 秒选一次被屏蔽的 gather_wood,
 * 每次都被丢弃 → 处境不变 → 下一轮再选同一个 → 死循环,日志刷了近 200 行,
 * 显卡 100% 空转,存箱进度卡在 24/64 一动不动。
 */
let lastRejectLogAt = 0
let rejectStreak = 0
/*
 * 「回家建基地」这条硬规则的失败退避。
 *
 * 🔴 实测教训(2026-09-15 16:36,换新家之后):
 * 传送到新位置后它站在 y=72~73(多半是树上/半空),脚下没有能放方块的实地,
 * 于是 build_base 每次都返回「周围放不下(8 个方向里只有 0 个像是能放的)」——
 * 而这是条【硬规则】,条件一直成立就一直重试:**1 分钟内触发 140 次、失败 102 次**,
 * 显卡空转、食物从 8 掉到 7,而且模型完全没有机会去做别的事。
 * **这是"只堵不疏"的第四次**,而且这次是我自己加的硬规则犯的:
 * 硬规则必须自带退避,否则一旦前置条件永远不满足,它就成了一个死锁。
 */
let buildFailStreak = 0
let buildPausedUntil = 0
/*
 * 「这棵树不能砍」的记忆 —— 坐标 → 记下的时间。
 *
 * 🔴 为什么需要:实测(2026-09-15 16:26)护栏连续拦下 3 次,**全在同一个坐标 (146,204)**。
 * 因为 gather_wood 每次都在 32 格内重新搜,于是每次都搜到同一批"别人家的原木",
 * 拒绝完、走开、下一轮又搜回来 —— 它在一栋 cherry_stairs 的房子周围空转,木头始终是 0。
 * 我已经为"领地拒绝"做过同样的事(claimDenyPos),但护栏拒绝一直没有这层记忆。
 * 10 分钟后过期:房子不会消失,但它可能只是路过时误判,不必永久拉黑。
 */
const badLogs = new Map()
const BAD_LOG_TTL = 10 * 60 * 1000
function rememberBadLog(pos) {
  badLogs.set(`${pos.x},${pos.y},${pos.z}`, Date.now())
  // 别让它无限长大(这是个常驻进程)
  if (badLogs.size > 400) {
    for (const [k, t] of badLogs) { if (Date.now() - t > BAD_LOG_TTL) badLogs.delete(k) }
    if (badLogs.size > 400) badLogs.clear()
  }
}
function isBadLog(pos) {
  const t = badLogs.get(`${pos.x},${pos.y},${pos.z}`)
  if (t === undefined) return false
  if (Date.now() - t > BAD_LOG_TTL) { badLogs.delete(`${pos.x},${pos.y},${pos.z}`); return false }
  return true
}
/*
 * 被领地保护拒绝的地点。服务器原话:「You don't have <PLAYER>'s permission to build here.」
 * 7 秒里被拒 15 次 —— 它在别人地界上反复砍同一棵树,一块也挖不掉,纯属白挨打。
 * 记下来,让它别再往这儿凑。
 */
let lastClaimDenyAt = 0
let claimDenyPos = null
/*
 * 每个动作的【连续失败次数】。
 * 为什么要有:经验库按"动作+原因前20字"去重,所以同一个错连犯 20 次,
 * 喂回模型的仍然只有一条,和只犯 1 次长得一模一样 —— 它根本看不见自己在死循环。
 * 连败次数是零成本、零风险的补救:既塞进处境让它自己看见,也用来给动作上冷却。
 */
const failStreak = new Map()
/*
 * 🔴 连败计数必须【会过期】—— 不然就是自锁死结。
 *
 * 原来只有 "成功即清零" 一条出路。可 hunt 的失败面很宽(64 格内没动物 / 够不着 /
 * 猎物跑了 / 30 秒被掐 / 被反射抢占),实测「11 次 hunt 只成功 1 次」,
 * 于是开局几分钟 failStreak('hunt') 就到 3,然后:
 *   ① 硬规则 `failStreak.get('hunt') < 3` 永久不再夺权;
 *   ② 菜单 `usable = avail.filter(... failStreak < 3)` 把 hunt 永久摘掉
 *      (SURVIVAL=flee/fight/eat、ESCAPE=explore/go_home 都不含 hunt);
 * 而清零它【需要一次成功的 hunt】—— 可 hunt 已经没有任何派发通路了。
 * 结果:唯一的产粮动作彻底死掉,整个进程生命周期内再也拿不到食物 → 饿死。
 * craft(做剑)一模一样。
 * 对照 build_base 用的是 buildPausedUntil = now + 90s 这种【时间】退避、会自动恢复 ——
 * 两种退避口径不一致,正是今晚反复踩的那类坑。
 *
 * 现在:3 分钟内没再失败就自动清零。读取一律走 failCount(),别再直接 .get()。
 */
const failStreakAt = new Map()
const FAIL_DECAY_MS = 3 * 60 * 1000
function failCount(action) {
  const n = failStreak.get(action) || 0
  if (!n) return 0
  if (Date.now() - (failStreakAt.get(action) || 0) > FAIL_DECAY_MS) {
    failStreak.set(action, 0)
    return 0
  }
  return n
}
// 反射层那个空 catch 的日志节流(见 reflexTick 末尾)
let lastReflexErrAt = 0
/*
 * say 的冷却。⚠️ 这条必须【先于】"允许它求助"上线:
 * 服务器上都是小学生,而它一旦卡进死循环就会反复喊"谁来帮我放个箱子"(已经喊过一次),
 * 没有冷却会把公屏刷满。
 */
let lastSayAt = 0
let goalAnnounced = false
// 累计存进箱子的数量 —— 新目标"保住成果"就看这个。
// (⚠️ 我第一版写 actStoreItems 时用了它却忘了声明,严格模式下会直接抛 ReferenceError)
let storedTotal = 0
/*
 * 🔴 进度必须落盘 —— 今天第二次栽在同一个坑上(第一次是 homePos)。
 * 证据:14:24 它「累计存了 75 个」,**已经超过 64 的目标**;
 * 可我为了部署重启了它 → 计数器归零 → 14:41 从 4 重新开始 → 14:57 又从 28 开始。
 * 木头实实在在躺在箱子里,但它自己不知道,于是永远完不成目标。
 * ⚠️ 重启后【不伪造】历史数字:箱子里到底有多少只有开箱才算数,这里只保证【从现在起】不再丢。
 */
/*
 * 🔴 它一直在往【别人的箱子】里存东西(2026-09-15 查实)。
 * 原来 actStoreItems 是 `findBlock(最近的箱子, 32 格)` —— 谁的都行。
 * 实测:它家在 (3,65,138),用的箱子在 (15,65,153),相距 19 格,里面有 31 种物品;
 * 而它自己只存原木和木板(一两种)—— 那几乎肯定是某个孩子的储物箱,
 * 累计 75+4+28=107 块木头很可能全倒进了人家箱子里。
 * 这和"把别人用原木盖的房子当树砍"是同一类错误:**把别人的东西当成自己的**。
 * 修法:只用【自己的箱子】(自己放下的那一个,记在 mychest.json 里);没有就如实说、请人给一个。
 */
const MYCHEST_FILE = require('path').join(__dirname, 'mychest.json')
let myChest = null
try {
  const c = JSON.parse(require('fs').readFileSync(MYCHEST_FILE, 'utf8'))
  if (c && typeof c.x === 'number') myChest = c
} catch (e) { /* 还没有自己的箱子,正常 */ }
function saveMyChest(pos) {
  myChest = { x: pos.x, y: pos.y, z: pos.z }
  try { require('fs').writeFileSync(MYCHEST_FILE, JSON.stringify(myChest)) } catch (e) { /* 存盘失败不能拖垮机器人 */ }
}

const PROGRESS_FILE = require('path').join(__dirname, 'progress.json')
function saveProgress() {
  try {
    require('fs').writeFileSync(PROGRESS_FILE, JSON.stringify({ storedTotal, goalAnnounced }))
  } catch (e) { /* 存盘失败不能拖垮机器人 */ }
}
try {
  const g = JSON.parse(require('fs').readFileSync(PROGRESS_FILE, 'utf8'))
  if (g && typeof g.storedTotal === 'number' && g.storedTotal >= 0) storedTotal = g.storedTotal
  // 已经报过喜就别重启一次喊一次(也可由"存够了"直接推出来)
  if (g && (g.goalAnnounced || storedTotal >= (parseInt(process.env.GOAL_COUNT || '64', 10)))) goalAnnounced = true
} catch (e) { /* 第一次跑没这个文件,正常 */ }
// 它自己选定的家。设成功后才有值 —— 有家之后才准建造、卡住也回这儿而不是出生点。
let homePos = null
const HOME_FILE = require('path').join(__dirname, 'home.json')

/*
 * ⚠️ 家必须落盘。第一版只存在内存里,结果每次我重启服务 homePos 就归零,
 * 战略硬规则又强制安一次家 —— 实测家从 (81,62,-256) "漂"到了 (110,62,-327)。
 * 加载时顺便按现行标准复核(高于海平面),不合格就作废、让它重新找个好地方。
 */
// 家是 Owner 在游戏里 `/sethome XiaoMai:base` 定的吗?是的话我那套挑地方的标准就不该再去否决他。
let homeByOwner = false

function saveHome() {
  try {
    require('fs').writeFileSync(HOME_FILE, JSON.stringify({ x: homePos.x, y: homePos.y, z: homePos.z, byOwner: homeByOwner }))
  } catch (e) { log('存家失败:', e.message) }
}
function loadHome() {
  try {
    const h = JSON.parse(require('fs').readFileSync(HOME_FILE, 'utf8'))
    if (!h || typeof h.x !== 'number') return
    homeByOwner = h.byOwner === true
    // ⚠️「太低就作废」是用来否决【我自己】随便挑的烂地方的,不能用来否决 Owner 的决定。
    if (!homeByOwner && h.y < 64) { log(`存档里的家 (${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.z)}) 太低(海边),作废,重新找`); return }
    homePos = new Vec3(h.x, h.y, h.z)
    log(`读到存档里的家: (${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.z)})${homeByOwner ? '(Owner 在游戏里定的,不再自己改)' : ''}`)
  } catch (e) { /* 第一次跑没这个文件,正常 */ }
}

/*
 * 🏠 Owner 在游戏里挪了家之后,怎么让机器人跟上
 *
 * Owner 站在想要的位置打 `/sethome XiaoMai:base`,改的是【服务器权威】那份家 ——
 * 它决定 /home base 把小麦送到哪儿。但小麦自己另记了一份 homePos(决定它能在哪儿动土、
 * 什么时候该回家、离家多远算远),两边会对不上,而且会越错越远。
 *
 * 为什么不直接去读服务器那份:Essentials 的存档在 /opt/minecraft/plugins/Essentials/userdata/,
 * 属主 minecraft、目录权限 drwx--x---,而机器人跑在 howard 下 —— 实测 Permission denied。
 * 所以只能反推:/home base 传送完它站在哪儿,那儿就是真正的家。
 *
 * 判据必须【两条同时成立】,否则会把"传送没成功"错当成"家挪了":
 *   ① 相对发命令之前确实挪了一大段(>16 格)→ 传送真的发生了
 *   ② 落点离我记的旧家还很远(>16 格)→ 落的不是旧家
 * 只满足 ① 不满足 ②:正常回家,不用改。
 * 只满足 ② 不满足 ①:命令没生效(冷却/被打断),它原地没动 —— 这时候【绝不能】把当前位置当成家。
 *
 * ⚠️ 这同时修掉一个真 bug:Owner 一挪家,actGoHome 传送过去后会算出
 *    「动了 X 格但没到家」→ 返回失败 → 连败计数上涨 → go_home 被冷却掉,越挪越回不了家。
 */
let lastOwnerHomeKeepLog = 0
function adoptHomeIfMoved(before, label) {
  if (!homePos || !before || !bot || !bot.entity) return false
  /*
   * 🔴 Owner 亲手定的家,绝不许我自己"推断"着改掉 —— 这是我 2026-09-17 凌晨自己捅的娄子。
   *
   * 实测:这套反推一晚误判【4 次】,把家从 Owner 定的 (-17,159) 一路飘到 (-22,149):
   *   17:09 → (-41,162)   17:15 → (-31,147)   17:29 → (-20,172)   17:50 → (-22,149)
   * 而 Essentials 里的权威值【从头到尾都是 (-17.497, 63, 158.76),一次没变】。
   *
   * 机制:scheduleHomeResync 是发完 /home base 之后【5 秒】才读位置,
   * 而它开着疾跑(moves.allowSprinting = true,约 5.6 格/秒),5 秒能跑 28 格 ——
   * 于是"传送回家了、然后立刻跑开去干活"完全满足我那两条判据
   * (①相对发令前挪了 >16 格 ②落点离旧家 >16 格)。
   * **判据本身没错,错在【读位置的时机】。**
   *
   * 而且这个误判不是无害的:家决定它能在哪动土(buildRadius 24)、什么时候该回家,
   * 家一飘,Owner 亲手选的位置就作废了。
   *
   * 两条改法:
   *   ① Owner 定的家一律不动(要换位置请他再打一次 /sethome XiaoMai:base,
   *      想立刻生效跑 sudo ~/sync_home.sh)—— **他的明确决定优先于我的推断**;
   *   ② 非 Owner 定的家改用 forcedMove 事件触发(见 scheduleHomeResync)。
   */
  if (homeByOwner) {
    if (Date.now() - lastOwnerHomeKeepLog > 600000) {
      lastOwnerHomeKeepLog = Date.now()
      log(`🏠 家是 Owner 在游戏里定的 (${Math.round(homePos.x)},${Math.round(homePos.z)}),我不自己改`
        + ` —— 要换位置请他再打一次 /sethome XiaoMai:base`)
    }
    return false
  }
  const now = bot.entity.position
  if (now.distanceTo(before) <= 16) return false     // 没传送 → 不认
  if (now.distanceTo(homePos) <= 16) return false    // 落在旧家 → 家没动
  const old = homePos
  homePos = now.clone()
  homeByOwner = true
  saveHome()
  log(`🏠 家被挪了(${label}):/home base 把我送到 (${Math.round(now.x)},y=${Math.round(now.y)},${Math.round(now.z)}),`
    + `我原来记的是 (${Math.round(old.x)},${Math.round(old.z)}) —— 以服务器为准,已改过来并落盘`)
  forgetChestIfFarFromHome('家刚被挪到新位置')
  return true
}

/*
 * 🧰 家挪走了,旧箱子就不再算"家里的箱子"
 *
 * 死锁实测(2026-09-16,Owner 在游戏里把家挪到 (-17,63,159) 之后):
 *   箱子还记在旧家 (199,69,597),相距 489 格 —— 于是
 *   ① bot.blockAt() 够不到那个箱子(区块没加载)→ chestReachable=false → store_items 不进菜单;
 *   ② 而清掉 myChest 的那行代码只在 store_items 的【执行器】里,执行器永远轮不到;
 *   ③ 所以 myChest 永远是真 → 「有木头、没箱子就回家建」那条硬规则永远不触发。
 *   结果:它背着 27 块木头,既存不进去、也不会去造新的,只能一直逛。
 *   这正是代码里自己警告过的那类病 ——「屏蔽逻辑和执行器用了不同判据」。
 *
 * ⚠️ 判据必须用【记下来的坐标】,不能用 blockAt:
 *    blockAt 返回 null 只说明"区块没加载",不等于"箱子没了" ——
 *    拿它当判据会让机器人一走远就把好箱子忘掉。
 *    而"箱子离家比建造半径还远"是纯坐标计算,不需要加载区块,
 *    而且只在家【真的挪了】的时候才成立。
 */
function forgetChestIfFarFromHome(reason) {
  if (!myChest || !homePos) return false
  const d = Math.hypot(myChest.x - homePos.x, myChest.z - homePos.z)
  if (d <= CFG.buildRadius) return false
  log(`🧰 旧箱子在 (${myChest.x},${myChest.y},${myChest.z}),离新家 ${Math.round(d)} 格`
    + `(超过建造半径 ${CFG.buildRadius})—— 不再当成"家里的箱子"(${reason})。`
    + `里面的东西留在原地,我回家重新造一个。`)
  myChest = null
  try { require('fs').writeFileSync(MYCHEST_FILE, 'null') } catch (e) { log('清箱子存档失败:', e.message) }
  return true
}

/*
 * 全文有 8 处 say('/home base')。闸门设在 say() 这个唯一出口上统一挂钩
 * (和限流、放方块总闸是同一个思路),免得将来新加一处又漏掉。
 * pending 标记防止连发时堆一串定时器。
 */
/*
 * 🔴 「回家逃命」把死亡循环自己闭合了 —— 2026-09-17 07:5x 抓到的现场。
 *
 * 死亡时间分布是典型的爆发:22:30 十一次、22:31 七次、22:52 十一次。
 * 而**死亡地点几乎全是 (-17,63,159) / (-17,64,158)** —— 那正是它的家、
 * 也是它自己那栋 4×4 墙高 2、门洞敞开、没屋顶的泥土房子所在。凶手每次都是 zombie。
 *
 * 闭环:死 → 复活 → 逃命反射发 `/home base` → 传送到家 → 僵尸就蹲在那儿 → 死 → …
 * 三方对账证实是真死亡(服务器统计 31 / 广播 31 / 记账 31,窗口 33 分钟),
 * 折合每小时 56 次(终身平均 35)。那栋没有屋顶、门洞敞开的房子等于把僵尸圈在了它的落点上。
 *
 * 这道护栏只做一件事:**如果"传送回家"这个动作本身刚把它送进死亡,就暂时别再回家。**
 * 判据:传送回家后 20 秒内就死 → 连续 2 次 → 家标记为"暂时不安全" 5 分钟,
 * 期间 `/home base` 自动换成 `/spawn`(出生点是保护区,怪打不到它,能喘口气)。
 * ⚠️ 不改夜间行为(躲屋里/用床/天黑不出门)—— 那是行为设计,等 Owner 拍板。
 * ⚠️ 闸门设在 say() 这个唯一出口(和限流、家同步、放方块总闸同一个思路),
 *    全文 8 处 `/home base` 一次覆盖,不会漏。
 */
let lastHomeTpAt = 0
let homeDeathStreak = 0
let homeUnsafeUntil = 0
/*
 * 🔴 真正的死亡闭环机制(2026-09-17 08:1x 查实,和我上面那道护栏猜的不一样):
 *
 * `Essentials/config.yml:1231` 写着 **`respawn-at-home: true`** ——
 *   「When users die, should they respawn at their first home or bed, instead of the spawnpoint?」
 * 也就是说**死了之后 EssentialsX 自动把它重生【在家】**,全程不经过 `/home base`。
 * 所以闭环是:死 → 插件自动重生在家 → 僵尸就蹲在那儿 → 6 秒后又死 → …
 * 日志里「☠️ 我死了」之后的第一条坐标连着五个 `(-17,63,159)`,就是家的位置,实锤。
 * 这也解释了为什么我那道只拦 `/home base` 的护栏拦不住它。
 *
 * ⚠️ `respawn-at-home` 是**全服设置**(孩子们也受影响,而且对孩子是好事),改它是 Owner 的决定。
 * 这里只做一件小麦自己的事:**刚死过的十几秒里,只要旁边有怪就先跑,别站在原地挨第二刀。**
 * 平时的逃跑判据是"血量低",而刚重生时是满血 20 —— 那条判据在这个场景下正好不成立,
 * 于是它站在僵尸面前满血等死。这一条就是补那个缺口。
 */
let justDiedUntil = 0
let lastRespawnFleeLog = 0

let homeResyncPending = false
function scheduleHomeResync() {
  if (homeResyncPending || !bot || !bot.entity) return
  if (homeByOwner) return        // Owner 定的家不需要核对,也不许我改(见 adoptHomeIfMoved)
  homeResyncPending = true
  const before = bot.entity.position.clone()
  /*
   * 🔴 用 forcedMove 事件触发,不用固定延时。
   *
   * forcedMove = 服务端真的把玩家挪走的那一瞬间(mineflayer 的 lib/plugins/physics.js:441 和 :453),
   * 此刻读到的位置【就是落点本身】。
   * 原来那个固定 5 秒延时读到的是"落点 + 它自己跑掉的距离" ——
   * 疾跑 5 秒能跑 28 格,那正是昨夜 4 次误判的全部原因。
   *
   * 兜底 8 秒:没收到 forcedMove 说明命令没生效(冷却/被拒/读条被打断),
   * 那就【放弃这次核对】,绝不拿当前位置去猜。
   */
  let done = false
  const onForced = () => {
    if (done) return
    done = true
    homeResyncPending = false
    try { bot.removeListener('forcedMove', onForced) } catch (e) { /* 移不掉也无所谓,once 会自清 */ }
    try {
      // forcedMove 也会因【死亡重生】触发 —— 落在出生点附近的一律不认(家至少离出生点 80 格)
      const now = bot.entity && bot.entity.position
      if (now && Math.hypot(now.x - SPAWN.x, now.z - SPAWN.z) < 40) {
        log('🏠 落点离出生点太近,这多半是死亡重生不是回家 —— 不改家的记录')
        return
      }
      adoptHomeIfMoved(before, 'forcedMove 落点')
    } catch (e) { log('核对家的位置时出错:', e.message) }
  }
  bot.once('forcedMove', onForced)
  setTimeout(() => {
    if (done) return
    done = true
    homeResyncPending = false
    try { bot.removeListener('forcedMove', onForced) } catch (e) { /* 无所谓 */ }
  }, 8000)
}

/*
 * ⚠️ 时间戳带毫秒(19 → 23):要验证的"发呆缩短"本身就是 0.3~4 秒的量级,
 * 秒级时间戳量不出来。审查意见原话:"没有任何一行标记动作【开始】,而且时间戳只有秒级"。
 */
const log = (...a) =>
  console.log(new Date().toISOString().replace('T', ' ').slice(0, 23), ...a)
const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 50)

/*
 * 🔴 公屏发言必须【严格限流】—— 这是被服务器永久封号换来的教训。
 *
 * 事故(2026-09-16 10:21:12 JST):
 *   banned-players.json → source="GriefPrevention Anti-Spam", reason="Banned for spam.", expires=forever
 *   服务器日志:[GriefPrevention] Muted gibberish. ×27,**27 次全是 XiaoMai**,
 *   每次都紧跟着一句中文,例如「XiaoMai: 我在想:四周都是陆地,往南走看看是否有树」。
 * 原因:GriefPrevention 的反刷屏用"元音/辅音比例"判断乱码,而中文没有 ASCII 元音,
 *   于是**它说的每一句中文都被判成 gibberish**,累计到阈值就自动永久封号。
 * 数据否定了别的猜测:整份日志里 joined 只有 2 次、lost connection 2 次(不是重连刷屏);
 *   /home base 虽有 246 条,但按分钟看峰值只有 3 条/分钟(够不上刷屏)。
 *   唯一被反复标记的就是【中文聊天】。
 *
 * 所以:斜杠命令(/home、/login…)照发 —— 那是命令不是聊天,不进反刷屏检测;
 *   公屏说话则最少间隔 10 分钟一句。装饰性的"我在想"已经整个删掉(见 brainTick)。
 * ⚠️ 别把限流做在各个调用点上 —— 全文有 11 处 say(),漏一处就会再被封。
 *   闸门设在唯一的出口这里,和"放方块总闸"是同一个思路。
 */
function say(msg) {
  try {
    if (!bot) return
    const s = String(msg == null ? '' : msg)
    /*
     * 🗣️ 不限流 —— Owner 明确要求:「60 秒才一句话 不行的,按照我说的 先关掉」。
     *
     * 服务器侧那条离谱的规则已经拆了(Owner 拍板):
     *   GriefPrevention config.yml:BanOffenders true → false(不再自动封号),
     *   AllowedIpAddresses 加上 127.0.0.1(机器人和服务端同机,整个豁免反刷屏)。
     * 那条规则本来就该拆:GP 按"元音/辅音比例"判乱码,而中文没有 ASCII 元音,
     * **任何说中文的玩家理论上都会中招**,不只是机器人。
     *
     * ⚠️ 留给以后的自己:如果又出现「Banned for spam」,先查 GP 配置有没有【真的重载】
     *    (改 config.yml 之后 Paper 不重启的话,内存里可能还是旧配置),
     *    而不是回来重新加限流 —— 限流不是解法,它只会让 XiaoMai 变哑巴。
     */
    // 🏠 Owner 可能在游戏里用 /sethome XiaoMai:base 把家挪走了。
    // 传送 5 秒后核对一次落点,发现对不上就以服务器为准(判据见 adoptHomeIfMoved)。
    let out = s
    if (out === '/home base') {
      if (Date.now() < homeUnsafeUntil) {
        // 家那边刚刚连着把它送死,先别回去 —— 改去出生点喘口气(那儿是保护区)
        const left = Math.round((homeUnsafeUntil - Date.now()) / 1000)
        log(`🏚️ 家那边刚连着把我送死,${left} 秒内不回家 —— 这次改去出生点`)
        out = '/spawn'
      } else {
        lastHomeTpAt = Date.now()
        scheduleHomeResync()
      }
    }
    bot.chat(out)
  } catch (e) { log('发言失败:', e.message) }
}

let _logIds = null
function logIds() {
  // 算一次就够了。原来每次调用都要重新加载整张方块表,而这函数在砍树循环里被反复调用。
  if (_logIds) return _logIds
  const mcData = require('minecraft-data')(bot.version)
  _logIds = Object.keys(mcData.blocksByName)
    .filter((n) => /_log$/.test(n))
    .map((n) => mcData.blocksByName[n].id)
  return _logIds
}

/** 背包里的原木数量 —— 这就是目标进度的度量,也是判断砍树成没成的唯一标准。 */
function woodCount() {
  try {
    return bot.inventory.items()
      .filter((i) => /_log$/.test(i.name))
      .reduce((s, i) => s + i.count, 0)
  } catch (e) { return 0 }
}

/** 最近的一只怪。用来判断危不危险,也是 fight/flee 的目标。 */
function nearestHostile() {
  try {
    if (!bot.entity) return null
    /*
     * ⚠️ 别再加 `x.type === 'mob'` 这个过滤条件了。
     * 它被僵尸打死时,反射却喊"看不见怪";服务器日志写的是 `slain by Zombie`。
     * 也就是说这个 type 判断在当前 mineflayer 版本上直接把僵尸漏掉了,
     * 结果整段运行里 fight/flee 一次都没触发过 —— 等于"自保和反击"根本没生效。
     * 现在只按名字认,类型不参与过滤,并且多看几个字段(不同版本字段名不一样)。
     */
    /*
     * ⚠️ 绝对别碰 x.mobType:它在 prismarine-entity 里已被废弃,
     * **每访问一次就打印一整段堆栈警告**。而本函数被每秒一次的反射调用、
     * 且 nearestEntity 会对场上每个实体都跑一遍 —— 结果 210 秒刷出 12.8MB 日志,
     * 差点把服务器磁盘写满。只用 name 和 displayName 就够了。
     */
    /*
     * 🔴 HOSTILE_RE 是【子串】匹配,于是 `skeleton_horse` 撞上了 `skeleton`。
     * 实测代价(2026-09-16 全天日志):
     *   「躲开 skeleton_horse(往反方向跑)」出现 59 次;
     *   更糟的是新的低血近战分支也把它当敌人:
     *   `03:00:16 ⚔️ 血量 4.17 但 skeleton_horse 是近战怪(3 格)—— 转身打它`
     * 骷髅马是【可骑乘的中立生物,不会主动攻击】。把它当敌人有两重伤害:
     *   ① 白白打断正在做的事(砍树/打猎)去逃一匹马;
     *   ② 血只剩 4 时跑去打马,而真正在射它的骷髅就在旁边。
     * 所以先做一次排除,再交给 HOSTILE_RE。
     * ⚠️ 排除项必须是"确定不会主动打人"的:骷髅马/僵尸马是坐骑;
     *    zombie_villager 是真会打人的,【绝不能】加进来。
     */
    const NOT_HOSTILE_RE = /skeleton_horse|zombie_horse/i
    const match = (x) => {
      if (!x || !x.position) return false
      const n = `${x.name || ''} ${x.displayName || ''}`
      if (NOT_HOSTILE_RE.test(n)) return false
      return HOSTILE_RE.test(n)
    }
    const e = bot.nearestEntity(match)
    if (!e) return null
    return {
      name: e.name || e.displayName || '怪物',
      dist: e.position.distanceTo(bot.entity.position),
      entity: e,
    }
  } catch (err) { return null }
}

/*
 * 找一样能吃的。【分两步,不是合成一条正则】:
 * 有面包/熟肉的时候绝不该去啃腐肉(白白中毒),
 * 但饱食度见底、又只剩腐肉时,必须让它吃 —— 否则就是上面注释里那场饿死。
 */
function foodItem() {
  try {
    const items = bot.inventory.items()
    const real = items.find((i) => FOOD_RE.test(i.name))
    if (real) return real
    if (bot.food !== undefined && bot.food <= EMERGENCY_FOOD_AT) {
      return items.find((i) => EMERGENCY_FOOD_RE.test(i.name)) || null
    }
    return null
  } catch (e) { return null }
}

function stopFollow(quiet) {
  if (following) log(`停止跟随 ${following}`)
  following = null
  if (followTicker) { clearInterval(followTicker); followTicker = null }
  try { if (bot && bot.pathfinder) bot.pathfinder.setGoal(null) } catch (e) { /* 无所谓 */ }
  try { if (bot && bot.pvp) bot.pvp.stop() } catch (e) { /* 无所谓 */ }
  if (!quiet) say('好嘞,我就在这儿等你~')
}

function startFollow(username, fromBrain) {
  const p = bot.players[username]
  if (!p || !p.entity) {
    if (!fromBrain) say(`${username},我这会儿看不见你,走近一点再喊我一声~`)
    return false
  }
  following = username
  const bind = () => {
    if (!following) return
    const cur = bot.players[following]
    if (!cur || !cur.entity) return
    try {
      bot.pathfinder.setGoal(new goals.GoalFollow(cur.entity, CFG.followRange), true)
    } catch (e) { log('设置跟随目标失败:', e.message) }
  }
  log(`开始跟随 ${username}${fromBrain ? '(大脑决定)' : ''}`)
  bind()
  if (followTicker) clearInterval(followTicker)
  followTicker = setInterval(() => {
    if (!following || !bot) return
    if (!bot.players[following]) { log(`${following} 下线了,停止跟随`); stopFollow(true); return }
    bind()
  }, 2000)
  if (!fromBrain) say(`好嘞 ${username},我跟着你走!要我停就说"在这等"。`)
  return true
}

// ——————————— 感知:把处境压缩成一小段 JSON ———————————
function buildState() {
  const p = bot.entity ? bot.entity.position : null
  const t = bot.time ? bot.time.timeOfDay : 0
  const players = Object.keys(bot.players).filter((n) => n !== bot.username)
  let woodNearby = false
  // ⚠️ 必须用 hasChoppableTree —— 和执行器同一套判据。
  // 原来这里是不带过滤的 findBlock,把别人家的墙也算成"附近有树",
  // 导致菜单说能砍、执行器说没树,模型在两者之间空转(实测 gather_wood 连续返回"32 格内没找到树")。
  /*
   * 🔴 半径必须和执行器【完全一致】,否则又是"菜单说做不到、执行器其实做得到"。
   * 实测(2026-09-16):gather_wood 被大脑选中 31 次,其中 27 次被菜单挡回,
   * 而执行器的失败话术「附近 32 格内真的没有树」一次都没出现过 —— 它根本没被调用过。
   * 同期地图字段一直写着「能砍的林子=西北边约 25~29 格」:
   *   菜单只认 24 格 → 判定没树 → 拒绝;
   *   执行器认 32 格 → 其实走得到。
   * 模型被夹在中间空转:地图告诉它那儿有林子,菜单却说这事做不到。
   * 这正是本文件注释里警告过三次的「菜单与执行器两套判据」,这次把口径钉死成 32。
   */
  try { woodNearby = hasChoppableTree(32) } catch (e) { /* 探测不到就当没有 */ }

  /*
   * 四周地形勘察 —— 这是"把该模型想的事还给模型"的关键一步。
   * 原来 explore 的方向是【随机抽】的,所以它一次次往海里冲(Owner:「一直在水里」)。
   * 现在把八个方向 20 格外是水是地探出来告诉它,让它【自己挑方向】。
   * 这类"看一眼四周再决定往哪走"正是模型该干的判断,不该用掷骰子代替。
   */
  const DIR_VEC = {
    '东': [1, 0], '东南': [0.7, 0.7], '南': [0, 1], '西南': [-0.7, 0.7],
    '西': [-1, 0], '西北': [-0.7, -0.7], '北': [0, -1], '东北': [0.7, -0.7],
  }
  /*
   * 🔴 勘察距离必须覆盖【实际会走到的距离】—— 否则模型看的和它去的不是同一个地方。
   *
   * 实测(2026-09-16,20 分钟窗口泡水 30 次,氧气一度掉到 3):
   *   这里原来只探 20 格那一个点,而 actExplore 的目标是 `24 + random()*16` = 24~40 格。
   *   于是「北边=陆地」可能指的是 20 格处,它却一头走进 30 格外的湖里。
   *   泡水前的决策五花八门(gather_wood 2 / explore北 2 / hunt 1 / explore南 1 / eat 1),
   *   共性不是某个动作,而是**目标点落在水里**。
   *   `liquidCost = 20` 只把水标成"贵",并不禁止;目标点本身在水里时照样下水。
   *
   * 改法只动【给模型看的信息】,不动任何行为逻辑:20 格和 32 格各探一个点,
   * 任一是水/岩浆就如实报成水/岩浆 —— 宁可保守,也别再骗它往湖里走。
   * ⚠️ 每个方向多一次 blockAt,共 8 次,代价可忽略
   *    (真正会卡住主线程的是上百次方块查询,那个坑在 hasChoppableTree 里已经吃过)。
   */
  const terrain = {}
  try {
    for (const [name, v] of Object.entries(DIR_VEC)) {
      let worst = null
      for (const dist of [20, 32]) {
        const b = bot.blockAt(new Vec3(p.x + v[0] * dist, p.y - 1, p.z + v[1] * dist))
        /*
         * 🔴「脚下是空气」= 悬崖/深坑,必须单独成一类。
         *
         * 实地扫描(2026-09-16,机器人在 (261,66,680),用校准过的 execute if block 逐点探):
         *   东/东南/西 三个方向是真陆地,而【北、东北、西北、西南、以及南在 32 格处】脚下都是空气。
         * 而原来的三分类是「不是水、不是岩浆 → 一律算陆地」,
         * 于是这 5 个悬崖方向全被报成"陆地"喂给模型 —— 它照着选,一头撞上悬崖,
         * 日志里就成了「往南只挪了 6 格,前面是死路」(本窗口 explore 27 次里 15 次死路)。
         * ⚠️ 这个缺陷【原来就有】,不是双距离勘察引入的;双距离只是让它更早暴露。
         * ⚠️ 只认真正的空气方块名,别用"不是固体就算悬空"那种写法 ——
         *    草、花、雪片这些 boundingBox 也不是 block,会把好路误判成悬崖。
         */
        const kind = !b ? '看不清'
          : (/water|kelp|seagrass/.test(b.name) ? '水'
            : (/lava/.test(b.name) ? '岩浆'
              : (/^(air|cave_air|void_air)$/.test(b.name) ? '悬空' : '陆地')))
        // 取两个点里"最该避开"的那个:岩浆 > 水 > 悬空 > 看不清 > 陆地
        const rank = { '岩浆': 4, '水': 3, '悬空': 2, '看不清': 1, '陆地': 0 }
        if (worst === null || rank[kind] > rank[worst]) worst = kind
      }
      terrain[name] = worst
    }
  } catch (e) { /* 探不到就不给这个字段 */ }

  const danger = nearestHostile()
  const have = woodCount()
  const st = {
    '我是谁': bot.username,
    '大目标': CFG.goalText,
    // 规划师(M1)定的阶段目标。动作要为它服务 —— 这才是"模型自己决定下一步做什么"
    '现在这一阶段要做的': currentPlan ? currentPlan.goal : '(还没定,先按大目标来)',
    '这一阶段的步骤': currentPlan && currentPlan.steps.length ? currentPlan.steps : undefined,
    '目标进度': `已存进箱子 ${storedTotal}/${CFG.goalCount} 块`,
    '目标已完成': storedTotal >= CFG.goalCount,
    '背包原木': have,
    '背包木板': countItem(/_planks$/),
    '我有家了吗': homePos ? `有,在 (${Math.round(homePos.x)},${Math.round(homePos.z)})` : '还没有,要先 explore 跑远再 set_home',
    '现在离家': homePos ? `${Math.round(bot.entity.position.distanceTo(homePos))} 格` : '—',
    /*
     * 🗡️ 「我有没有武器」必须**摆到它眼前**。
     * 实测(2026-09-16):它整场会话一次都没做过剑 —— 而材料早就齐了
     * (手上握着自己做的 3 根木棍、背包 13 块木头、家门口 24 格处就有工作台),
     * 同一窗口却死了 3 次。
     * 根因是处境里只有「背包有工作台/有箱子/有原木」,**唯独没有"我手无寸铁"这一条**。
     * 今天已经反复证明:指望小模型从"缺少某样东西"里自己推理出该去做它,是不成立的。
     * 所以摆事实,而不是加硬规则(硬规则今天已经造成过死锁)。
     */
    '我有武器吗': (() => {
      const w = WEAPON_RANK.find((n) => countItem(new RegExp('^' + n + '$')) > 0)
      return w ? `有:${w}` : '没有,空手 —— 打怪很吃亏,有木板和木棍就该去工作台做把剑'
    })(),
    '背包有木棍': countItem(/^stick$/) > 0,
    '背包有工作台': countItem(/^crafting_table$/) > 0,
    '背包有箱子': countItem(/^chest$/) > 0,
    '时间': t < 12000 ? '白天' : '晚上',
    '坐标': p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
    /*
     * 直白地告诉它"在不在地下",别指望小模型自己从坐标里算高度。
     * (和"已知规则"里那条配套:洞里我既不会挖路也不会垫方块爬高,走不远,该先出去。)
     */
    '我在地下吗': p ? (p.y < 55 ? `是的(y=${Math.round(p.y)}),在洞里走不远,该先想办法回地面` : '不在,在地面上') : '不知道',
    '血量': bot.health,
    '饥饿': bot.food,
    '附近怪物': danger ? `${danger.name},距离 ${Math.round(danger.dist)} 格` : '没有',
    '背包有食物': !!foodItem(),
    '在线玩家': players,
    /*
     * 玩家刚说的话(Owner:「让身边玩家跟他的对话来影响他的想法」)。
     * 没人说话时整个字段不出现 —— 别给小模型塞空数组,它会当成"有人说了什么"去琢磨。
     */
    '玩家刚说的话': recentChats.length ? recentChats.slice() : undefined,
    '附近有树': woodNearby,
    // 世界规则(不是它摸索出来的,是我们直接告诉它的事实,省得它一直撞墙)
    /*
     * 「已知规则」= 直接告诉它的世界常识,省得它一遍遍撞墙自己摸索。
     * 这就是 Owner 问的"现成词条"最实在的用法:**当成数据喂进提示词**。
     * ⚠️ 必须简短(小模型吃不下长文),而且最值钱的是【本服特有】的规则 ——
     * 那些网上任何资料都没有,只有 Owner 知道。
     */
    '四周20格外是什么': terrain,
    /*
     * 「我知道的地方」—— 它脑子里的地图。
     * 每类只给最近的一个、且换算成"方向+距离"(和 explore 的方向词表一致),
     * 这样它可以直接拿去 explore。⚠️ 必须极短,小模型吃不下长列表。
     */
    '我知道的地方': (() => {
      try { return p ? places.forModel(p) : undefined } catch (e) { return undefined }
    })(),
    '已知规则': [
      // 2026-09-15 实测的边界(probe.js 只破坏杂草测出来的):北 24~40 格、南 24~104、西 8~88、东至少 56
      '出生点周围几十格是管理员保护区,不能破坏;要砍树得先走远一点',
      '别的玩家也有自己圈的领地,服务器会拦住我;被拦了就换个地方,别硬撞',
      /*
       * 🔴 这一条原来写的是「我不被允许自己放方块,工作台和箱子得等人帮我放」——
       * 那是假的,而且正是它不肯自己动手的根源:我一边让它自建,一边每轮都在提示词里叫它等人。
       * Owner 明确要求:「他应该自己生产出工作台、自己制作箱子、自己摆放」。
       */
      '我可以在自己家附近盖东西(工作台、箱子都自己做自己摆),但离家太远就不准动土',
      '天黑后地面会刷僵尸、骷髅、苦力怕,晚上别在空旷地方乱逛',
      '苦力怕会自爆,血不够千万别硬扛,先 flee',
      /*
       * 地下的规则。实测 explore 有 57% 走不动,而我又禁了"挖路"和"垫方块爬高"
       * (那是为了不破坏别人的地),所以它在洞里既挖不动也爬不上去,只能绕圈。
       * 与其让它在地下硬探,不如明确告诉它:先出去。
       */
      '我不会挖路也不会垫方块爬高,所以在洞里走不远;在地下(y 小于 55)就别乱探,先想办法回地面',
      '一次探索只走二三十格,走到了就是有进展,不用每次都换方向',
      '深水里会淹死,水里还有溺尸,别往深水走',
      '饿了就 eat,饿死了什么目标都完不成',
      '卡住超过一分钟我会自动 /spawn 回出生点',
    ],
    '上一个动作': lastAction,
    '上次结果': lastOutcome,
  }
  const ls = memory.lessons(4)
  if (ls.length) st['过去的教训'] = ls          // 它自己踩过的坑(含死在哪儿)

  /*
   * 动作屏蔽:做不到的事【根本不摆上菜单】。
   * 小模型看到选项就有概率选 —— 实测它吃饱了还选 eat、没箱子还反复选 store_items。
   * 靠提示词叮嘱治不好(我已经试过并失败两次:follow_player、set_home 优先级),
   * 把选项拿掉才治得好。这和当初删掉 follow_player 是同一个道理。
   */
  /*
   * 🔴 保命动作【永远不屏蔽,也永远不冷却】:flee / fight / eat。
   * 我第一版按"此刻有没有怪"决定给不给 flee/fight —— 实测 260 秒里它两次想逃跑
   * 都被我自己挡掉(「动作flee现在做不到」),同一窗口**死了 8 次**。
   * 处境是 1~3 秒前算出来的,怪随时会冒出来;
   * **白让它逃一次的代价是零,拦住它逃的代价是死。**
   * 屏蔽只该用在"确实做不到"的生产性动作上(没树不给砍、没箱子不给存)。
   */
  /*
   * ⚠️ 这里曾经想加"没怪就不给 flee/fight"的屏蔽,**已撤回,别再加**。
   * 起因是我误读数据:看到某行摘要写着"血20"就断定"它满血还一直逃"。
   * 按血量逐条统计后真相相反 —— 14 次 flee 里 **11 次是在 ≤2.7 血时选的,逃得完全正确**,
   * 满血乱逃只有 3 次。收益只有 3/14,而风险落在这段有前科的代码上
   * (当初屏蔽保命动作导致 260 秒死 8 次)。**不值得,也不该动。**
   * 真正的病根是【没有武器】,该在那儿解决,而不是在这儿限制它逃跑。
   */
  // SURVIVAL 已提升到模块顶层(actTick 也要用),这里直接引用,别再局部重声明
  // ⚠️ 'say' 已从菜单里摘掉(Owner:不主动说话,只在被点名时回)—— 见 case 'say' 处的说明
  /*
   * 菜单先按【角色能做的动作】过一遍 —— 麦娘不该被问"要不要去打怪",
   * 因为她的档案里根本没有 fight。
   * ⚠️ 这只是"不提供";真正的拦截在 executeAction 入口(那里是第二道,防模型自己发明)。
   */
  const avail = ['explore', 'wander', 'idle', ...SURVIVAL].filter((a) => ROLE.actions.includes(a))
  if (!homePos) avail.push('set_home')
  /*
   * 「回家」只在【真的有家、而且人不在家附近】时才进菜单 ——
   * 门槛必须和执行器 actGoHome 对得上(没家必失败、已经在家也没意义),
   * 否则又是"菜单说能做、执行必然失败"那个死循环(今天已经栽过一次)。
   * 这个动作是专门给"困在地下出不来"用的:实测它能在 y=41~45 的洞里
   * 连转 27 次决策都爬不出来,而我禁了挖路和垫方块爬高,它本来毫无办法。
   */
  if (homePos && p && p.distanceTo(homePos) > 24) avail.push('go_home')
  if (woodNearby) avail.push('gather_wood')
  /*
   * 🍖 只要"饿了"就给 hunt,不要求附近真有动物 ——
   * 执行器找不到动物时会如实回「附近没有牛/猪/鸡/羊,换个地方找」,模型据此会去 explore。
   * 若改成"附近有动物才给",就又会出现"菜单说能打、执行说没有"的判据打架(今天已栽过三次)。
   * ⚠️ 饱食度不够时血量根本不回升,所以"又饿又没食物"比"血少"更紧急。
   */
  if (bot.food !== undefined && bot.food < 16) avail.push('hunt')
  /*
   * 只要地图上记着东西就给 goto_place。门槛和执行器一致:
   * 执行器找不到那类地方时会如实回「我还不记得任何 X」,模型据此自己改主意。
   * (若改成"记着某一类才给",又会变成菜单和执行器两套判据 —— 今天已栽过三次。)
   */
  try { if (places.count() > 0) avail.push('goto_place') } catch (e) { /* 查不到就不给 */ }
  if (countItem(/_log$|_planks$/) > 0) avail.push('craft')
  const canBuildHere = CFG.allowPlace || (homePos && p && p.distanceTo(homePos) <= CFG.buildRadius)
  /*
   * 🔴 这里原来是「32 格内有任何箱子就允许 store_items」—— 包括别人的。
   * 而执行器已经改成只认【自己的箱子】。两边判据一旦不一致,
   * 菜单说"能存"、执行必然失败,模型就会一次次去撞同一堵墙
   * (今天已经见过这种死循环:屏蔽逻辑和执行器不一致时它会反复重试同一个必败动作)。
   * 所以门槛必须和执行器用【同一个判据】:有没有自己的箱子。
   */
  let chestReachable = false
  try {
    if (myChest) {
      const b = bot.blockAt(new Vec3(myChest.x, myChest.y, myChest.z))
      chestReachable = !!(b && /^(chest|trapped_chest)$/.test(b.name))
    }
  } catch (e) { /* 查不到就当没有 */ }
  /*
   * 🔴 2026-09-17 06:1x 补:门槛里还缺"有没有东西可存"这一半。
   *
   * 实测 35 分钟窗口:store_items 被选中 26 次,其中 **14 次**返回
   * 「失败:身上没有可存的木头,或者箱子满了」—— 当时它背包里一块木头都没有。
   * 菜单说"能存"、执行器必然失败,模型就一次次撞同一堵墙。
   * 这正是上面那段注释自己警告过的病,只是当时只对齐了"有没有箱子"这一半。
   *
   * 执行器现在会存两类东西:①木料 ②背包空格 ≤2 时顺手清出去的家当。
   * 所以门槛也要认这两类 —— **和执行器用同一个判据,一个字不差**。
   */
  // 🔴 和执行器共用 storableNow():它算出来能存 0 样,菜单就不提供这个动作
  const worthStoring = storableNow().total > 0
  if ((chestReachable || (canBuildHere && countItem(/^chest$/) > 0)) && worthStoring) avail.push('store_items')
  /*
   * 连败 3 次以上的【生产性】动作先冷一冷;但保命动作和【脱身动作】永远不冷却。
   *
   * 🔴 为什么要把 explore/go_home 也豁免(实测教训,2026-09-15 16:24):
   * 日志里出现「大脑这次没用上:动作『explore』现在做不到」——
   * explore 因为连续"走不动"被冷却屏蔽了,可它恰恰是【换个地方】的唯一出路:
   * 它当时正卡在别人的村子里,周围的树全是房子构件,不换地方就永远砍不到木头。
   * 把出路冷掉 = 又一次"只堵不疏",和刚修完的那个死循环是同一个病根。
   * (go_home 同理:那是困在地下时的唯一脱身手段。)
   * ⚠️ 冷却只该用在"此地此时确实做不到"的生产性动作上(没树不给砍、没箱子不给存)。
   */
  const ESCAPE = ['explore', 'go_home']
  const usable = avail.filter((a) => SURVIVAL.includes(a) || ESCAPE.includes(a) || failCount(a) < 3)
  st['现在可以做的动作'] = usable.length ? usable : avail
  const streaks = {}
  for (const [k] of failStreak) { const v = failCount(k); if (v > 0) streaks[k] = `连续失败${v}次` }
  if (Object.keys(streaks).length) st['连续失败情况'] = streaks
  /*
   * 这个字段名必须和 SYSTEM 里的例题【逐字一致】。
   * 调研报告专门警告过:例子里用了的字段,实际输入里必须也有,否则模型会困惑。
   */
  const lastBase = String(lastAction).replace(/\(.*\)$/, '')
  const lastFails = failCount(lastBase)
  if (lastFails > 0) st['这个动作已连续失败'] = lastFails
  return st
}

// ——————————— 执行:每个动作都返回一句"结果",下一轮喂回给模型 ———————————

/*
 * 砍树。成功与否看【背包木头数有没有真的变多】,不看挖的动作跑没跑完。
 * 在保护区里挖,服务器会把方块悄悄恢复 —— 动作"成功"了但一无所获,
 * 必须如实记成失败,它才学得会换地方。
 */
/*
 * 🔴 分辨「树」和「人造建筑」—— 这是主人发现「AI 怎么可以拆别人的房子」的直接原因。
 *
 * 真相很朴素:孩子用原木盖的房子,墙壁就是 oak_log,和树干【是同一种方块】。
 * 原来的代码只认"名字以 _log 结尾",于是它走到人家小木屋前,把墙当树砍了。
 * 领地保护只管【圈了地的】范围;野外没圈地的建筑,服务器本来就不拦 —— 得我们自己不动手。
 *
 * 判据两条,必须【同时】成立才准砍:
 *   1. 上方有树叶(真正的树才有树冠)
 *   2. 周围 3 格内没有任何人造方块(木板/楼梯/门/玻璃/箱子/床/火把…)
 * 宁可漏砍几棵真树,也绝不能再拆人家一面墙 —— 漏砍没损失,拆墙是不可逆的。
 */
const MANMADE_RE = /planks|stairs|slab|fence|_door|glass|wool|concrete|brick|torch|lantern|crafting_table|chest|furnace|bed$|carpet|ladder|trapdoor|sign|terracotta|copper|iron_block|gold_block|quartz|prismarine|purpur|sandstone|smooth_|polished_|cut_|bookshelf|barrel|banner|glazed|shulker|anvil|campfire|note_block|jukebox|piston|rail|scaffolding|stone_bricks|cobblestone|deepslate|wall$/

/*
 * 判断"这根原木上面有没有树冠"。
 *
 * 🔴 往上只扫 10 格是不够的(实测教训):
 * CoreProtect 显示它砍的主要是【云杉】(spruce_log 66 / spruce_leaves 71),
 * 而云杉树干常常十几二十格高、树冠只在顶部 —— 从树干底部往上扫 10 格够不着树叶,
 * 于是真树被误判成"不是自然长的树"而拒砍(日志里"原木上面没有树叶"就是这么来的)。
 * 改成:① 往上扫 20 格;② 一路向上只要还是原木就继续(整根树干都算证据),
 *       ③ 横向多看两格,兼顾 2x2 的大云杉。
 * ⚠️ 放宽这条是安全的:**真正防拆房的是"周围有没有人造方块"那一条**,这里只是辅助判据。
 */
function hasLeavesAbove(pos) {
  const OFF = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]
  for (let dy = 1; dy <= 20; dy++) {
    for (const [dx, dz] of OFF) {
      const b = bot.blockAt(pos.offset(dx, dy, dz))
      if (b && /_leaves$/.test(b.name)) return true
    }
  }
  return false
}

function manmadeNear(pos) {
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz))
        if (b && MANMADE_RE.test(b.name)) return b.name
      }
    }
  }
  return null
}

/** 只有"有树冠 + 周围没人造物"的原木才算真树。 */
function isNaturalTree(block) {
  if (!block || !block.position) return false
  if (!hasLeavesAbove(block.position)) return false
  if (manmadeNear(block.position)) return false
  return true
}

/*
 * 🔴 「这棵树到底能不能砍」的【唯一判据】—— 菜单门槛和执行器必须都调它。
 *
 * 为什么非抽出来不可(今天同类问题的第三次):
 *   buildState 原来用 `findBlock(原木, 24格)` 算"附近有树",**不带任何过滤**,
 *   于是别人家的墙、已被否决的树全算数;而执行器要过领地、过 badLogs、过护栏。
 *   结果:菜单说"有树,可以砍" → 模型选 gather_wood → 执行器回"32 格内没找到树" → 再选 → 死循环。
 *   (前两次是 store_items 的箱子判据、动作屏蔽与执行器不一致。)
 * **凡是"能不能做 X"的门槛,必须和 X 的执行器读同一个函数,绝不各写一套。**
 */
function canChop(b, pos) {
  if (!b) return false
  // 刚被服务器以"这是别人的地"拒绝过的那一带,3 分钟内绕开
  if (claimDenyPos && Date.now() - lastClaimDenyAt < 180000 && pos.distanceTo(claimDenyPos) < 24) return false
  if (isBadLog(pos)) return false
  return isNaturalTree(b)
}

/** 附近有没有【真的能砍】的树。菜单门槛专用,判据和执行器完全一致。 */
// 默认半径 32 —— 和 actGatherWood 的 findBlocks({ maxDistance: 32 }) 保持同一口径(见调用处的说明)
function hasChoppableTree(maxDistance = 32) {
  try {
    /*
     * 只看最近 8 根太窄:若这 8 根恰好都是同一栋房子的构件,就会误报"附近没树",
     * 而真树可能就在稍远一点的地方(Owner:「明明树就在边上,他会说边上没有树」)。
     * 放宽到 24 根,代价只是多几次廉价的方块查询。
     */
    const cands = bot.findBlocks({ matching: logIds(), maxDistance, count: 24 })
    for (const pos of cands) {
      if (canChop(bot.blockAt(pos), pos)) return true
    }
  } catch (e) { /* 探不到就当没有 */ }
  return false
}

/*
 * 🧹 背包满了就把杂物扔掉 —— 这是 2026-09-17 凌晨用 RCON【逐槽位点名】点出来的硬阻塞。
 *
 * 现场证据(36 个槽位逐个查 + 槽 99 做负对照):【36 格全满,0 个空格】。
 * 于是 collectblock 的 emptyInventoryIfFull() 走进 emptyInventory(),
 * 而我们从来没设过 chestLocations → Inventory.js:48 直接抛
 * 'There are no defined chest locations!' —— 4.5 小时里那 20 次「砍不动」全是这么来的。
 * 🔴 这不是概率性失败,是【每一次砍树都必然失败】,和附近有没有树完全无关。
 *    我之前把砍树转化率 14% 归因成"找不到能砍的树",错了。
 *
 * 同一个原因还解释了另一条我一直没懂的报错:
 *   「失败:合成跑完了,但背包里没多出 crafting_table(等了 N 秒也没出现)」
 *   —— 背包满了,合成出来的东西没地方放。原注释以为是时序问题,不是。
 *
 * 塞满它的全是杂物:41 泥土、31 树苗、25 木棍、13 腐肉、13 线、9 沙、
 * 8 蜘蛛眼、6 骨头、5 箭(它没有弓)、4 羽毛、2 铁轨、各种种子。
 *
 * 判据用【真的一个空格都没有】,而不是"快满了":
 * 必须和执行器(collectblock 的 emptySlotCount() === 0)用【同一个判据】,
 * 否则又是一个"菜单说能做、执行必然失败"的死循环 —— 今天已经为这类病修过箱子那一个了。
 *
 * ⚠️ 只扔【对它的目标(木头→工具→房子→打末影龙)毫无用处】的东西,宁可少扔也不扔错:
 *    线留着(能做弓对付骷髅)、树苗留着(能补种树)、泥土和沙留着(是建材)、
 *    食物一概不扔(它身上 66 块熟牛肉),装备和带 components 的特殊物品一概不碰
 *    (可能是服务器给的东西或别人送的)。
 * ⚠️ 扔在地上的东西 2 秒后它自己还能捡回来(原版 pickupDelay),
 *    所以这招是"腾出格子让当下这次动作能做",不是"永久丢弃";它走开之后才真的丢掉。
 */
const JUNK_RE = /^(rotten_flesh|spider_eye|poisonous_potato|arrow|feather|egg|rail|wheat_seeds|pumpkin_seeds|melon_seeds|beetroot_seeds|torchflower_seeds|bone|white_wool)$/
let lastTidyAt = 0
async function tidyInventory() {
  if (!bot || !bot.inventory) return 0
  if (bot.inventory.emptySlotCount() > 0) return 0          // 和 collectblock 同一个判据
  if (Date.now() - lastTidyAt < 30000) return 0             // 节流放在真的满了之后,别白跑
  lastTidyAt = Date.now()
  const junk = bot.inventory.items().filter((i) => JUNK_RE.test(i.name))
  if (!junk.length) {
    // 这条日志就是"下一步该做什么"的判据:如果它反复出现,说明背包被【有用的东西】塞满了,
    // 那时该做的是"满了就回家存箱子"的硬规则,而不是继续扩大可扔清单。
    log(`🧹 背包 36 格全满、却没有可以扔的杂物 —— 砍树和合成都会一直失败,得回家存箱子。`
      + `现有:${bot.inventory.items().map((i) => `${i.name}×${i.count}`).join(' ')}`)
    return 0
  }
  let freed = 0
  const names = []
  for (const it of junk) {
    try {
      await bot.tossStack(it)
      freed++
      names.push(`${it.name}×${it.count}`)
      await new Promise((r) => setTimeout(r, 120))   // 别一梭子丢完,服务器装着 GrimAC 反作弊
    } catch (e) { log(`🧹 扔 ${it.name} 没成功:${short(e.message)}`) }
  }
  log(`🧹 背包满了(0 空格)—— 扔掉 ${freed} 样没用的杂物(${names.join('、')}),现在空出 ${bot.inventory.emptySlotCount()} 格`)
  return freed
}

async function actGatherWood() {
  // 背包一格不剩的话,collectblock 会在挖之前就抛错,树再多也砍不到 —— 先腾格子
  await tidyInventory()
  const before = woodCount()
  let dug = 0
  let rejected = null
  for (let n = 0; n < 6; n++) {
    let block
    try {
      /*
       * ⚠️ 性能教训(这是我上一版自己捅的娄子):
       * 原来把护栏塞进 findBlock 的 useExtraInfo,等于让它对【整片森林的每一根原木】
       * 都跑一遍上百次方块查询 —— 主线程被卡死,实测决策间隔出现 129 秒,
       * 比 30 秒封顶还长,连计时器都挤不进来,砍树 3 次全部超时被掐。
       * 改法:先廉价地取最近的 12 根原木,再由近及远最多验 12 次,代价封顶。
       */
      const cands = bot.findBlocks({ matching: logIds(), maxDistance: 32, count: 12 })
      for (const pos of cands) {
        const b = bot.blockAt(pos)
        if (!b) continue
        /*
         * 刚被服务器以"这是别人的地"拒绝过的那一带,3 分钟内一律绕开。
         * 不加这条的话就会重演实测那一幕:7 秒里被拒 15 次,一块没挖到,还被 skeleton 射死。
         * ⚠️ 护栏只认"像不像建筑",认不出"是不是别人的地" ——
         * 长在别人领地里的真树,树叶和周围都合格,照样会被它盯上。这一条正是补那个缺口。
         */
        if (claimDenyPos && Date.now() - lastClaimDenyAt < 180000 && pos.distanceTo(claimDenyPos) < 24) {
          if (!rejected) rejected = '那一带是别人的领地,服务器不让我动,我得换个地方'
          continue
        }
        // 之前判定过"不能砍"的那几棵,10 分钟内直接跳过 —— 不然每轮都会重新搜到它们
        if (isBadLog(pos)) continue
        // 最终判定也走 canChop —— 这样菜单和执行器【不可能】再漂移成两套标准
        if (canChop(b, pos)) { block = b; break }
        // 第一个被否掉的候选,记下原因 —— 让它知道"这儿有木头但我不能动",而不是"这儿没树"
        if (!rejected) {
          const why = manmadeNear(b.position)
          const at = `(${b.position.x},y=${b.position.y},${b.position.z})`
          /*
           * ⚠️ 必须把【是哪块、在哪里】记进日志,否则这类拒绝无法复查。
           * 之前"原木上面没有树叶"只有一句结论,我无法判断到底是真的人造物、
           * 还是我的判据漏掉了高云杉 —— 不可诊断的东西没法修(Y 坐标那次就是这么吃的亏)。
           */
          rejected = why
            ? `附近那些原木旁边有「${why}」,像是别人盖的房子,我不能拆`
            : '附近那些原木上面没有树叶,不像自然长的树,我不砍'
          log(`🌲 不砍 ${b.name} ${at}:${why ? `旁边有人造方块「${why}」` : '上方 20 格内找不到树叶'}`)
        }
        // 记下这一棵,10 分钟内不再考虑 —— 否则下一轮还会搜到同一批,永远原地打转
        rememberBadLog(pos)
      }
    } catch (e) { break }
    if (!block) break
    const woodBeforeThis = woodCount()
    /*
     * 🔴 开工前把【全局 Movements】拨回 collectBlock 自己那份。
     *    这是补我今晚自己捅的娄子 —— 如实记一下,免得以后忘了为什么有这段。
     *
     * 今晚我给 pvp 那份设了 canDig=false(为了不让它打完架之后挖穿别人的地),
     * 但 CollectBlock.js:70 的 mineBlock 第一句读的是【全局当前】那份的 safeToBreak:
     *   if (blockAt(...).type !== block.type || ... || !bot.pathfinder.movements.safeToBreak(block))
     *     { removeTarget(block); return }
     * 而 movements.js 的 safeToBreak 第一句是 `if (!this.canDig) return false`。
     * → 只要 pvp 打过一架、把全局 Movements 换成了它那份,这棵树就会被【静默跳过】:
     *   零木头、零报错,collect() 还正常 resolve。
     *
     * collect() 自己在开头也会装一次(CollectBlock.js:194),但那是在它被调用【之后】,
     * 而且 pvp.attack() 随时能再换掉。在这里先拨回来,至少把"刚打完架"这个最常见的情形盖住;
     * 路上才打起来的那种,下面那段 🔬 诊断会如实记下来。
     *
     * ⚠️ 不走"把 pvp 的 canDig 改回 true"这条路:那等于把刚补上的护栏又拆了。
     */
    try {
      const cmv0 = bot.collectBlock && bot.collectBlock.movements
      const gm0 = bot.pathfinder && bot.pathfinder.movements
      if (cmv0 && gm0 !== cmv0) {
        const whose = gm0 === (bot.pvp && bot.pvp.movements) ? 'pvp 那份'
          : gm0 === myMoves ? '我自己那份' : '不认识的第四份'
        bot.pathfinder.setMovements(cmv0)
        log(`🔧 开工前把全局寻路配置从「${whose}」(canDig=${gm0 ? gm0.canDig : '?'})拨回 collectBlock 自己那份`
          + ` —— 不拨回来的话这棵树会被静默跳过(零木头零报错)`)
      }
    } catch (e) { log('拨回寻路配置失败:', e.message) }
    try {
      await bot.collectBlock.collect(block)   // 走过去 + 挖掉 + 捡起掉落物
      dug++
      /*
       * 🔬 诊断「静默跳过」:collect() 正常返回(不抛错)却一块木头都没多。
       *
       * 机制是读 collectblock 1.6.0 的源码得到的,不是猜的:
       *   CollectBlock.js:70 的 mineBlock 第一句 ——
       *     if (… || !bot.pathfinder.movements.safeToBreak(block)) { removeTarget(block); return }
       *   它读的是【全局当前】那份 Movements,而不是 collect() 开头给自己装上的那份;
       *   movements.js:252 的 safeToBreak 第一句 —— if (!this.canDig) return false。
       *
       * 而我们给 pvp 那份设了 canDig=false(为了不让它挖穿别人的地),
       * pvp.attack() 又会把全局 Movements 换成它那份。
       * → 走过去的那几秒里一旦打起来,这棵树就被【静默跳过】:零木头、零报错、
       *   collect() 还正常 resolve。178 次尝试里那批"既不成功也不报错"的很可能就是它。
       *
       * ⚠️ 这条只是取证。证实之前不改行为 —— canDig 同时管着"寻路能不能挖路开道",
       *    直接放开会让它挖穿别人的建筑,那是 Owner 的红线。
       */
      if (woodCount() === woodBeforeThis) {
        const gm = bot.pathfinder && bot.pathfinder.movements
        const cmv = bot.collectBlock && bot.collectBlock.movements
        const pmv = bot.pvp && bot.pvp.movements
        const which = gm === cmv ? 'collectBlock 自己那份(正常)'
          : gm === pmv ? '🔴 pvp 那份'
          : gm === myMoves ? '🔴 我自己那份'
          : '未知的第四份'
        log(`🔬 挖完 ${block.name} (${Math.round(block.position.x)},${Math.round(block.position.z)}) 却一块木头没多`
          + ` —— 此刻全局 Movements 是「${which}」canDig=${gm ? gm.canDig : '?'}`)
      }
      // ⚠️ collect() 会把全局 movements 换成它自己那份且不还原 —— 每次都换回我的
      if (myMoves) { try { bot.pathfinder.setMovements(myMoves) } catch (e) { /* 忽略 */ } }
    } catch (e) {
      if (dug === 0) return `失败:砍不动(${short(e.message)})`
      break
    }
  }
  const gained = woodCount() - before
  if (gained > 0) {
    // 记下这片能砍的林子 —— 下次木头不够时,它就知道该往哪个方向回来
    try { places.remember('tree', bot.entity.position, `砍到${gained}块`) } catch (e) { /* 记地图失败不能影响砍树 */ }
    return `成功:背包木头 ${before} → ${before + gained}(+${gained})`
  }
  if (dug > 0) {
    // ⚠️ 只报【观察到的事实】,不替它断定原因。
    // 上一版这里写死成"这里是禁止破坏的保护区",可在 (-56,44) 那次真实原因是寻路超时,
    // 照样被贴上"保护区"的标签 —— 等于把一个没核实的原因当事实喂进经验库,它会学歪。
    // 原因可能是领地保护,也可能是掉落物没捡到,这里不猜,只说"这地方砍了没用"。
    const p = bot.entity ? bot.entity.position : null
    const at = p ? `(${Math.round(p.x)},${Math.round(p.z)})` : '这儿'
    return `失败:在 ${at} 挖了 ${dug} 块,但背包一块没多 —— 这地方砍了白砍,换个地方`
  }
  // 附近其实有原木,只是被判成了人造建筑 —— 要如实说明,否则它会以为"这儿没树"而学歪
  if (rejected) return `失败:${rejected}(换个没人住的地方找真正的树)`
  /*
   * ⚠️ Owner:「明明树就在边上,他会说边上没有树」。
   * 原来这句只说"没找到树",【分不清】两种完全不同的情况:
   *   ① 这儿真的一棵树都没有;
   *   ② 周围明明有原木,但一根都不能砍(别人的建筑 / 刚否决过 / 在别人领地里)。
   * 两者该做的事完全不同(②要走远,①换方向就行),而且分不清就没法验证 Owner 的观察。
   * 所以这里如实报出"看见几根原木、一根都不能砍"。
   */
  let rawNear = 0
  try { rawNear = bot.findBlocks({ matching: logIds(), maxDistance: 32, count: 30 }).length } catch (e) { /* 数不到就算了 */ }
  if (rawNear > 0) {
    log(`🌲 附近有 ${rawNear} 根原木,但没有一根能砍(别人的建筑/刚否决过/别人领地)`)
    return `失败:附近有 ${rawNear} 根原木,但没有一根是我能砍的(不是别人的建筑就是刚否决过)—— 要走远一点换片林子`
  }
  return '失败:附近 32 格内真的没有树,换个方向走'
}

/*
 * 走远一点换个地方找树。
 *
 * ⚠️ 又是"成功的定义"栽的跟头,和砍树那次一模一样:
 * 最早这里只是 setGoal 就立刻返回"成功",根本没等它走到。结果它刚迈开腿,
 * 25 秒后大脑又让它砍树,它就近找了棵还在保护区里的树 —— 永远走不出去,
 * 进度卡在 16/64 一动不动,日志上却全是"成功往远处走了149格"。
 *
 * 现在改成【等它真的走完】,而且用「实际位移了多少格」判定成功,不看下没下达指令。
 */
/*
 * 安家。Owner 的方案:让它自己跑出去,找个它认为安全的地方设成家,
 * 之后所有建造都只在这个家周围进行 —— 既不碰别人的地,它也终于有地方可以建东西。
 * 服务器实测回执:成功时机器人会收到「Home set to current location.」
 */
async function actSetHome() {
  const p = bot.entity.position
  if (bot.oxygenLevel !== undefined && bot.oxygenLevel < 20) {
    return '失败:我正在水里,先上岸再安家'
  }
  /*
   * 家必须安在正经陆地上。第一版只查"此刻没泡在水里",结果把家安在了 y=62 的海边,
   * 之后它就一直在水边打转、反复被溺尸追。所以还要查:脚下是实心、高于海平面、旁边没有水。
   */
  const under = bot.blockAt(p.offset(0, -1, 0))
  if (!under || under.name === 'air' || /water|lava/.test(under.name)) {
    return '失败:脚下不是实地,不能在这儿安家'
  }
  /*
   * 64 → 62(海平面)。实测这一版卡死就卡在这儿:6 次 set_home 全被打回
   * (「这里太低 y=63」两次、y=44 一次…),同时天黑又把 explore 也关了 → 它无路可走。
   * 旁边 3 格有水就不许安家的检查还在,海岸线本来就由那条挡着,这里不必再多挡 2 格。
   */
  if (p.y < 62) {
    return `失败:这里太低(y=${Math.round(p.y)}),多半是海边或坑里,往高处走一走再安家`
  }
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, -3]]) {
    const b = bot.blockAt(p.offset(dx, -1, dz))
    if (b && /water/.test(b.name)) return '失败:旁边就是水,家不能安在水边,再往内陆走走'
  }
  // 出生点那一圈是保护区,家安在那儿等于白安
  const d = Math.hypot(p.x - SPAWN.x, p.z - SPAWN.z)
  if (d < CFG.homeMinDist) {
    return `失败:这里离出生点才 ${Math.round(d)} 格(要 ${CFG.homeMinDist} 格以上),那一带是保护区,先 explore 走远再安家`
  }
  say('/sethome base')
  homePos = p.clone()
  saveHome()   // 落盘,重启不丢
  return `成功:把家安在了 (${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}),以后能 /home 回来,也能在这附近建东西了`
}

/*
 * 自己把基地建起来:回家 → 做木板 → 做工作台 → 自己摆下 → 做箱子 → 自己摆下。
 *
 * Owner 的原话:「他应该自己生产出工作台、自己制作箱子、自己摆放,而不是我给他来做」。
 * 做成【一条代码硬规则驱动的复合动作】,不拆成几个动作交给模型挑,原因有二:
 *   ① 实测它揣着 22 块木头在野外 idle/wander 空转 —— 这正是"看起来傻"的样子;
 *   ② 今天已在 set_home 和 follow_player 上两次验证:**前置条件类的事靠提示词叮嘱不管用**。
 * 放置只在自己家 buildRadius 格内进行(围栏本来就允许),绝不碰别人的地。
 */
/*
 * 回家 —— 专治"困在洞里出不来"。
 *
 * 实测(2026-09-15)Owner 说的"路痴"真相:加上 Y 日志后发现,
 * 整整一轮 27 次决策【全部】发生在 y=41~45 的地下,坐标只在十几格内挪动。
 * 它出不来,是因为我为了不破坏别人的地禁掉了「挖路」和「垫方块爬高」——
 * 于是它在洞里既挖不动也爬不上去,只能绕圈。
 *
 * ⚠️ 我之前在"已知规则"里写了「在地下就别乱探,先想办法回地面」,
 * 却【没给它任何"回地面"的手段】—— 给了建议不给手段,和之前
 * "一边让它自建、一边告诉它等人帮忙"是同一种自相矛盾。这个动作就是补上那只手。
 * 用的是它已经有且验证过的能力:EssentialsX 的 /home。
 */
async function actGoHome() {
  if (!homePos) return '失败:我还没有家,回不去(得先安家)'
  const before = bot.entity.position.clone()
  say('/home base')
  await new Promise((r) => setTimeout(r, 4000))
  const now = bot.entity.position
  const moved = now.distanceTo(before)
  // Owner 可能在游戏里把家挪了 —— 先认新家,再算距离,不然"到了新家"会被算成失败
  adoptHomeIfMoved(before, 'go_home')
  const dHome = now.distanceTo(homePos)
  if (dHome <= 16) {
    return `成功:传送回家了,现在在 (${Math.round(now.x)},y=${Math.round(now.y)},${Math.round(now.z)})`
  }
  if (moved > 8) return `失败:动了 ${Math.round(moved)} 格但没到家,离家还有 ${Math.round(dHome)} 格`
  return `失败:/home 没起作用(可能在冷却或被打断),还在 (${Math.round(now.x)},y=${Math.round(now.y)},${Math.round(now.z)})`
}

async function actBuildBase() {
  if (!homePos) return '失败:还没有自己的家,先安家再建东西'
  const steps = []

  // 1) 先回家 —— 只有家附近才准动土
  let d = bot.entity.position.distanceTo(homePos)
  if (d > CFG.buildRadius) {
    const beforeTp = bot.entity.position.clone()
    say('/home base')
    await new Promise((r) => setTimeout(r, 3500))
    adoptHomeIfMoved(beforeTp, 'build_base')
    d = bot.entity.position.distanceTo(homePos)
    if (d > CFG.buildRadius) return `失败:想回家建东西,但传送后仍离家 ${Math.round(d)} 格`
    steps.push('回到了家')
  }

  // 2) 备料:工作台要 4 个木板,箱子要 8 个 —— 不够就用原木现做
  for (let i = 0; i < 3 && countItem(/_planks$/) < 12; i++) {
    const r = await actCraft('planks')
    if (!r.startsWith('成功')) break      // 没原木了就算了,下面会如实报出来
  }
  steps.push(`木板 ${countItem(/_planks$/)} 个`)

  // 3) 工作台:没有就做,做完自己摆下来
  const mcData = require('minecraft-data')(bot.version)
  let table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 8 })
  if (!table) {
    if (countItem(/^crafting_table$/) === 0) {
      const r = await actCraft('crafting_table')
      steps.push(`做工作台:${r}`)
      if (!r.startsWith('成功')) return `失败:${steps.join(' | ')}`
    }
    table = await placeFromInventory('crafting_table')
    if (!table) return `失败:${steps.join(' | ')} | 工作台没摆下来:${lastPlaceFail || '原因不明'}`
    steps.push('自己摆好了工作台')
  }

  // 4) 箱子:没有就做(要工作台),做完自己摆下来,并记成「我的箱子」
  if (countItem(/^chest$/) === 0) {
    const r = await actCraft('chest')
    steps.push(`做箱子:${r}`)
    if (!r.startsWith('成功')) return `失败:${steps.join(' | ')}`
  }
  const placed = await placeFromInventory('chest')
  if (!placed) return `失败:${steps.join(' | ')} | 箱子没摆下来:${lastPlaceFail || '原因不明'}`
  saveMyChest(placed.position)
  steps.push(`自己摆好了箱子 (${Math.round(placed.position.x)},${Math.round(placed.position.z)})`)
  return `成功:${steps.join(' | ')} —— 从现在起我有自己的工作台和箱子了`
}

async function actExplore(dirName) {
  const from = bot.entity.position.clone()
  /*
   * 方向优先由【模型】指定(它看过"四周20格外是什么"再挑),没给才退回随机试探。
   * 这就是 Owner 要的"多用 AI 算力解决问题":选方向本来就是判断题,不该掷骰子。
   */
  const DIR_VEC = {
    '东': 0, '东南': Math.PI / 4, '南': Math.PI / 2, '西南': 3 * Math.PI / 4,
    '西': Math.PI, '西北': 5 * Math.PI / 4, '北': 3 * Math.PI / 2, '东北': 7 * Math.PI / 4,
  }
  if (dirName && DIR_VEC[dirName] !== undefined) {
    const a = DIR_VEC[dirName]
    /*
     * 🔴 Owner:「XiaoMai 是个路痴,一直来回跑」—— 实测他说对了,而且根子在这里。
     * 原来一口气奔 90~150 格:在树林/山谷/洞里根本到不了,走十来格就撞墙,
     * 然后判失败、文案还写"那个方向走不通,换一个" → 模型就真换方向 →
     * 下一轮再走十来格再换 → 在玩家眼里就是【来回跑】。
     * 实测 68 次 explore 里 39 次"走不动"(57%),位移集中在 4~19 格。
     * 改法:① 一次只走 24~40 格(够得着,才可能成功);
     *       ② 走到 8 格以上就算【有进展】,不再当失败 —— 有进展就不该逼它换方向。
     *       ③ 超时从 75 秒降到 20 秒:短途本来就该快,而动作封顶是 30 秒。
     */
    const d0 = 24 + Math.random() * 16
    /*
     * 🔴🔴 2026-09-17 凌晨:「走不出去」的真因终于找到了 —— 不是地形,是【目标本身不可达】。
     *
     * 上面那段注释里我已经改过一轮(把一口气 90~150 格降到 24~40 格、成功门槛降到 8 格),
     * 治的是症状。真正的病根在这一行用的 Goal 类型:
     *
     *   原来:new goals.GoalNear(目标x, 【from.y】, 目标z, 4)
     *
     * 源码实据(node_modules/mineflayer-pathfinder/lib/goals.js,我们实际装的 2.4.5):
     *   GoalNear.isEnd:  (dx*dx + 【dy*dy】 + dz*dz) <= rangeSq     ← 三维,算高度
     *   GoalNearXZ.isEnd: (dx*dx + dz*dz) <= rangeSq               ← 只算水平
     *   而 GoalNearXZ 上面那行库作者自己的注释原话是:
     *   "Useful for finding builds that you don't have an exact Y level for,
     *    just an approximate X and Z level" —— 说的正是我们这个场景。
     *
     * 所以原来的写法是:要求它走到 30 多格外、【而且那里的地面高度正好和现在一样(±4)】。
     * 在丘陵/山谷地形上这个条件几乎不成立 → 目标点根本不可达 →
     * A* 要么超时(`Took to long to decide path to goal!`),
     * 要么返回空路径,而 goto 对空路径是【无错误地 resolve】(goto.js:22-24,上游已承认是 bug)
     * → 我们这边测出"只挪了 N 格"记成失败。
     *
     * 一句话:我一直在让它去一个不存在的地方,然后怪它走不到。
     * 改成 GoalNearXZ:只要求走到那个【水平位置】附近,地面高低随地形 —— 这才是"往西北走 30 格"的本意。
     */
    const g = new goals.GoalNearXZ(from.x + Math.cos(a) * d0, from.z + Math.sin(a) * d0, 4)
    try {
      await Promise.race([
        bot.pathfinder.goto(g),
        new Promise((_, rej) => setTimeout(() => rej(new Error('20秒没走到')), 20000)),
      ])
    } catch (e) { try { bot.pathfinder.setGoal(null) } catch (e2) { /* 忽略 */ } }
    const moved0 = bot.entity.position.distanceTo(from)
    if (moved0 < 8) return `失败:往${dirName}只挪了 ${Math.round(moved0)} 格,前面是死路(墙/悬崖/水),换个方向`
    return `成功:往${dirName}走了 ${Math.round(moved0)} 格,现在在 (${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)})`
  }
  /*
   * ⚠️ 两个实测教训都在这儿:
   * 1) 目标点是随便抽的,经常抽到海里 → 它一头扎进水里(Owner:「ai玩家一直在水里」)。
   *    远处区块没加载、看不到是不是水,所以改成【探近处】:往某个方向 12 格和 24 格处
   *    是水就换方向,至少别主动朝海走。
   * 2) goto 没有超时 → 走不到就一直卡着,240 秒里大脑只决策了 1 次。加 75 秒超时。
   */
  let ang = null
  for (let n = 0; n < 10; n++) {
    const a = Math.random() * Math.PI * 2
    let wet = false
    for (const r of [12, 24]) {
      const b = bot.blockAt(new Vec3(from.x + Math.cos(a) * r, from.y - 1, from.z + Math.sin(a) * r))
      if (b && /water|lava|kelp|seagrass/.test(b.name)) { wet = true; break }
    }
    if (!wet) { ang = a; break }
  }
  if (ang === null) return '失败:四面八方近处都是水,这地方不能探,先想办法离开水边'
  // 和上面同样的道理:短途才走得到。一口气奔 90~150 格是"来回跑"的根源。
  const d = 24 + Math.random() * 16
  // 同上:水平目标,不要求高度一致(理由见上面 explore 那段 GoalNearXZ 的注释)
  const goal = new goals.GoalNearXZ(from.x + Math.cos(ang) * d, from.z + Math.sin(ang) * d, 4)
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, rej) => setTimeout(() => rej(new Error('75秒没走到')), 75000)),
    ])
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch (e2) { /* 忽略 */ }
    // 没走到也不算白跑,下面按"实际挪了多远"如实判定
  }
  const now = bot.entity.position
  const moved = now.distanceTo(from)
  if (moved < 20) return `失败:只挪了 ${Math.round(moved)} 格,没走出去(可能被地形或水挡住了)`
  return `成功:真的走了 ${Math.round(moved)} 格,现在在 (${Math.round(now.x)},${Math.round(now.z)})`
}

function actWander() {
  const p = bot.entity.position
  try {
    // 同上:水平目标。"随便走走"更不该要求高度一致 —— 半径才 2 格,山坡上必然不可达。
    bot.pathfinder.setGoal(new goals.GoalNearXZ(p.x + (Math.random() * 2 - 1) * 16, p.z + (Math.random() * 2 - 1) * 16, 2))
    return '成功:随便走走'
  } catch (e) {
    return `失败:走不了(${short(e.message)})`
  }
}

/*
 * 打架前先把最好的武器拿到手上。
 * Owner:「他似乎打怪的时候也不会拿出武器」—— 查下来比这更糟:
 * 它【根本没有武器也不会做】(craft 白名单只有木板/工作台/箱子),而且已经被骷髅射死过。
 * 现在 craft 能做剑了,这里补上"拿出来"这一步 —— 做得出来却不拿,等于白做。
 * ⚠️ 故意不 await:actFight 是同步函数,被每秒一次的反射调用;
 *   装备晚一拍不要紧(pvp 插件会持续追打,后面几下就带上武器了),
 *   但把它改成 async 会牵动所有调用点,风险更大。
 */
const WEAPON_RANK = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']
function equipBestWeapon() {
  try {
    const items = bot.inventory.items()
    for (const name of WEAPON_RANK) {
      const it = items.find((i) => i.name === name)
      if (it) {
        const held = bot.heldItem && bot.heldItem.name
        if (held !== name) {
          bot.equip(it, 'hand').catch(() => { /* 装备失败不能打断打架 */ })
          log(`🗡️ 拿出 ${name} 再打`)
        }
        return name
      }
    }
  } catch (e) { /* 拿不出来就空手上,总比不打强 */ }
  return null
}

/*
 * 🍖 打猎弄肉吃 —— 补上"从哪弄到食物"这个一直缺失的环节。
 *
 * 实测事故(2026-09-15 16:51):它【饿死了】。
 *   血3.5 食2 → 食1 → 血1.5 → 死亡 → 复活满血满饱食
 * Minecraft 里饱食度不够就**不回血**,而它背包没食物、动作清单里也没有任何能产出食物的动作,
 * 于是:没吃的 → 不回血 → 血低只会逃跑 → 采不到东西 → 还是没吃的 → 饿死 → 复活 → 重来。
 * **这不是偶发故障,是必然循环。** 有 eat 却没有获取食物的手段,
 * 和"叫它回地面却没有 go_home"是同一个病根(第五次)。
 */
const PREY_RE = /^(cow|pig|chicken|sheep|rabbit|mooshroom)$/i

/*
 * 🗺️ 去地图上记着的某个地方。
 *
 * Owner:「得让他脑子里有地图啊,不能限制他的活动范围啊」。
 * 光把地图显示给它是不够的 —— 那又是"给了信息不给手段"(今天第六次同类)。
 * 有了这个动作,它才能说"去我记得那片林子",而不是每次都靠 explore 随机撞。
 * 这是"扩大活动范围"的正确方式:**不是放宽半径,是给它有目的地走远的理由。**
 */
const PLACE_WORDS = { 林子: 'tree', 动物: 'animal', 水源: 'water', 家: 'home', 死过的地方: 'death' }

async function actGotoPlace(word) {
  const kind = PLACE_WORDS[String(word || '').trim()]
  if (!kind) return `失败:不认识「${word}」这个地方,只能去:${Object.keys(PLACE_WORDS).join('/')}`
  let target = null
  try { target = places.nearest(kind, bot.entity.position) } catch (e) { /* 查不到就当没有 */ }
  if (!target) return `失败:我还不记得任何「${word}」,得先自己走一走找到过才行`

  const from = bot.entity.position.clone()
  const g = new goals.GoalNear(target.x, target.y, target.z, 4)
  try {
    await Promise.race([
      bot.pathfinder.goto(g),
      new Promise((_, rej) => setTimeout(() => rej(new Error('20秒没走到')), 20000)),
    ])
  } catch (e) { try { bot.pathfinder.setGoal(null) } catch (e2) { /* 忽略 */ } }

  const now = bot.entity.position
  const left = Math.round(now.distanceTo(new Vec3(target.x, target.y, target.z)))
  const moved = Math.round(now.distanceTo(from))
  /*
   * 远处一次走不到很正常(动作有 30 秒封顶),**只要在靠近就算有进展** ——
   * 判成失败会逼模型换目标,又回到"来回跑"的老毛病(explore 那次的教训)。
   */
  if (left <= 6) return `成功:到了我记得的「${word}」(${target.x},${target.z})`
  if (moved >= 8) return `成功:朝「${word}」走了 ${moved} 格,还差 ${left} 格,继续往那边走`
  return `失败:想去「${word}」但只挪了 ${moved} 格,路可能不通,换个走法`
}

async function actHunt() {
  if (!bot.entity) return '失败:还没准备好'
  let prey = null
  try {
    /*
     * 半径 32 → 64:实测唯一的失败原因就是「附近 32 格内没有牛/猪/鸡/羊」,
     * 而动物在世界里本来就稀疏。跑远一点去打,总好过饿死在原地
     * (上一轮它就是饱食度掉到 1 之后活活饿死的)。
     * ⚠️ 64 格仍在同一批已加载区块内,不会让它跑到看不见的地方去。
     */
    prey = bot.nearestEntity((e) => e && e.position && PREY_RE.test(String(e.name || '')) &&
      e.position.distanceTo(bot.entity.position) < 64)
  } catch (e) { /* 找不到就当没有 */ }
  if (!prey) {
    /*
     * 🔴 附近没猎物 → 【去记忆里有动物的地方】,而不是原地报个失败就完。
     *
     * 实据(2026-09-16 UTC 03:55~04:15 的 20 分钟窗口):饿死 2 次,
     * `失败:附近 64 格内没有牛/猪/鸡/羊可以打` 出现 10 次,
     * 强制打猎规则正确触发了 9 次(「血1 食0、身上一样吃的都没有 → 去打猎弄肉」),
     * 大脑也自己选了 13 次 hunt —— **每一次都停在这行 return 上**。
     * 而同一批决策的状态行里一直带着 `有动物=西北边约 96 格(打到chicken)`:
     * 它记得动物在哪,却没有任何东西让它走过去。
     * 连失败文案自己都在说"得换个地方找",可没人去找。
     *
     * places/actGotoPlace 这套机制早就有了(actHunt 打到猎物时会 places.remember('animal')),
     * 这里直接复用,不新增任何状态。
     * ⚠️ 记忆可能过时(那群动物被杀光了),所以只当"有进展"报告,不谎报成功;
     *    走到了下一次 hunt 自然就能在 64 格内找到。
     */
    let memAnimal = null
    try { memAnimal = places.nearest('animal', bot.entity.position) } catch (e) { /* 没记忆就按没有算 */ }
    if (memAnimal) {
      const r = await actGotoPlace('动物')
      /*
       * 🔴 走近了就算【成功】,不能一律判成失败。
       *
       * 这是我自己在上一版埋的雷,实测 2026-09-16 UTC 07:55:46 饿死一次,死因链很清楚:
       *   附近没动物 → 走这条回退 → 返回值以「失败:」开头
       *   → failStreak('hunt') 累加 → 连续 3 次 → hunt 被冷却屏蔽 3 分钟
       *   → 强制打猎规则的前置条件 failCount('hunt') < 3 不成立 → 根本打不了猎
       *   → 死前 60 秒全在 explore,一次打猎都没有 → 饿死。
       * **回退明明在朝目标走近,却被自己的连败退避锁死了。**
       *
       * 这条教训代码里早就有(见 actGotoPlace 的注释:
       * 「远处一次走不到很正常,只要在靠近就算有进展;判成失败会逼模型换目标」),
       * 我加回退的时候没照着做。现在按 actGotoPlace 自己的判定来:
       * 它说成功(= 在靠近或已到达)就算成功,它说失败才算失败。
       */
      if (String(r).startsWith('成功')) {
        return `成功:附近没动物,正在朝记忆里有动物的地方走 —— ${r}`
      }
      return `失败:附近 64 格内没有动物,去记忆里那个地方也没走成 —— ${r}`
    }
    return '失败:附近 64 格内没有牛/猪/鸡/羊可以打,而且我还没记住任何有动物的地方,得往草地方向走走'
  }

  const name = prey.name
  /*
   * 🔴 【看到】动物就记下来,不要等到打死了才记。
   *
   * 原来只在成功击杀后才 places.remember('animal', ...),这造成一个自锁死结:
   * 打不到 → 不记 → 记忆过期后彻底为空 → hunt 找不到猎物也没地方可去 → 更打不到。
   * 实测(2026-09-16 UTC 03:55~04:15):饿死 2 次,hunt 尝试 22 次全部停在"附近没有动物",
   * 而 places.json 里 animal 条目是 0。
   * 看见就记的好处是:哪怕这一只没打着,"这片地方有动物"这个事实已经落账,
   * 下次饿了就有地方可去。记的是【我当前的位置】而不是动物的位置 ——
   * 我站得到的地方一定走得回来,动物那一格未必(可能在水里/悬崖上)。
   */
  try { places.remember('animal', bot.entity.position, `见到${name}`) } catch (e) { /* 记地图失败不能影响打猎 */ }
  const before = countItem(FOOD_RE)
  let dist0 = 999
  try { dist0 = prey.position.distanceTo(bot.entity.position) } catch (e) { /* 取不到就按 999 算 */ }
  equipBestWeapon()                       // 有剑就拿出来,空手打很慢
  /*
   * 🔴 追击要【在同一个动作里追到底】,不能走一趟就收工。
   *
   * 实测(2026-09-16 20:09~20:13):一趟能推进 12/21/23/24/26/39/41/46 格 —— 推进力完全够;
   * 但四次追到 15 格以内都没打着,因为这一趟结束后,下一趟总被别的事插队:
   *     还差 5 格  → 被僵尸打死
   *     还差 13 格 → 规划师插进来
   *     还差 15 格 → 模型自己改选 explore
   *     还差 8 格  → 保命传送把它从猎物旁边拽回了家
   *   11 次 hunt 只成功 1 次。
   * 根因:goto 的目标是猎物【刚才】站的位置,而猎物一直在动 —— 一次 goto 必然落在它身后。
   * 改法:同一个动作里多追几程,直到够得着、或不再靠近、或预算用完。
   *
   * ⚠️ 预算 16 秒:整个动作被 ACT_CAP_MS(30 秒)封顶,后面还要留 8 秒打 + 约 2 秒捡肉。
   * ⚠️「这一程没真的靠近就停」:绕障碍白耗不如把时间还给下一轮重新选目标,
   *    否则又变成"一个动作把大脑堵死"(那个坑今天已经吃过)。
   */
  const CHASE_BUDGET_MS = 16000
  const chaseStart = Date.now()
  let lastD = dist0
  for (let n = 0; n < 3; n++) {
    if (prey.isValid === false) break
    if (Date.now() - chaseStart > CHASE_BUDGET_MS) break
    let dBefore = 999
    try { dBefore = prey.position.distanceTo(bot.entity.position) } catch (e) { break }
    if (dBefore <= 5) break                     // 够得着了,去打
    try {
      await bot.pathfinder.goto(new goals.GoalNear(prey.position.x, prey.position.y, prey.position.z, 2))
    } catch (e) { /* 走没走到,下面用真实距离判断,不再靠猜 */ }
    let dAfter = 999
    try { dAfter = prey.position.distanceTo(bot.entity.position) } catch (e) { break }
    if (dAfter >= lastD - 1) break               // 这一程没真的靠近 → 别再耗
    lastD = dAfter
  }
  /*
   * 🔴 走到了才打 —— 没走到就别挥空刀。
   *
   * 实测(2026-09-16 19:04~19:05,强制打猎上线后连开三枪):
   *   RCON 逐半径探测:8/16/24/32 格【全空】,48 格才有 pig;
   *   而 actHunt 认 64 格,于是它锁定了 48 格外那只猪;
   *   goto 走不到(抛异常)被 catch 吞掉 → 原来这里【不管走没走到都 pvp.attack】
   *   → 对着 48 格外的猪挥空刀 → 干等 8 秒 → 「失败:打了 pig 但没拿到肉」。
   *   两次耗时 12 秒和 9 秒,连 30 秒封顶都没用上 —— 时间全花在白等上。
   *
   * 改法照搬 actGotoPlace 已经验证过的那套"走近了就算有进展":
   * 判成彻底失败会逼模型换目标,又回到"来回跑"的老毛病;
   * 如实告诉它"还差多少格、继续往那边走",它才有机会走拢再打。
   */
  let dNow = 999
  try { dNow = prey.position.distanceTo(bot.entity.position) } catch (e) { /* 猎物没了 */ }
  if (prey.isValid === false) return `失败:${name} 已经不在了,重新找一只`
  if (dNow > 5) {
    const closed = Math.round(dist0 - dNow)
    if (closed >= 8) return `成功:朝 ${name} 走近了 ${closed} 格,还差 ${Math.round(dNow)} 格,继续往那边走就能打到`
    return `失败:够不着 ${name}(还差 ${Math.round(dNow)} 格,路可能不通)—— 往有草地的方向走,找近一点的动物`
  }
  try { bot.pvp.attack(prey) } catch (e) { return `失败:打不了 ${name}(${short(e.message)})` }
  await new Promise((r) => setTimeout(r, 8000))   // 等打死
  try { bot.pvp.stop() } catch (e) { /* 忽略 */ }

  // 掉落的肉要走过去才捡得到
  try {
    const drop = bot.nearestEntity((e) => e && e.name === 'item' &&
      e.position.distanceTo(bot.entity.position) < 10)
    if (drop) await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0))
  } catch (e) { /* 捡不到就算了,下面按实际数量如实汇报 */ }
  await new Promise((r) => setTimeout(r, 1500))

  const gained = countItem(FOOD_RE) - before
  if (gained > 0) {
    // 记下这片有动物的地方 —— 下次饿了直接来,而不是原地打转(上一轮它就是这么饿死的)
    try { places.remember('animal', bot.entity.position, `打到${name}`) } catch (e) { /* 记地图失败不能影响打猎 */ }
    return `成功:打到 ${name},拿到 ${gained} 份食物,可以 eat 了`
  }
  return `失败:打了 ${name} 但没拿到肉(可能没打死,或掉的肉没捡到)`
}

function actFight() {
  const d = nearestHostile()
  if (!d) return '失败:附近没有怪物,不用打'
  try {
    equipBestWeapon()
    bot.pvp.attack(d.entity)
    return `成功:开始打 ${d.name}(距离 ${Math.round(d.dist)} 格,血量 ${bot.health})`
  } catch (e) {
    return `失败:打不了(${short(e.message)})`
  }
}

function actFlee() {
  const d = nearestHostile()
  if (!d) return '失败:附近没有怪物,不用逃'
  try {
    try { bot.pvp.stop() } catch (e) { /* 没在打就算了 */ }
    const p = bot.entity.position
    let away = p.minus(d.entity.position)
    if (!away.norm || away.norm() < 0.001) away = { x: 1, z: 0 }   // 贴脸时给个默认方向,免得 NaN
    else { const n = away.normalize(); away = { x: n.x * 24, z: n.z * 24 } }
    /*
     * 🔴 逃跑也踩了同一个坑(GoalNear 算高度)—— 而这一条是【保命】动作。
     * 24 格外 + 半径 3 格 + 要求地面高度和现在一样,在山坡上必然不可达 →
     * A* 超时或返回空路径 → 它【根本不逃】,站在原地被打死。
     * 改 GoalNearXZ:往反方向的那个水平位置跑,高低随地形。
     */
    bot.pathfinder.setGoal(new goals.GoalNearXZ(p.x + away.x, p.z + away.z, 3))
    return `成功:躲开 ${d.name}(往反方向跑)`
  } catch (e) {
    return `失败:逃不掉(${short(e.message)})`
  }
}

async function actEat() {
  const f = foodItem()
  if (!f) return '失败:背包里没有吃的'
  const before = bot.food
  try {
    await bot.equip(f, 'hand')
    await bot.consume()
    return `成功:吃了 ${f.name},饥饿 ${before} → ${bot.food}`
  } catch (e) {
    return `失败:没吃成(${short(e.message)})`
  }
}

/** 背包里符合某个名字规则的物品总数。所有"成功与否"都靠它前后比对,不靠动作跑没跑完。 */
function countItem(re) {
  try {
    return bot.inventory.items().filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0)
  } catch (e) { return 0 }
}

/**
 * 从背包拿一个方块放到身边。
 * ⚠️ 不能放在自己脚下(那格被自己占着),要放在旁边那格 —— 所以是"以旁边脚下那块为基准,往上放"。
 */
/*
 * 放置失败的【真实原因】。
 * 🔴 为什么需要它:调用方原来一律按 `if (!CFG.allowPlace)` 来编失败文案,
 * 而 ALLOW_PLACE 默认就是 0 → 这个条件永远成立 →
 * 哪怕它正站在自己家里、围栏明明放行、只是周围没地方放,
 * 它也会说"我不被允许自己放方块,需要有人给我放一个" ——
 * 这句假话既骗了模型(它会一直等人来帮忙),也骗了主人(我据此让主人去给它放箱子)。
 * 今天第七次栽在"把没核实的原因当事实"上。现在由放置函数自己如实记录原因。
 */
let lastPlaceFail = ''
/*
 * 「放方块总闸」的两个开关。
 * placeAllowedAt 只在真正动手放置的那一瞬间存着【那一格的坐标】;
 * 其余时间一律 false,于是寻路库的自动搭桥/搭塔会被总闸挡下(见 bot.placeBlock 的包装)。
 * ⚠️ 这两个变量必须在这里声明:我先写了总闸却忘了声明,那样第一次放箱子就是 ReferenceError。
 */
/*
 * 🔴 总闸从"布尔开关"升级成"只放行指定的那一格"。
 *
 * 起因是我自己引入的并发风险:挡箭(coverFromArrows)是 fire-and-forget 跑的
 * ——不等它,免得堵住逃跑——所以它把总闸打开的那几百毫秒里,
 * 机器人正被寻路驱动着跑。布尔开关在那一瞬间对【任何】放置请求都放行,
 * 等于总闸失效。虽然两份 Movements 都已 allow1by1towers=false + scafoldingBlocks=[],
 * 寻路理论上不会放方块,但总闸的全部意义就是"不管库怎么变都兜得住"。
 * 现在只放行【坐标完全对得上】的那一次,并发窗口里的其它放置照样拦。
 */
let placeAllowedAt = null   // 允许放置的基准方块坐标(Vec3),null = 一律禁止
let placeBlocked = 0

async function placeFromInventory(itemName) {
  lastPlaceFail = ''
  try {
    /*
     * 只允许在【它自己的家附近】放方块 —— 这是 Owner 定的规矩:不碰别人的地。
     * 没安家 = 一块都不许放;安了家 = 只能在家周围 buildRadius 格内动土。
     * (ALLOW_PLACE=1 是一个全局逃生开关,平时不开。)
     */
    // 有家、但离家太远 → 先 /home 传送回家再建(实测它安完家就被溺尸追跑了,回来要走一百多格)
    if (!CFG.allowPlace && homePos && bot.entity.position.distanceTo(homePos) > CFG.buildRadius) {
      log(`离家 ${Math.round(bot.entity.position.distanceTo(homePos))} 格,先 /home base 回家再放 ${itemName}`)
      const beforeTp = bot.entity.position.clone()
      say('/home base')
      await new Promise((r) => setTimeout(r, 3500))
      adoptHomeIfMoved(beforeTp, 'place')   // 这里只等 3.5 秒,赶不上 say() 里那次 5 秒的后台核对
    }
    const nearHome = homePos && bot.entity.position.distanceTo(homePos) <= CFG.buildRadius
    if (!CFG.allowPlace && !nearHome) {
      lastPlaceFail = homePos
        ? `离家 ${Math.round(bot.entity.position.distanceTo(homePos))} 格,只能在家附近 ${CFG.buildRadius} 格内建东西`
        : '还没有自己的家,得先安家才能建东西'
      log(`不放 ${itemName}:${lastPlaceFail}`)
      return null
    }
    const it = bot.inventory.items().find((i) => i.name === itemName)
    if (!it) { lastPlaceFail = `背包里没有 ${itemName}`; return null }
    await bot.equip(it, 'hand')
    // 只试 4 个正方向不够用(实测工作台放不下来,把整条制作链卡死了),把斜角也算上
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
    let tried = 0
    for (const off of dirs) {
      const base = bot.blockAt(bot.entity.position.offset(off[0], -1, off[1]))
      const space = bot.blockAt(bot.entity.position.offset(off[0], 0, off[1]))
      if (!base || base.name === 'air' || !space || space.name !== 'air') continue
      tried++
      try {
        // 只在这一瞬间打开总闸 —— 这是全程唯一允许放方块的地方
        placeAllowedAt = base.position
        try {
          await bot.placeBlock(base, new Vec3(0, 1, 0))
        } finally {
          placeAllowedAt = null   // 无论成败都要立刻关上,绝不能留着
        }
        const put = bot.blockAt(bot.entity.position.offset(off[0], 0, off[1]))
        if (put && put.name === itemName) return put
      } catch (e) { /* 这个方向放不了就换一个 */ }
    }
    lastPlaceFail = `周围放不下(8 个方向里只有 ${tried} 个像是能放的,都没成),多半站在水里或不平的地方`
    log(`放不下 ${itemName}:${lastPlaceFail}`)
    return null
  } catch (e) { lastPlaceFail = `放的时候出错(${short(e.message)})`; return null }
}

/*
 * 🔴 应对弓箭手:在自己和射手之间【放一块方块挡箭】。
 *
 * 这是 Owner 点名要的("另外要想法应对弓箭手"),也是全天死因第一名:
 *   服务器权威死亡 30 次里,被射死 10 次(骷髅 8 + 掠夺者 2)—— 比近战怪砍死的 6 次还多。
 *
 * 为什么原来的"冲上去贴脸打"是台绞肉机(实测距离分布,全天):
 *     703 次 在 10 格外就冲   192 次 在 15 格外   84/81/68 次 在 14/13/12 格外
 *     ≥10 格就冲的 ≈ 1174 次,≤5 格才冲的只有 ≈ 180 次
 *   死前 24 秒的铁证(01:54:46~01:55:12):7 次连续冲锋,
 *   **血量全程卡在 14.5 一动不动** —— 说明它一步都没走到,纯站着喂箭,然后被射死。
 *   骷髅射程 16 格、约 2 秒一箭;赤手空拳跑 15 格要吃 3 箭。
 *   而且 RCON 逐样点名证实它【没有剑、没有护甲、没有盾、没有弓】(只有 2 支箭没有弓),
 *   背包里却有 110 个原木 —— 有料没做成东西。这种装备下中远距离硬冲必死。
 *
 * 挡箭是 Minecraft 里对付骷髅的标准解:箭走直线,中间有一格实心方块就打不着。
 * 它背包里的原木正好能放。放在【头的高度】,因为箭是朝眼睛飞的。
 *
 * ⚠️ 这里【故意绕过】placeFromInventory 的"只能在家附近建"限制。
 *   那条规矩是为了不碰别人的地盘(它曾把别人用原木盖的房子当树砍),
 *   而保命时在野外放一块木头不属于"动别人的东西";真要是放进了谁的领地,
 *   GriefPrevention 会在【服务端】直接拒绝 —— 服务器本身就是那道保险,
 *   所以这条路径最坏情况是白放一次,不可能破坏别人的建筑。
 * ⚠️ 4 秒节流:放方块要等服务端回执,每秒都试会把反射层堵死。
 * ⚠️ 全程 fail-safe:拿不到方块/周围放不下/服务端拒绝 —— 一律返回 false,
 *   由调用方照旧去跑"拉开距离",绝不因为挡箭失败就站在原地。
 */
const COVER_BLOCKS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry)_log$|^(cobblestone|dirt|stone|oak_planks|spruce_planks|birch_planks)$/
let lastCoverAt = 0
let coverOk = 0
let coverFail = 0
async function coverFromArrows(target) {
  const now = Date.now()
  if (now - lastCoverAt < 4000) return false
  lastCoverAt = now
  try {
    if (!bot || !bot.entity || !target || !target.position) return false
    const it = bot.inventory.items().find((i) => COVER_BLOCKS.test(i.name))
    if (!it) { coverFail++; lastPlaceFail = '背包里没有能挡箭的方块'; return false }
    const me = bot.entity.position
    const dx = target.position.x - me.x
    const dz = target.position.z - me.z
    // 朝射手方向迈一步的那一格(只取主轴,斜着放挡不住)
    const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0
    const sz = sx === 0 ? Math.sign(dz) : 0
    if (sx === 0 && sz === 0) return false
    await bot.equip(it, 'hand')
    // 先试头的高度(箭打脸),不行再试脚的高度
    for (const h of [1, 0]) {
      const cell = me.offset(sx, h, sz)
      const space = bot.blockAt(cell)
      const base = bot.blockAt(cell.offset(0, -1, 0))
      if (!space || space.name !== 'air') continue
      if (!base || base.name === 'air' || /water|lava/.test(base.name)) continue
      placeAllowedAt = base.position
      try {
        await bot.placeBlock(base, new Vec3(0, 1, 0))
      } finally {
        placeAllowedAt = null   // 无论成败立刻关闸,绝不留着
      }
      const put = bot.blockAt(cell)
      if (put && put.name !== 'air') {
        coverOk++
        log(`🧱 在自己和 ${target.name || '射手'} 之间放了一块 ${it.name} 挡箭(第 ${coverOk} 次成功)`)
        return true
      }
    }
    coverFail++
    return false
  } catch (e) { coverFail++; return false }
}


/* ══════════════════════════════════════════════════════════════════
 * 🧱 盖房子的物理前提:往【指定坐标】放一块方块
 *
 * Owner 的要求原话:「怎么造房子是他自己来决策啦 我非常期待小麦可以自己造出房子」。
 * 但它现在【连一面墙都砌不出来】:全文唯一的建造出口 placeFromInventory
 * 只能"在自己脚边的地面上放一块"(基准 = 脚下偏移 (dx,-1,dz),朝上 (0,1,0)),
 * 没有任何往上叠、贴侧面的能力。这一段就是补那只手。
 *
 * 🔑 【总闸不用改】:已核实 bot.placeBlock 的包装器只比较
 *    refBlock.position 的三个整数和 placeAllowedAt,**完全不看 faceVector** ——
 *    所以贴顶面/侧面/底面都是白送的扩展点。
 *
 * 🔴 并发:coverFromArrows(挡箭)是反射层 fire-and-forget 调的(不 await),
 *    和这里共用同一个 placeAllowedAt。后跑完的 finally 会把前一个的许可抹成 null,
 *    于是前一个被【自己的总闸】拦下抛错。所以加一把锁,而且
 *    **挡箭抢占、砌墙让路** —— 被射死是全天死因第一名,挡箭不检查这把锁;
 *    砌墙这边自己回避,撞上就当"下轮再来",不写任何负面状态。
 *    ⚠️ 绝不要为了"解决"这件事把总闸改回布尔 —— 那是它当初被升级成坐标匹配的原因。
 * ══════════════════════════════════════════════════════════════════ */

// 可以被当成空气覆盖掉的方块
const REPLACEABLE_RE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|vine|sugar_cane|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|.*_tulip)$/
// 🔴 对着这些方块发放置包 = 打开它的界面,不是放方块(mineflayer 不会潜行)。绝不能当基准。
const INTERACT_RE = /chest|barrel|furnace|crafting_table|_door|trapdoor|button|lever|sign|bed$|anvil|note_block|jukebox|shulker|hopper|dropper|dispenser|brewing|enchant|beacon|lectern|loom|smithing|stonecutter|grindstone|cartography|composter|campfire|candle|flower_pot|bell/
// 保守起点。服务端上限约 4.5,但我没实测过 —— 探针会把真实距离打出来,再据此校准。
const PLACE_REACH = parseFloat(process.env.PLACE_REACH || '3.6')

let placeLockOwner = ''
let placeLockAt = 0
function takePlaceLock(who) {
  const n = Date.now()
  // 12 秒自愈:比最坏持有时间(equip + lookAt + placeBlock 的 5 秒等待)还长
  if (placeLockOwner && n - placeLockAt < 12000) return false
  placeLockOwner = who
  placeLockAt = n
  return true
}
function freePlaceLock(who) { if (placeLockOwner === who) { placeLockOwner = ''; placeLockAt = 0 } }

function eyePos() { return bot.entity.position.offset(0, 1.62, 0) }

/**
 * 往 target 这一格放一块 itemName。
 * @returns {{ok:boolean, code:string, why:string, dist:number, ms:number, face?:string}}
 *   code: ok | already | occupied | self | nosupport | toofar | noitem | busy | guard | refused | error
 *
 * 🔴 code 和 why 都只讲【真实原因】,一个字都不许猜。
 *    placeFromInventory 的唯一失败文案是"周围放不下…多半站在水里或不平的地方",
 *    连服务器拒绝时也照说这句 —— 那句假话会经 memory.record 写进经验库反复喂回模型。
 * 🔴 服务器拒绝那一句【至少五个成因】(实体挡路 / 手上不是可放的物品 / 放到自己身上 /
 *    领地保护 / 反作弊取消),所以只报"服务器把这一格又变回去了",
 *    **永远不许翻译成"这块地不是我的"**。
 */
async function placeAt(target, itemName) {
  const t0 = Date.now()
  const fail = (code, why, dist) => ({ ok: false, code, why, dist: dist || 0, ms: Date.now() - t0 })
  try {
    if (!bot || !bot.entity || !bot._placeGuardInstalled) return fail('guard', '放方块总闸还没装好,再等等')
    const cur = bot.blockAt(target)
    if (!cur) return fail('toofar', `(${target.x},${target.y},${target.z}) 那一格还没加载出来`)
    // 幂等:已经是要的方块就当成功(重连/回执丢了/重复施工都靠这条兜住)
    if (cur.name === itemName) return { ok: true, code: 'already', why: '本来就已经是这块方块', dist: 0, ms: Date.now() - t0 }
    if (!REPLACEABLE_RE.test(cur.name)) return fail('occupied', `那一格已经是 ${cur.name},不是空的`)
    // 绝不往自己身体占的两格里放
    const f = bot.entity.position.floored()
    if (target.x === f.x && target.z === f.z && (target.y === f.y || target.y === f.y + 1)) {
      return fail('self', '那是我自己站着的地方')
    }
    const d = eyePos().distanceTo(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5))
    if (d > PLACE_REACH) return fail('toofar', `离那一格 ${d.toFixed(1)} 格,手伸不到(上限 ${PLACE_REACH})`, d)
    const it = bot.inventory.items().find((i) => i.name === itemName)
    if (!it) return fail('noitem', `背包里没有 ${itemName}`, d)
    // 挑基准面:底面 → 4 个侧面 → 顶面。face 是【从基准指向目标】的方向。
    const DIRS = [[0, -1, 0, '底面'], [1, 0, 0, '东侧'], [-1, 0, 0, '西侧'],
      [0, 0, 1, '南侧'], [0, 0, -1, '北侧'], [0, 1, 0, '顶面']]
    let ref = null; let face = null; let faceName = ''
    for (const dd of DIRS) {
      const n = bot.blockAt(target.offset(dd[0], dd[1], dd[2]))
      if (!n || REPLACEABLE_RE.test(n.name)) continue          // 空的,当不了基准
      if (INTERACT_RE.test(n.name)) continue                   // 对着它放 = 开界面
      if (/water|lava/.test(n.name)) continue
      ref = n
      face = new Vec3(-dd[0], -dd[1], -dd[2])                  // 基准 + face = 目标
      faceName = dd[3]
      break
    }
    if (!ref) return fail('nosupport', '这一格六面都没有能当基准的实体方块(悬空)', d)
    await bot.equip(it, 'hand')
    await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), false)   // false = 正常转头速度,别瞬移(反作弊)
    placeAllowedAt = ref.position
    try {
      await bot.placeBlock(ref, face)
    } finally {
      placeAllowedAt = null   // 无论成败立刻关闸
    }
    const put = bot.blockAt(target)
    if (put && put.name === itemName) {
      return { ok: true, code: 'ok', why: `放上了(基准是${faceName})`, dist: d, ms: Date.now() - t0, face: faceName }
    }
    return fail('refused', `发出去了但那一格现在是 ${put ? put.name : '读不到'} —— 服务器没让它成立`, d)
  } catch (e) {
    // 🔴 原话照抄,绝不翻译成"这块地不是我的" —— 同一句话至少五个成因
    return fail('error', `放的时候报错:${short(e.message)}`)
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 🔬 P0 物理探针(只在 ~/mcbot/PROBE_PLACE.on 存在时跑一次,跑完自己删掉标记)
 *
 * 唯一目的:用【真实的服务器】回答五件到现在还只是推理的事 ——
 *   ① 它到底能不能把方块往上叠(砌墙的物理前提)
 *   ② 总闸放不放行"非顶面"的基准(贴侧面)
 *   ③ 这台服真实的手长是多少(把实测距离打出来,好校准 PLACE_REACH)
 *   ④ 服务器/反作弊会不会把放置取消掉(看 refused 的原话)
 *   ⑤ 领地保护到底回哪一句
 *
 * 零模型、零菜单、只在家附近动土、放的是泥土(建材,而且 MANMADE_RE 不含 dirt,
 * 不会让门口的真树被误判成"别人的房子")。放下的方块【不挖回去】——
 * 那本来就是墙的第一批砖。
 * ────────────────────────────────────────────────────────────────── */
let probePlaceDone = false
let lastProbeCheckAt = 0
async function runPlaceProbe() {
  const F = require('path').join(__dirname, 'PROBE_PLACE.on')
  const finish = (msg) => {
    log(`🔬 探针汇总:${msg}`)
    try { require('fs').unlinkSync(F) } catch (e) { log('删探针标记失败:', e.message) }
  }
  if (!homePos) { log('🔬 探针:还没有家,先不动土'); return }
  const dHome = bot.entity.position.distanceTo(homePos)
  if (dHome > CFG.buildRadius) {
    log(`🔬 探针:离家 ${Math.round(dHome)} 格(>${CFG.buildRadius}),等它回家再跑 —— 标记先留着`)
    probePlaceDone = false   // 不算跑过,下次再来
    return
  }
  const dirt = bot.inventory.items().find((i) => i.name === 'dirt')
  if (!dirt || dirt.count < 3) { finish(`背包里泥土只有 ${dirt ? dirt.count : 0} 块,不够探(要 3 块),这次放弃`); return }
  if (!takePlaceLock('probe')) { log('🔬 探针:放置锁被占(多半在挡箭),下轮再来'); probePlaceDone = false; return }
  try {
    const me = bot.entity.position.floored()
    // 找一个脚边 2 格、地面是实体、上面是空的落脚点
    let base0 = null
    for (const dd of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]]) {
      const c = me.offset(dd[0], 0, dd[1])
      const ground = bot.blockAt(c.offset(0, -1, 0))
      const space = bot.blockAt(c)
      if (!ground || REPLACEABLE_RE.test(ground.name) || /water|lava/.test(ground.name)) continue
      if (!space || !REPLACEABLE_RE.test(space.name)) continue
      base0 = c
      break
    }
    if (!base0) { finish('脚边 6 个方向都找不到"地面是实的、上面是空的"落脚点,这次放弃'); return }
    const res = []
    // 第 1 块:脚边地面(基准 = 它下面那块的顶面)—— 这是已有能力的对照
    res.push(['① 地面一块(顶面基准)', await placeAt(base0, 'dirt')])
    // 第 2 块:叠在第 1 块上面 —— 🔴 这就是"能不能往上砌"的关键一问
    res.push(['② 叠在上面(顶面基准)', await placeAt(base0.offset(0, 1, 0), 'dirt')])
    // 第 3 块:贴在第 2 块的侧面 —— 🔴 测总闸放不放行"非顶面"基准
    res.push(['③ 贴侧面(侧面基准)', await placeAt(base0.offset(1, 1, 0), 'dirt')])
    // 第 4 块:再往上一层 —— 测手长上限
    res.push(['④ 再叠一层(测手长)', await placeAt(base0.offset(0, 2, 0), 'dirt')])
    let okN = 0
    for (const [tag, r] of res) {
      if (r.ok) okN++
      log(`🧱 探针 ${tag}: ${r.ok ? '✅ 成功' : '❌ 失败'} code=${r.code} 距离=${r.dist.toFixed(2)} 耗时=${r.ms}ms ${r.face ? '基准=' + r.face : ''} —— ${r.why}`)
    }
    log(`📏 实测:眼睛在 y+1.62,PLACE_REACH 当前设 ${PLACE_REACH};` +
      `四次的距离分别是 ${res.map(([, r]) => r.dist.toFixed(2)).join(' / ')}`)
    finish(`${okN}/4 成功。` + (okN >= 2
      ? '✅ 它的手能往上砌 —— 盖房子的物理前提成立,可以做 P1(砌一圈墙)'
      : '❌ 往上砌没成功,P1 先别动,看上面每一行的 code 和原话'))
  } finally {
    freePlaceLock('probe')
  }
}



/* ══════════════════════════════════════════════════════════════════
 * 🛡️ 把身上的盔甲穿起来
 *
 * 2026-09-17 05:2x 查实:它护甲槽【四格全空】,而背包里躺着
 * 金胸甲×2、金头盔、皮头盔,还有三件附魔的(水下速掘 / 保护II / 水下呼吸II)。
 * 而服务器难度是 **Hard**。
 *
 * 真实死亡数据(读服务器自己的玩家统计 world/stats/<uuid>.json,
 * 这才是权威 —— 见下面那条更正):**931 次 / 30.9 小时 ≈ 每小时 30 次**。
 *
 * 🔴 顺带更正一个我一直用错的基准:
 *    我整晚拿 `grep latest.log` 当"服务器权威死因",算出来每小时 3~7 次。
 *    实测对照统计文件:**控制台日志漏记死亡约 5~10 倍**。
 *    以后要真实死亡数,读 `world/stats/<uuid>.json` 的 minecraft:deaths,
 *    而且【两次读之前都要先 save-all】—— 统计是定时落盘的,
 *    只在第二次前 save-all 会把"上次存盘以来的累计"错算成"这段时间的增量"(我刚踩过)。
 *
 * ⚠️ 排序只看材质,不看附魔和耐久 —— 所以一件"保护II 的金甲"会输给一件白板铁甲。
 *    这是已知的取舍:分不清就先按材质,总比四格全空强。
 *    (社区有 mineflayer-armor-manager 专门干这个,但它同样只看材质名前缀,
 *     而且我们不想为这件事再多一个依赖。)
 * ══════════════════════════════════════════════════════════════════ */
const ARMOR_SLOTS = [
  { slot: 5, dest: 'head', re: /_helmet$/, cn: '头盔' },
  { slot: 6, dest: 'torso', re: /_chestplate$/, cn: '胸甲' },
  { slot: 7, dest: 'legs', re: /_leggings$/, cn: '护腿' },
  { slot: 8, dest: 'feet', re: /_boots$/, cn: '靴子' },
]
const ARMOR_RANK = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
function armorScore(name) {
  for (let i = 0; i < ARMOR_RANK.length; i++) {
    if (String(name).startsWith(ARMOR_RANK[i] + '_')) return ARMOR_RANK.length - i
  }
  if (/^turtle_helmet$/.test(name)) return 4      // 海龟壳约等于铁
  return 0
}
let lastArmorAt = 0
async function wearBestArmor() {
  if (!bot || !bot.inventory) return 0
  if (Date.now() - lastArmorAt < 30000) return 0
  lastArmorAt = Date.now()
  let n = 0
  for (const s of ARMOR_SLOTS) {
    const worn = bot.inventory.slots[s.slot]
    const wornScore = worn ? armorScore(worn.name) : 0
    let best = null
    for (const it of bot.inventory.items()) {          // items() 不含护甲槽,不会把已穿的again 算进来
      if (!s.re.test(it.name)) continue
      if (armorScore(it.name) > (best ? armorScore(best.name) : 0)) best = it
    }
    if (!best) continue
    if (armorScore(best.name) <= wornScore) continue
    try {
      await bot.equip(best, s.dest)
      n++
      log(`🛡️ 穿上${s.cn} ${best.name}${worn ? `(换下 ${worn.name})` : '(原来这格是空的)'}`)
      await new Promise((r) => setTimeout(r, 150))     // 别一梭子换完,服务器装着 GrimAC
    } catch (e) { log(`🛡️ 穿 ${best.name} 没成功:${short(e.message)}`) }
  }
  return n
}

/* ══════════════════════════════════════════════════════════════════
 * 🏠 自己盖一间房子
 *
 * Owner 2026-09-17 原话:「怎么造房子是他自己来决策啦 我非常期待小麦可以自己造出房子」。
 *
 * 分工(和 chat() 的 give 字段同一套,那次 Owner 纠正过我"别把判断写进代码"):
 *   **模型定**:用什么材料、门朝哪边、盖多大 —— 人格和当下处境该起作用的地方。
 *   **代码定**:哪几格要放、够不够得着、放不放得下、别人的地不能碰 —— 几何和物理。
 * 🔴 为什么不让模型自己算坐标:实测这类小模型"从菜单挑一个 + 输出严格 JSON"可靠(5/5),
 *    但空间判断很差、游戏知识常错。让它吐坐标 = 把最不可靠的能力放在最关键的位置。
 *
 * 🔴 为什么【不进决策菜单】,而是一条硬规则:
 *    实测拿真实系统提示打真网关,"空手"处境下 6/6 次模型都选了 craft stick,
 *    build_house 一次没被选中。本代码里已有两个同类 0 采纳先例
 *    (「写了最优先安家」→ 240 秒 0 次 set_home;「把我空手摆到眼前 + 写做剑优先级很高」→ 做剑 0 次)。
 *    **靠菜单结构和硬规则,别靠叮嘱。**
 *
 * 🔴 硬规则的位置:排在【吃饭和打猎之后】。
 *    依据是本文件里那条血的教训:forced 是单一插槽,craft 排在 eat/hunt 前面,
 *    结果它"做木板做到饿死"。盖房子比做木板更长,更不能抢在吃饭前面。
 * ══════════════════════════════════════════════════════════════════ */
const HOUSE_FILE = require('path').join(__dirname, 'house.json')
let house = null
let buildHousePausedUntil = 0
function saveHouse() {
  try { require('fs').writeFileSync(HOUSE_FILE, JSON.stringify(house)) }
  catch (e) { log('存房子进度失败:', e.message) }
}
function loadHouse() {
  try {
    const h = JSON.parse(require('fs').readFileSync(HOUSE_FILE, 'utf8'))
    if (h && h.origin && typeof h.origin.x === 'number') {
      house = h
      log(`读到房子进度:地基 (${h.origin.x},${h.origin.y},${h.origin.z}) 边长 ${h.size} 材料 ${h.material} 门朝${h.door}`
        + ` —— ${h.done ? '已盖好' : '还没盖完'}`)
    }
  } catch (e) { /* 还没开工,正常 */ }
}

// 门开在哪一格(墙上的一列,两层都不放)
function doorCell(size, door) {
  if (door === '北') return { dx: 1, dz: 0 }
  if (door === '南') return { dx: 1, dz: size - 1 }
  if (door === '西') return { dx: 0, dz: 1 }
  return { dx: size - 1, dz: 1 }        // 东
}

// 这间房子要放的全部格子,按【先下层后上层】排序(下层塌了上层没处贴)
function houseBlocks(h) {
  const out = []
  const dc = doorCell(h.size, h.door)
  for (let y = 0; y < h.height; y++) {
    for (let dz = 0; dz < h.size; dz++) {
      for (let dx = 0; dx < h.size; dx++) {
        const onWall = dx === 0 || dz === 0 || dx === h.size - 1 || dz === h.size - 1
        if (!onWall) continue
        if (dx === dc.dx && dz === dc.dz) continue    // 门洞:整列都不放
        out.push(new Vec3(h.origin.x + dx, h.origin.y + y, h.origin.z + dz))
      }
    }
  }
  return out
}

/*
 * 选地基:在家附近找一块【地面是实的、上面两层是空的】的正方形。
 * ⚠️ 只看周长那一圈的格子 —— 屋里有什么(比如它自己的箱子)不影响,
 *    反而把箱子圈进屋里是好事。
 */
function pickHousePlot(size) {
  if (!homePos) return null
  const hx = Math.floor(homePos.x)
  const hy = Math.floor(homePos.y)
  const hz = Math.floor(homePos.z)
  const R = Math.max(4, Math.floor(CFG.buildRadius) - size - 2)
  let best = null; let bestD = 1e9
  for (let ox = hx - R; ox <= hx + R; ox++) {
    for (let oz = hz - R; oz <= hz + R; oz++) {
      let okY = null; let good = true
      for (let dz = 0; dz < size && good; dz++) {
        for (let dx = 0; dx < size && good; dx++) {
          const onWall = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1
          if (!onWall) continue
          // 地面那一格:在 hy-1 ± 1 之内找实地,保证整圈同高
          let found = null
          for (const yy of [hy - 1, hy, hy - 2]) {
            const g = bot.blockAt(new Vec3(ox + dx, yy, oz + dz))
            if (g && !REPLACEABLE_RE.test(g.name) && !/water|lava/.test(g.name)) { found = yy; break }
          }
          if (found === null) { good = false; break }
          if (okY === null) okY = found
          else if (found !== okY) { good = false; break }      // 整圈必须同高,否则墙会错层
          for (let y = 1; y <= 2; y++) {
            const s = bot.blockAt(new Vec3(ox + dx, found + y, oz + dz))
            if (!s || !REPLACEABLE_RE.test(s.name)) { good = false; break }
          }
        }
      }
      if (!good || okY === null) continue
      const cx = ox + (size - 1) / 2; const cz = oz + (size - 1) / 2
      const d = Math.hypot(cx - homePos.x, cz - homePos.z)
      if (d > CFG.buildRadius - 2) continue
      if (d < bestD) { bestD = d; best = { x: ox, y: okY + 1, z: oz } }
    }
  }
  return best
}

/*
 * 施工。一次调用最多放 6 块 / 最多 20 秒 —— 动作封顶是 30 秒,留足余量,
 * 被保命反射打断也只丢掉这一趟的几块,进度在 house.json 里,下次接着放。
 */
async function actBuildHouse() {
  if (!homePos) return '失败:还没有家,不知道该在哪儿盖'
  if (house && house.done) return '成功:房子已经盖好了'
  // 太远先回家(和 build_base 一个套路)
  let d = bot.entity.position.distanceTo(homePos)
  if (d > CFG.buildRadius) {
    const beforeTp = bot.entity.position.clone()
    say('/home base')
    await new Promise((r) => setTimeout(r, 3500))
    adoptHomeIfMoved(beforeTp, 'build_house')
    d = bot.entity.position.distanceTo(homePos)
    if (d > CFG.buildRadius) return `失败:想回家盖房子,但传送后仍离家 ${Math.round(d)} 格`
  }
  // ① 还没设计过 → 让模型定(材料/门朝向/多大),代码只给它【它真的有的】材料当选项
  if (!house) {
    const stock = bot.inventory.items()
      .filter((i) => /^(dirt|cobblestone|.*_planks|.*_log|stone|andesite|granite|diorite|sand)$/.test(i.name) && i.count >= 20)
      .map((i) => `${i.name} ${i.count}块`)
    if (!stock.length) return '失败:身上没有够盖墙的材料(要一种攒到 20 块以上)'
    let design = null
    try {
      design = await designHouse({
        我有的材料: stock,
        我的家在: `(${Math.round(homePos.x)},${Math.round(homePos.z)})`,
        现在: bot.time && bot.time.isDay ? '白天' : '晚上',
      }, CFG.brain, roles.persona(ROLE.key).text)   // ⚠️ persona() 返回对象,要取 .text(其它调用点都是这么写的)
    } catch (e) { log('房子设计调用出错:', short(e.message)) }
    const fb = { material: stock[0].split(' ')[0], door: '南', size: 4 }
    const dz = design || fb
    // 🔴 如实标注哪些是它自己定的、哪些是我兜的 —— 别把兜底说成"它的主意"
    log(`🏠 设计:材料=${dz.material} 门朝${dz.door} 边长${dz.size}`
      + `(${design ? '✅ 这是它自己定的' : '⚠️ 模型没给出合格答案,用了默认值'};可选材料 ${stock.join('、')})`)
    const origin = pickHousePlot(dz.size)
    if (!origin) return `失败:家附近找不到一块 ${dz.size}×${dz.size} 的平地(要整圈同高、上面两层是空的)`
    house = { origin, size: dz.size, height: 2, door: dz.door, material: dz.material, done: false, byModel: !!design }
    saveHouse()
    log(`🏠 地基定在 (${origin.x},${origin.y},${origin.z}),一共要放 ${houseBlocks(house).length} 块`)
  }
  const mat = house.material
  const have = countItem(new RegExp('^' + mat + '$'))
  const plan = houseBlocks(house)
  const todo = []
  for (const p of plan) {
    const b = bot.blockAt(p)
    if (!b) { todo.push(p); continue }
    if (b.name !== mat && REPLACEABLE_RE.test(b.name)) todo.push(p)
  }
  if (!todo.length) {
    house.done = true
    saveHouse()
    log(`🎉 房子墙砌好了!地基 (${house.origin.x},${house.origin.y},${house.origin.z}),`
      + `${house.size}×${house.size} 墙高 ${house.height},门朝${house.door},材料 ${mat}`)
    return `成功:房子的墙全砌好了(${house.size}×${house.size},门朝${house.door})`
  }
  if (have < 1) return `失败:${mat} 用完了,还差 ${todo.length} 块才砌得完`
  /*
   * ② 走到【屋内】站好 —— 不是"靠近中心"就行。
   *
   * 🔴 实测教训(2026-09-17 04:1x,这个 bug 是我自己写出来的):
   *    原来写的是"离中心超过 2.5 格才走过去"。但 4×4 的中心到墙格只有 1.5~2.12 格,
   *    所以它完全可以【正站在一格墙上】而判定"已经到位",于是:
   *      失败:一块也没放上 —— self:那是我自己站着的地方
   *      失败:一块也没放上 —— toofar:离那一格 3.7 格,手伸不到
   *    容差必须比"中心到墙的距离"小,而且要明确站到一个【屋内】格子上。
   * 4×4 的屋内格子只有 (1,1)(1,2)(2,1)(2,2) 四个;站在任一格,
   * 到最远那面墙约 2.2 格、到墙顶那层约 2.3 格,都在手长 3.6 之内。
   */
  const inside = []
  for (let dx = 1; dx <= house.size - 2; dx++) {
    for (let dz = 1; dz <= house.size - 2; dz++) inside.push({ x: house.origin.x + dx, z: house.origin.z + dz })
  }
  const me0 = bot.entity.position.floored()
  const standingInside = inside.some((c) => c.x === me0.x && c.z === me0.z)
  if (!standingInside) {
    // 挑一个屋内格子:离当前位置最近的那个
    let pick = inside[0]; let bd = 1e9
    for (const c of inside) {
      const dd = Math.hypot(bot.entity.position.x - (c.x + 0.5), bot.entity.position.z - (c.z + 0.5))
      if (dd < bd) { bd = dd; pick = c }
    }
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNearXZ(pick.x + 0.5, pick.z + 0.5, 0)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('20秒没走到工地')), 20000)),
      ])
    } catch (e) { try { bot.pathfinder.setGoal(null) } catch (e2) { /* 忽略 */ } }
    const me1 = bot.entity.position.floored()
    if (!inside.some((c) => c.x === me1.x && c.z === me1.z)) {
      return `失败:走不进屋里站好(想站 (${pick.x},${pick.z}),现在在 (${me1.x},${me1.z}))`
        + `,还差 ${todo.length} 块`
    }
  }
  // ③ 放砖
  if (!takePlaceLock('house')) return '失败:正在挡箭,砌墙让路,下次再来'
  const t0 = Date.now()
  let put = 0; let lastWhy = ''; let refused = 0
  try {
    for (const p of todo) {
      if (put >= 6 || Date.now() - t0 > 20000) break
      const r = await placeAt(p, mat)
      if (r.ok) { put++; log(`🧱 (${p.x},${p.y},${p.z}) 放上 ${mat}(${r.why})`); continue }
      lastWhy = `${r.code}:${r.why}`
      if (r.code === 'refused') refused++
      if (r.code === 'noitem') break
      // toofar 说明站位不对 —— 这一趟先跳过它,下一趟走位变了可能就够得着
    }
  } finally { freePlaceLock('house') }
  const left = todo.length - put
  if (put === 0) {
    /*
     * 🔴 一块也没放上就冷 60 秒 —— 否则硬规则每 3 秒重来一次,
     *    实测 5 分钟里触发了 72 次,把别的活全挤掉了(虽然血/食门槛拦着,不会饿死,
     *    但等于空转)。和"连败冷却"一个道理:撞墙就退一步,别贴着墙磨。
     */
    buildHousePausedUntil = Date.now() + 60000
    return `失败:一块也没放上(还差 ${left} 块)—— ${lastWhy || '没找到能放的格子'};先歇 60 秒再试`
  }
  return `成功:又砌了 ${put} 块${mat},还差 ${left} 块`
    + (refused ? `(其中 ${refused} 次服务器没让它成立)` : '')
}

/**
 * 做东西。链条:原木 → planks → crafting_table → 放下工作台 → chest。
 * 判定同样只认【背包里真的多出来了几个】,不认"合成动作有没有跑完"。
 */
async function actCraft(rawItem) {
  // 背包满了的话,合成会"跑完了但背包里没多出来" —— 那两条报错的真因
  await tidyInventory()
  const mcData = require('minecraft-data')(bot.version)
  let itemName = rawItem
  if (rawItem === 'planks') {
    // "planks" 要按它手上的木头种类解析(橡木原木做橡木木板)
    const lg = bot.inventory.items().find((i) => /_log$/.test(i.name))
    if (!lg) return '失败:身上没有原木,做不了木板'
    itemName = lg.name.replace(/_log$/, '_planks')
  }
  const item = mcData.itemsByName[itemName]
  if (!item) return `失败:不认识 ${itemName}`
  const exact = new RegExp('^' + itemName + '$')
  const before = countItem(exact)

  let table = null
  let recipes = bot.recipesFor(item.id, null, 1, null)      // 先看背包 2x2 能不能做
  if (!recipes.length) {
    // 需要 3x3 工作台:找一个,没有就从背包放一个下来
    table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 })
    if (!table) table = await placeFromInventory('crafting_table')
    if (!table) {
      /*
       * ⚠️ 这两种情况必须分开说,不能一句"背包里也没有"打发。
       * 实测:它刚做出工作台、背包里明明有,却因为放不下来而收到"背包里也没有",
       * 于是又白做了第二个工作台 —— 又一次"把没核实的原因当事实"喂给它。
       */
      const hasTable = countItem(/^crafting_table$/) > 0
      /*
       * ⚠️ 原来这里按 `!CFG.allowPlace` 分支,可 ALLOW_PLACE 默认就是 '0' → 这个条件【永远成立】,
       * 于是它明明站在自己家里、围栏放行,失败文案照样写成"我不被允许自己放方块,需要有人给我放一个"。
       * 这句假话既让模型一直干等人来帮忙,也让我据此去麻烦主人给它放工作台。
       * 现在只讲 placeFromInventory 记下的【真实原因】。
       */
      if (!hasTable) return `失败:做 ${itemName} 需要工作台,附近没有、背包里也没有(先 craft crafting_table)`
      return `失败:身上有工作台但没能放下来 —— ${lastPlaceFail || '原因不明'}`
    }
    try {
      await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
    } catch (e) { /* 走不过去也先试试,可能本来就够得着 */ }
    recipes = bot.recipesFor(item.id, null, 1, table)
  }
  if (!recipes.length) return `失败:材料不够,做不出 ${itemName}`
  /*
   * 🔴 合成前【必须先站定】。
   *
   * 实测(2026-09-16 中午,一个 300 秒窗口):硬规则推着它合成了 67 次,
   * 其中 36 次日志判定"成功:做出了 4 个 X_planks"(当时 countItem 确实涨了),
   * 按账面该产出 144 个木板 —— 可随后逐槽位把 36 格背包读全,**木板一个都没有**,
   * 原木却还有 39 块。代码里没有任何丢弃物品的逻辑,keepInventory=true,
   * 存箱计数全程 33/64 没动、store_items 一次没跑,所以不是死亡掉落也不是存箱。
   * 同期服务器日志在报 `XiaoMai moved wrongly!`。
   * ⚠️ 我【没有】证实产物掉在了地上 —— 查附近掉落物时连负对照都是空的,
   *    那次测试无结论,所以这段是按"最可能且无害"处理,不是已证实的结论。
   * 能确定的是:它当时在【一边跑一边每 4 秒合成一次】,而合成要开背包窗口。
   * 站定再做在任何一种机制下都只会更好,代价只有几百毫秒。
   */
  try {
    bot.pathfinder.setGoal(null)
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
    await new Promise((r) => setTimeout(r, 400))
  } catch (e) { /* 停不下来也照做,别因为停不住就放弃合成 */ }
  const beforeLogs = woodCount()
  try {
    await bot.craft(recipes[0], 1, table || undefined)
  } catch (e) {
    /*
     * 🔴 把【离工作台多远】写进失败原因。
     * 实测 15 分钟里 `做 wooden_sword 时出错(Event windowOpen did not fire within timeout)`
     * 出现 5 次、成功只有 1 次。库的这句原话说不清是"太远够不着"、"工作台没了"
     * 还是"服务端没回包" —— 而这三种的处理方式完全不同。
     * 玩家的触及距离约 4.5 格,所以距离本身就是判据。
     * (今天已经因为"把没核实的原因当事实"栽过好几次,宁可多打一个数。)
     */
    let dTxt = '不用工作台(背包 2x2)'
    if (table) {
      try {
        const dd = bot.entity.position.distanceTo(table.position)
        const still = bot.blockAt(table.position)
        dTxt = `离工作台 ${dd.toFixed(1)} 格,那格现在是 ${still ? still.name : '看不清'}`
      } catch (e2) { dTxt = '算不出离工作台多远' }
    }
    return `失败:做 ${itemName} 时出错(${short(e.message)});${dTxt}`
  }
  /*
   * 🔴 合成后【等背包结算再数】。
   * 原来是 craft 一返回就立刻 countItem,实测同一窗口里有 11 次
   * 「合成跑完了,但背包里没多出 X」—— 而同样的动作另外 36 次是成功的。
   * 这种时好时坏正是"数得太早"的典型表现(服务端的背包更新包还没到)。
   * 最多等 3 轮 ×400ms,数到了就走,免得白等。
   */
  let gained = 0
  for (let k = 0; k < 3; k++) {
    await new Promise((r) => setTimeout(r, 400))
    gained = countItem(exact) - before
    if (gained > 0) break
  }
  const afterLogs = woodCount()
  if (gained <= 0) {
    return `失败:合成跑完了,但背包里没多出 ${itemName}(等了1.2秒也没出现;原木 ${beforeLogs}→${afterLogs})`
  }
  // 把账目一并记下来:下次材料再无声消失,日志里就有前后对照可查
  return `成功:做出了 ${gained} 个 ${itemName}(原木 ${beforeLogs}→${afterLogs},${itemName} ${before}→${before + gained})`
}

/** 把身上的木头存进箱子 —— 这是"保住成果":死了背包会掉,存进箱子才是真的到手。 */
/*
 * 🔴 「能存进箱子的东西」—— 菜单门槛和执行器【共用这一个函数】。
 *
 * 今晚已经四次栽在"菜单门槛和执行器用了不同判据"上:
 *   ① collectblock 的背包满(菜单说能砍,执行器必然抛错)
 *   ② store_items 的"有没有箱子"(门槛只看箱子,执行器只认自己的箱子)
 *   ③ store_items 的"有没有东西可存"(门槛完全不看)
 *   ④ 上一次我把门槛改成 `有木料 || 空格≤2`,但执行器在"空格≤2 且既没木料
 *      也没可清家当"时仍然失败 —— 实测 18 次选中里 14 次失败(成功率 7%)。
 * **所以这一次不是"再对齐一次判据",而是把判据抽成唯一的一个函数**,
 * 让两边在结构上不可能再漂。这是今晚最该记住的一条模式。
 */
const STORE_NEVER = /_helmet$|_chestplate$|_leggings$|_boots$|_sword$|_axe$|_pickaxe$|_shovel$|_hoe$|shield|bow$|arrow$|^crafting_table$|^chest$|^torch$/
const STORE_KEEP_SOME = { dirt: 32, sand: 16, stick: 16, cobblestone: 32 }
/**
 * 现在到底有多少东西是【真能存进箱子】的。
 * @returns {{wood:number, extra:number, total:number, items:Array}}
 *   wood  = 木料(原木/木板),任何时候都存
 *   extra = 背包快满(空格≤2)时才清的"家当";不满时一律算 0 —— 和执行器完全一致
 */
function storableNow() {
  const out = { wood: 0, extra: 0, total: 0, items: [] }
  try {
    if (!bot || !bot.inventory) return out
    const tight = bot.inventory.emptySlotCount() <= 2
    for (const it of bot.inventory.items()) {
      if (/_log$|_planks$/.test(it.name)) { out.wood += it.count; continue }
      if (!tight) continue
      if (STORE_NEVER.test(it.name)) continue
      if (bot.registry && bot.registry.foodsByName && bot.registry.foodsByName[it.name]) continue
      // ⚠️ 1.20.5 之后物品数据从 NBT 改成 components,两个字段都要看
      if (it.nbt || (it.components && it.components.length)) continue
      const give = it.count - (STORE_KEEP_SOME[it.name] || 0)
      if (give <= 0) continue
      out.extra += give
      out.items.push(it)
    }
  } catch (e) { log('算可存物品出错:', e.message) }
  out.total = out.wood + out.extra
  return out
}

async function actStoreItems() {
  const mcData = require('minecraft-data')(bot.version)
  /*
   * 只认【自己的箱子】。绝不再用"最近的那个" —— 那正是它把 107 块木头
   * 倒进别人储物箱的原因。宁可存不了、开口求人,也不动别人的东西。
   */
  let chest = null
  if (myChest) {
    const b = bot.blockAt(new Vec3(myChest.x, myChest.y, myChest.z))
    if (b && /^(chest|trapped_chest)$/.test(b.name)) chest = b
    else myChest = null      // 自己的箱子不见了(被拆或记错),重新来过
  }
  if (!chest) {
    const placed = await placeFromInventory('chest')
    if (placed) { chest = placed; saveMyChest(placed.position) }
  }
  if (!chest) {
    // 同上:不再拿"不被允许放方块"这句假话打发,只讲真实原因
    const hasChest = countItem(/^chest$/) > 0
    if (!hasChest) return '失败:我还没有自己的箱子,背包里也没有(先 craft chest,再回家放下来)'
    return `失败:身上有箱子但没能放下来 —— ${lastPlaceFail || '原因不明'}`
  }
  try {
    await bot.pathfinder.goto(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2))
  } catch (e) { return `失败:走不到箱子那儿(${short(e.message)})` }
  let win
  try { win = await bot.openChest(chest) } catch (e) { return `失败:打不开箱子(${short(e.message)})` }
  /*
   * 🔬 诊断「destination full 而箱子明明是空的」。
   *
   * 实测 2026-09-17 09:0x:身上 140 块木头、RCON 读箱子只用了 **2/27 个槽位**,
   * 却连着报 `Error: destination full`。
   * 查 mineflayer 源码 lib/plugins/inventory.js:327-330 —— 这个错只在
   * `window.firstEmptySlotRange(destStart, destEnd)` 返回 null 时抛,
   * 也就是**目标范围里一个空槽都没有**。而箱子有 25 个空槽,两件事对不上。
   * 唯一合理的解释是:**它打开的那个窗口不是我读的那个箱子**
   * (后面紧跟着的 `走不到箱子那儿(No path to the goal!)` 也指向同一个方向)。
   * 所以先把窗口的真实形状打出来 —— 这是个未解问题,留给下次带证据查。
   */
  try {
    const invStart = win.inventoryStart
    let free = 0
    for (let i = 0; i < invStart; i++) if (!win.slots[i]) free++
    log(`🔬 开箱子:窗口 id=${win.id} type=${win.type} 容器槽 0~${invStart - 1}(共 ${invStart})、其中空 ${free} 个;`
      + `箱子方块在 (${chest.position.x},${chest.position.y},${chest.position.z})、我在 `
      + `(${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)})、`
      + `距离 ${bot.entity.position.distanceTo(chest.position).toFixed(1)} 格`)
  } catch (e) { log('看箱子窗口形状出错:', e.message) }
  let n = 0
  let extra = 0
  const extraNames = []
  try {
    for (const it of bot.inventory.items().filter((i) => /_log$|_planks$/.test(i.name))) {
      await win.deposit(it.type, null, it.count)
      n += it.count
    }
    /*
     * 🔴 背包快满了的话,把【身上用不着的家当】也一起存进去 —— 这是 2026-09-17 05:0x 才补的。
     *
     * 实测现场:`🧹 背包 36 格全满、却没有可以扔的杂物` 一夜 52 次。
     * 36 格全满,但一样"杂物"都没有 —— 塞满它的是它自己攒的家当:
     *   橡树苗×43、云杉苗×18、樱花苗×12、白桦苗×4(光树苗就 4 格)、竹子×37、线×21、
     *   苔藓×10、沙×9、钻石×15、铁锭×2、蜂蜜块、旗帜、罂粟、指南针、活板门、床……
     * 后果和背包满是同一个:collectblock 在挖之前就抛 `no defined chest locations`,
     * 每一次砍树都必然失败(gather_wood 从 63% 掉回 41%)。
     *
     * 判据用【空格 ≤2】而不是"满了":满了才存就已经耽误了一轮砍树。
     * ⚠️ 只存【存进箱子不影响它干活】的东西。不碰:食物、工具武器、**所有盔甲**
     *    (没装 armor-manager,我分不清哪件更好,宁可让它穿着)、
     *    工作台/箱子、以及一定量的建材和木棍(留着随手用)。
     * ⚠️ 钻石和铁锭【存进箱子更安全】—— 死了掉一地比放在家里箱子里强。
     */
    // 🔴 清单来自 storableNow() —— 和菜单门槛【同一个函数】,不可能再漂(见那段注释)
    for (const it of storableNow().items) {
      const give = it.count - (STORE_KEEP_SOME[it.name] || 0)
      if (give <= 0) continue
      await win.deposit(it.type, null, give)
      extra += give
      extraNames.push(`${it.name}×${give}`)
      if (bot.inventory.emptySlotCount() >= 8) break          // 腾出 8 格就够了,别把家当全搬空
    }
  } catch (e) {
    /*
     * 🔴 这里原来是【完全静默的 catch】—— 而它正在骗人。
     *
     * 实测 2026-09-17 09:0x:机器人身上有 **140 块木头**、箱子只用了 **2/27 个槽位**,
     * 却连着报「没往箱子里存进任何东西」。也就是说 `win.deposit()` 在抛错,
     * 而这个空 catch 把原因整个吞掉了,于是我只能猜"多半是箱子满了"——
     * 而箱子明明是空的。
     * 记忆里那条教训原话就是「别再写静默 catch」(整晚失效的泳游自救 bug 就是这么藏的),
     * 我还是在这儿又踩了一次。先把原话打出来,再谈修。
     */
    log(`📦 往箱子里存东西时报错(已存进 ${n} 木料 + ${extra} 家当):${e && e.name ? e.name + ': ' : ''}${short(e && e.message ? e.message : String(e))}`)
    /*
     * 🔴 箱子真的满了 → 忘掉它,让"没箱子就回家造一个"那条硬规则接手。
     *
     * 实测 2026-09-17 09:0x:逐槽位点名 + 负对照确认这个箱子是 **27/27 满的**,
     * 而它身上压着 131~148 块木头存不进去,于是 store_items 连着失败、木头越积越多。
     * mineflayer 的 `destination full` 就是这个意思(lib/plugins/inventory.js:327-330:
     * `firstEmptySlotRange` 返回 null 才抛)。
     *
     * ⚠️ 我一度以为"箱子只用了 2/27,所以这个错在骗人" —— 那是因为我把 RCON 的输出
     *    截断在 300 字符再去数槽位,**只数到了前 2 个**。又一次栽在截断上
     *    (和 `cut -c` 切坏中文是同一类:工具在骗人,而错的方向看起来很合理)。
     *    查容器一律逐槽位点名 + 负对照。
     *
     * 为什么原来不会自己造第二个:硬规则的条件是 `!myChest`,
     * 而 myChest 一直指着那个满的箱子,所以永远不触发。
     * 忘掉它之后,规则就会让它回家做一个新的、摆下、并把新箱子记成自己的
     * —— 和「箱子离家太远就忘掉」是同一个套路。
     */
    if (/destination full/i.test(String(e && e.message))) {
      log(`📦 这个箱子(${myChest ? `${myChest.x},${myChest.y},${myChest.z}` : '?'})塞满了 —— 忘掉它,回头自己再造一个`)
      myChest = null
      try { require('fs').writeFileSync(MYCHEST_FILE, 'null') } catch (e2) { log('清箱子存档失败:', e2.message) }
    }
  }
  if (extra > 0) {
    log(`📦 背包快满了,顺手把用不着的家当也存了:${extraNames.join('、')}(现在空出 ${bot.inventory.emptySlotCount()} 格)`)
  }
  try { win.close() } catch (e) { /* 忽略 */ }
  if (n <= 0 && extra <= 0) {
    const s = storableNow()
    return `失败:没往箱子里存进任何东西(木料 ${s.wood}、可清的家当 ${s.extra}、背包空 ${bot.inventory.emptySlotCount()} 格)`
      + ' —— 多半是箱子满了'
  }
  storedTotal += n
  saveProgress()   // 立刻落盘 —— 上一版只在内存里,我每次部署重启都把它的进度清零了
  return `成功:往箱子里存了 ${n} 个木料,累计存了 ${storedTotal} 个`
    + (extra > 0 ? `;另外腾出格子存了 ${extra} 样别的(现在空 ${bot.inventory.emptySlotCount()} 格)` : '')
}

async function executeAction(a) {
  /*
   * 🔴 第二道闸:不在这个角色白名单里的动作,一律当场拒绝。
   * 为什么要两道:菜单那道是"不提供",这道是"提供了也不许做" ——
   * 模型会自己发明动作(今天见过它输出菜单里没有的东西),
   * 而且硬规则(forced)是绕过菜单直接塞动作的,只靠菜单挡不住。
   */
  if (a && a.action && !ROLE.actions.includes(a.action)) {
    return `失败:我(${ROLE.cnName})不做「${a.action}」这件事,这不是我的活`
  }
  switch (a.action) {
    case 'follow_player':
      return startFollow(a.player, true) ? `成功:开始跟着 ${a.player}` : `失败:看不见玩家 ${a.player}`
    case 'set_home':
      stopFollow(true)
      return await actSetHome()
    case 'gather_wood':
      stopFollow(true)
      return await actGatherWood()
    case 'craft':
      stopFollow(true)
      return await actCraft(a.item)
    case 'store_items':
      stopFollow(true)
      return await actStoreItems()
    case 'build_house':
      return await actBuildHouse()
    case 'build_base':
      stopFollow(true)
      return await actBuildBase()
    case 'go_home':
      stopFollow(true)
      return await actGoHome()
    case 'explore': {
      stopFollow(true)
      /*
       * 硬门:没家的时候【天黑不出远门】。
       * 实测它夜里出去探,一路被骷髅/溺尸打死(13:23:30 死、3 秒后复活又死),
       * 每死一次就被送回出生点,离"安家要 120 格"的进度直接归零 —— 永远走不到能安家的距离。
       * 这条不交给模型判断:小模型不会为了"明天再走"放弃眼前的探索。
       */
      const night = bot.time && bot.time.timeOfDay >= 12500
      if (!homePos && night) return '失败:天黑了,还没有家的时候不出远门(会被怪打死送回出生点,等于白跑),等天亮'
      return await actExplore(a.direction)
    }
    case 'wander':
      stopFollow(true)
      return actWander()
    case 'fight':
      return actFight()
    case 'flee':
      stopFollow(true)
      return actFlee()
    case 'eat':
      return await actEat()
    case 'hunt':
      stopFollow(true)
      return await actHunt()
    case 'goto_place':
      stopFollow(true)
      return await actGotoPlace(a.place)
    case 'say': {
      /*
       * 🔴 这个动作【已停用】(Owner 2026-09-16)。
       * 它原本让模型自己决定"我现在想说句话" —— 而规格是
       * 「不要把他们自己思考的过程说出来,除非有人在聊天框里提到他们的名字,他们才回答」。
       * 模型主动选 say 恰恰就是"没人问就自己说"。
       * 在【执行层】直接拒掉,不是靠提示词劝它别选 ——
       * 今天已反复验证:前置条件靠叮嘱不管用,得用硬门。
       * 同时也从菜单(avail)和提示词里摘掉了,这里是第三道保险。
       * 回话改走 handleChat 里被点名时的 chat() 通道,和决策完全分开。
       */
      return '失败:我不主动在公屏说话了,只有别人叫我名字时才回。做点别的吧'
    }
    case 'idle':
      stopFollow(true)
      try { bot.pathfinder.setGoal(null) } catch (e) { /* 忽略 */ }
      return '成功:原地歇着'
    default:
      return '失败:不认识的动作'
  }
}

/** 目标达成时报一次喜,别反复刷屏。 */
function checkGoal() {
  // 进度只认【真的存进箱子的数量】—— 背包里的不算数,死一次就可能没了
  if (storedTotal >= CFG.goalCount && !goalAnnounced) {
    goalAnnounced = true
    log(`🎉 目标达成:已存进箱子 ${storedTotal}/${CFG.goalCount} 块`)
    /*
     * Owner 2026-09-16:「不要把他们自己思考的过程说出来,除非有人在聊天框里
     * 提到他们的名字,他们才回答」。这句是【它自己主动喊的】,没人问它,所以只进日志。
     * 要恢复就把下面这行换回 say。
     */
    log(`🎉 (只记日志,没人问就不往公屏说)我做到啦!把 ${storedTotal} 块木头存进箱子了`)
  }
}

// ——————————— 保命反射(每秒一次,不经过大脑)———————————
let reflexTimer = null
let reflexSwim = false
let lastHealth = 20
/*
 * 上一次【真的掉血】是什么时候。
 *
 * 🔴 为什么非要这个不可:抢占保护原来的紧急判据是「血量 ≤ 10」——那是个**状态**,不是事件。
 * 而饱食度不够时血量根本不回升,于是血长期钉在 9.5,这扇"紧急门"就 24 小时敞着。
 * 实测(17:43:04~17:43:15):hunt 刚开始就被 flee 连续打断 25 次,
 * 打到了猪却没拿到肉;随后饱食度归零、被 pillager 打死。
 * **"血低"是常态,"刚挨打"才是紧急。** 判据必须换成事件。
 */
let lastHurtAt = 0
/*
 * 这一轮动作是不是已经打断过了 —— 防止同一个打断意图被执行几十遍(见 actTick 里的说明)。
 */
let interruptedFor = ''
/*
 * 上一次"强制吃"是什么时候。brainTick 是连续循环,不加锁的话同一个意图会被反复排队:
 * 实测这条规则 2 秒内触发 6 次,只换来 2 次真吃 —— 和"同一个打断被执行 25 遍"同源。
 */
let lastForcedEatAt = 0
/*
 * 上一次"强制打猎"是什么时候。hunt 是耗时动作(走过去+打死+捡肉,封顶 30 秒),
 * 不加锁就会像强制吃那样在两秒内重复排队(那次是 6 次触发只换来 2 次真吃)。
 */
let lastForcedHuntAt = 0
/*
 * 🔴 服务器广播的死亡消息 —— 判断「到底有没有真的死」的【唯一权威来源】。
 *
 * 今晚查实的最严重的一个观测误差(2026-09-16):
 *   我的日志整夜记了 67 次「我死了」,而服务器只记了 13 次 —— 虚高 5 倍。
 *   按小时对(JST):00点 2/1、01点 3/4、02点 6/8、03点【2/19】。
 * 机制:反射层血量见底会 say('/home base'),EssentialsX 传送让服务端下发重生包,
 *   mineflayer 把它当成了 death 事件。服务器 03:26~03:29 的完整记录里
 *   有 6 条 /home base、0 条死亡消息,而我的日志在同一段时间打了 10 次「我死了」。
 * 另一条独立铁证:真死亡后血量必然是整 20,而那 10 次后面跟的是 16.67 / 14.5 / 19.33。
 *
 * 危害不止于统计:death 处理器会写 places.remember('death') 和 memory.record(),
 * 实测 places.json 12 条里有 9 条是死亡点、memory.json 有 20 条 died ——
 * **假死亡正在污染它自己的地图和「过去的教训」,而这两样每轮都喂回给模型。**
 */
const DEATH_MSG_RE = /was shot by|was slain by|was killed by|was blown up by|was poked to death|was pricked to death|was squashed|was impaled|was fireballed|starved to death|drowned|burned to death|went up in flames|fell from a high place|hit the ground too hard|suffocated|froze to death|withered away|discovered the floor was lava|tried to swim in lava|walked into|experienced kinetic energy|fell out of the world|fell off a ladder|fell off some vines|fell off scaffolding|was doomed to fall/i
let lastDeathMsgAt = 0
/*
 * 上一次【被认定为真死亡】的时刻,用来给死亡记账去重。
 *
 * 实据(2026-09-16 04:23):服务器日志里 `was blown up by Creeper` 全天只有一条,时刻是 04:10:54;
 * 而机器人在 04:23:48 又收到一模一样的这句文本 —— 相隔 13 分钟的【旧消息重放】。
 * 更麻烦的是它恰好落在 04:23:14 那次真死亡之后的重生瞬间:血量和饱食度都是 20/20,
 * 于是 AND 的两条判据【同时成立】,假死亡照样被放行。
 * 再加一道最朴素的去重:两次死亡之间至少隔 30 秒。
 * 真死亡在半分钟内连发两次极罕见;而误记一次的代价是把假地点写进地图记忆和「过去的教训」,
 * 一路喂回给模型 —— 这个方向的错误更贵。
 */
let lastAcceptedDeathAt = 0
/*
 * 反射逃跑那行日志的节流时刻。
 * 实测最长连续 41 秒每秒刷一条「反射逃跑」,而它一滴血都没掉 —— 日志被这种无效告警淹没。
 */
let lastFleeLogAt = 0
/*
 * 🔴 主脑掉线时的降级状态。
 *
 * 实测事故(2026-09-16 04:41~04:50):Owner 的 5060 笔记本整机离线
 * (ping 三次全不通、HTTP=000;同一条路由上的 M1 却 0.13 秒返回 200,
 *  所以不是网络也不是路由,是那台机器本身不在了 —— 凌晨四点多,多半是睡眠/合盖)。
 * 后果:每次决策都要空等满 BRAIN_TIMEOUT_MS(60 秒)才失败,
 *   本版窗口「大脑决定 0 次 / 大脑没反应超时 7 次」,
 *   它只能靠"连续 3 次给不出动作 → 代码替它选 explore"每分钟随机挪一步,
 *   同期还一路掉进水里(氧气 6→3→2→1→0→-1)。
 * **一个单点故障,把整个 AI 玩家降成了木头人。**
 *
 * 解法:主脑连续没反应就临时改用 M1(它一直活着、qwen2.5:7b 常驻显存、实测 9 秒一次),
 * 过 2 分钟再回去试主脑 —— Owner 的笔记本醒了就会自动切回去,不需要人管。
 * ⚠️ 降级是【降级】:M1 同时还在跑规划循环,两边抢同一块显卡,决策会变慢;
 *    7b 也比 14b 更容易给出不合法的 JSON。这是"慢总比停摆好",不是常态。
 */
let brainDownUntil = 0
let brainFailStreak = 0
let brainJunkStreak = 0
let lastBrainJunkAt = 0
let usingBackupBrain = false
let lastSwimTurn = 0       // 游泳时隔一会儿换个方向,免得对着大海一直游
let swimSince = 0          // 这一次入水是什么时候(泡太久要传送自救)
// 打架节流:反射每秒跑一次,不节流的话会每秒重下一次攻击指令 + 刷一行日志
// (实测 11 秒刷了 11 行;晚上怪一多就是持续刷屏,而我刚被 15MB 日志坑过)
let lastFightId = null     // 正在打谁
let lastFightAt = 0
// 卡住自救:Owner 反馈它会卡在建筑里(尤其保护区)出不来。
// ⚠️ 这个问题因为我禁掉搭塔+挖路而变严重了 —— 它现在既不能垫方块爬出去也不能挖穿,
// 所以必须给它一个"逃生门":直接发 /spawn 聊天命令回出生点(它不会用指南针菜单,但能发命令)。
let lastStuckPos = null
let lastMovedAt = Date.now()

/*
 * ⚠️ 这是踩了大亏才加的,别删:
 * 一开始我把"保命"也交给模型决定,结果它 2 分半里死了 7 次 ——
 * 服务器日志:drowned / slain by Zombie / slain by Drowned。
 * 原因很简单:**大脑 25 秒才想一次,而一只僵尸几秒就能把它打死。**
 *
 * 所以分工是:**策略(干什么)交给模型,保命(别死)必须是反射。**
 * 这里只做最要命的三件事,做完就把控制权还给大脑。
 */
function reflexTick() {
  if (!ready || !bot || !bot.entity) return
  try {
    /*
     * 🧹 背包满了是【所有动作的硬阻塞】:砍树被 collectblock 当场抛错、
     * 合成出来的东西也没地方放。所以放在反射层每秒兜一次,不等大脑想起来选动作。
     * 函数自己带"真的 0 空格"判据 + 30 秒节流,没满的时候开销可以忽略。
     * ⚠️ 不写静默 catch —— 整晚失效的泳池自救 bug 就是被静默 catch 藏起来的。
     */
    /*
     * 🏃 刚死过就别站在原地 —— 这是 respawn-at-home 造成的死亡闭环的对策。
     * 重生时是满血 20,而平时的逃跑判据是"血量低",正好不成立,
     * 于是它满血站在僵尸面前等死。这里在刚死过的 12 秒内把判据换成"旁边有怪就跑"。
     * 放在 tidyInventory 之前:保命优先于整理背包。
     */
    if (Date.now() < justDiedUntil) {
      try {
        const dd = nearestHostile()
        if (dd && dd.dist < 8) {
          if (Date.now() - lastRespawnFleeLog > 5000) {
            lastRespawnFleeLog = Date.now()
            log(`🏃 刚死过,${dd.name} 还在 ${Math.round(dd.dist)} 格 —— 满血也先跑,别在重生点挨第二刀`)
          }
          actFlee()
        }
      } catch (e) { log('重生后逃跑出错:', e.message) }
    }
    tidyInventory().catch((e) => log('腾背包出错:', e.message))
    // 🛡️ 护甲槽空着就把背包里最好的穿上(自带 30 秒节流,没得穿时开销可忽略)
    wearBestArmor().catch((e) => log('穿盔甲出错:', e.message))
    /*
     * 🔬 放置能力探针的触发器:只在 ~/mcbot/PROBE_PLACE.on 存在时跑一次。
     * 用标记文件而不是环境变量,是为了【不用重启就能触发】——
     * 重启会打断它正在干的活,而探针本身只放 4 块泥土,没必要为它停机。
     */
    if (Date.now() - lastProbeCheckAt > 5000) {
      lastProbeCheckAt = Date.now()
      try {
        if (!probePlaceDone && require('fs').existsSync(require('path').join(__dirname, 'PROBE_PLACE.on'))) {
          probePlaceDone = true
          runPlaceProbe().catch((e) => log('放置探针出错:', e.message))
        }
      } catch (e) { log('查探针标记出错:', e.message) }
    }
    /*
     * 🕳️ 困在地下太久 → 直接传送回家(硬规则,不问大脑)。
     * 依据:实测一整轮 27 次决策【全部】在 y=41~45,坐标只在十几格内挪动 —— 它出不来。
     * 为什么必须是硬规则而不是提示词:今天已经三次验证,
     * "必须先做 A 才能做 B"这类前置条件靠叮嘱不管用(set_home、build_base 都是这么栽的)。
     * 45 秒足够它自己爬出一个浅坑;真困住了才会触发。冷却 60 秒,免得反复传送。
     */
    const yNow = bot.entity.position.y
    const tNow = Date.now()
    /*
     * 🪂 残血时【不许让寻路跳崖】。
     *
     * 今天摔死 6 次,查每一次死前 30 秒,无一例外都是在【残血逃命】:
     *   05:37 血1 / 06:00 血2 / 06:27 血0.91 / 06:54 血5.5 / 07:41 血0.28 / 08:23 血1.83
     * 所以这不是"失足坠崖"这种独立死因,而是"已经快死了"的最后一下。
     * Minecraft 的掉落伤害 = (落差 - 3) 点,而 mineflayer-pathfinder 的
     * maxDropDown 默认就是 4 —— 代码里从来没设过。4 格落差 = 1 点伤害,
     * 满血无所谓,0.9 血就是当场死。
     * 血少时压到 2 格(2~3 格完全不掉血),血回来了再放开。
     * ⚠️ 两份 Movements 都要改(我自己那份 + collectBlock 自建那份),
     *    这个教训刚在浆果丛上付过学费。
     * ⚠️ 只在数值真的要变时才动手 + 打日志,否则每秒一次会刷屏。
     */
    /*
     * 🔴 被动记下"哪里有动物" —— 【不依赖 hunt 能不能打到,也不依赖它找不找得到】。
     *
     * 我上一版把"看到就记"写进了 actHunt,**那是个没修干净的修复**:
     * actHunt 只有在 64 格内找到猎物之后才会走到那一行,
     * 而它的问题恰恰是找不到 —— 等于把自锁往前挪了一步,没解开。
     * 实测(2026-09-16 UTC 04:31~04:46,改完之后的 15 分钟):又饿死 1 次,
     * places.json 仍然是 tree 6 / death 6 / **animal 0**,
     * hunt 三次全部报「附近 64 格内没有动物,而且我还没记住任何有动物的地方」。
     *
     * 反射层每秒都在跑,而且不管当前在做什么动作都会跑 ——
     * 这才是"看见了就记下来"该待的地方。
     * ⚠️ 记【自己站的位置】而不是动物的位置:我站得到的地方一定走得回来,
     *    动物那一格未必(可能在水里、悬崖上、或别人领地里)。
     * ⚠️ 10 秒节流 + places 自带 8 格去重网格,不会把记忆刷爆。
     */
    if (tNow - lastAnimalNoteAt > 10000) {
      lastAnimalNoteAt = tNow
      try {
        const seen = bot.nearestEntity((e) => e && e.position && PREY_RE.test(String(e.name || '')) &&
          e.position.distanceTo(bot.entity.position) < 48)
        if (seen) places.remember('animal', bot.entity.position, `见到${seen.name}`)
      } catch (e) { /* 记地图失败绝不能影响反射层 */ }
    }
    try {
      const wantDrop = (bot.health !== undefined && bot.health <= 8) ? 2 : 4
      if (wantDrop !== lastDropLimit) {
        lastDropLimit = wantDrop
        if (myMoves) myMoves.maxDropDown = wantDrop
        const cmv = bot.collectBlock && bot.collectBlock.movements
        if (cmv) cmv.maxDropDown = wantDrop
        // 第三份:pvp 的。残血时最容易摔死的场景恰恰是被怪追着跑,而那时生效的正是这一份。
        const pmv = bot.pvp && bot.pvp.movements
        if (pmv) pmv.maxDropDown = wantDrop
        log(`🪂 血量 ${bot.health} → 寻路最大落差改成 ${wantDrop} 格(掉落伤害=落差-3,残血时 4 格就能要命)`)
      }
    } catch (e) { /* 改不了就照旧,不能因此让反射层挂掉 */ }
    if (yNow < 55) {
      if (!undergroundSince) undergroundSince = tNow
      if (homePos && tNow - undergroundSince > 45000 && tNow - lastUndergroundEscapeAt > 60000) {
        lastUndergroundEscapeAt = tNow
        undergroundSince = 0
        log(`🕳️ 在地下(y=${Math.round(yNow)})待了 45 秒还没出来 —— 传送回家,别在洞里空转`)
        say('/home base')
        lastOutcome = '失败:困在地下出不来(我不会挖路也不会垫方块爬高),只好传送回家'
        brainPausedUntil = tNow + 8000
      }
    } else {
      undergroundSince = 0
    }
    /*
     * ⚠️ 这里的【顺序】是踩过坑才定下来的,别改回去:
     * 原来是"先处理游泳,然后 return",结果**在水里的时候整段怪物处理被跳过**。
     * 实测:放一只蜘蛛测试时它正好在水里扑腾,反射一次还击/逃跑都没触发,直接被弄死;
     * 而死亡日志写的是"旁边有 spider" —— 说明怪**探测到了**,只是被那个 return 跳过了处理。
     * 所以现在:**先判断怪,再处理呛水**,两件事都不会被漏掉。
     */
    const hp = bot.health
    const hurt = hp < lastHealth - 0.5
    lastHealth = hp
    if (hurt) lastHurtAt = Date.now()   // 抢占保护要用它来判断"是不是真的紧急"
    const d = nearestHostile()
    const oxy = bot.oxygenLevel
    const inWater = oxy !== undefined && oxy < 18

    // 1) 怪贴脸:血少就跑,血够就打 —— 立刻反应,不等大脑(在水里也照样要反应)
    /*
     * ⚔️ 远程怪要【更早】察觉。
     * Owner:「XiaoMai 似乎不会应对骷髅弓箭手」—— 查下来不是"不会应对",是**根本没察觉**:
     * 原来只有 6 格内才算威胁,而骷髅在 16 格外就开始放箭,
     * 它就站那儿莫名其妙掉血;等骷髅走进 6 格,血已经掉掉一半。
     * 实据:16:05:46「我死了:在 (-28,y=63,179),旁边有 skeleton」。
     */
    /*
     * 🔴 血量见底就回家 —— 【不管此刻看不看得见怪】。
     *
     * 实测事故(2026-09-15 16:49):它在 (133~141, 631~637) 之间来回逃,
     * **连续 8 次采样血量都是 3.5**,身边轮流是 skeleton 和 creeper,却始终没有传送回家。
     * 原因:保命传送原来【嵌在"怪在探测半径内"那个分支里面】——
     * 远程怪在 16 格外放箭、苦力怕在 6 格外,分支条件不成立,整段保命逻辑就被跳过了,
     * 于是它在 3.5 血上被钉死,只会原地打转逃跑。
     * **血量低本身就是紧急情况,不该以"能否看见怪"为前提。** 所以提到最外层。
     */
    /*
     * 🔴 保命传送要看【是不是真有危险】,不能只看血量数字。
     *
     * Owner 的观察:「他老是说附近有树 但是砍不了 这是错误的 可以砍啊」—— 他是对的。
     * 实测那一幕(2026-09-16 02:40:29):
     *   大脑决定 gather_wood(附近有树)
     *   🚨 血量只剩 5.33 —— 不管怪在哪,先传送回家保命      ← 就是这一行
     *   🏃 反射逃跑(skeleton_horse 在 7 格外)
     *   执行结果: 失败:砍不动(The goal was changed...)
     * 同期「打断 gather_wood」0 次 —— 不是打断机制干的,是这里的传送把寻路目标冲掉了。
     * 树就在旁边,它也想砍,是我的代码每隔 30 秒把它拽回家一次。
     *
     * 而"血量低"在这个服务器上是【常态】(饱食度不够就不回血,能长期卡在 3~6 血),
     * 拿常态当紧急,结果就是它永远在传送、永远干不完一件事。
     * 现在要求:血低【并且】真的有危险 —— 6 秒内掉过血,或者怪已经进 8 格。
     * 远处一只不攻击人的骷髅马,不再算紧急。
     */
    const inRealDanger = (Date.now() - lastHurtAt < 6000) || !!(d && d.dist < 8)
    if (hp <= 6 && inRealDanger && homePos && Date.now() - lastHomeEscapeAt > 30000) {
      lastHomeEscapeAt = Date.now()
      log(`🚨 血量只剩 ${hp}${d ? `,${d.name} 在 ${Math.round(d.dist)} 格` : ''} —— 真有危险,传送回家保命`)
      say('/home base')
      lastOutcome = `失败:血量只剩${hp},太危险了,传送回家 —— 空手打不过怪,得先做把剑`
      brainPausedUntil = Date.now() + 10000
    }

    /*
     * 🔴 用【精确名字】判断远程怪,不能用子串。
     * 原来是 /skeleton|.../ 子串匹配,结果 `skeleton_horse`(骷髅马)也被当成弓箭手 ——
     * 实测「冲上去贴脸打」32 次里有 11 次打的是骷髅马。
     * 骷髅马【根本不会攻击玩家】,它只是个坐骑:冲过去纯属浪费血量和时间,
     * 而且会把正在砍树/打猎的寻路目标冲掉。
     * 同理 husk/drowned/zombie_villager 都是近战怪,别被 zombie 子串带跑。
     */
    const RANGED_NAMES = /^(skeleton|stray|bogged|pillager|witch|blaze|ghast|wither_skeleton|piglin|illusioner)$/i
    const ranged = !!(d && RANGED_NAMES.test(String(d.name || '')))
    /*
     * 🔴 会自爆的怪【既不能近战也不能站着】—— 必须单独成一类。
     *
     * 这是我上一版自己引入的坑,实测第一分钟就现形:
     *   ⚔️ 血量 1.4333 但 creeper 是近战怪(4 格)—— 转身打它
     * 苦力怕不是普通近战怪:它靠【贴近你然后自爆】,1.43 血凑过去等于自杀。
     * (苦力怕自爆在近距离能打掉 20+ 血,穿甲都不一定活。)
     * 正确打法只有一个:拉开距离 —— 它必须贴到 3 格内才能引爆。
     * 所以自爆怪不走"低血转身近战"那一支,让它落到下面的逃跑分支去。
     * ⚠️ 别把苦力怕写进 RANGED_NAMES:那会让它在血>10 时"冲上去贴脸打",更糟。
     */
    const BOOM_NAMES = /^(creeper)$/i
    const boomer = !!(d && BOOM_NAMES.test(String(d.name || '')))
    if (d && (d.dist < 6 || (ranged && d.dist < 16))) {
      if (hp <= 6 && homePos && Date.now() - lastHomeEscapeAt > 30000) {
        /*
         * 🔴 血量见底:别再跑了,直接传送回家。
         * 判据来自实测:对远程怪(pillager/skeleton/witch)"往反方向跑"拉不开距离,
         * 距离一直卡在 2~5 格,它一路从 20 血被射到 1 血。跑是没用的,得离开这张地图。
         * 传送是它已经有的能力(EssentialsX /home,权限早已单独授过并验证过回执)。
         */
        lastHomeEscapeAt = Date.now()
        log(`🚨 血量只剩 ${hp},${d.name} 追着打且跑不掉 —— 传送回家保命`)
        say('/home base')
        actFlee()   // 传送若有读条被打断,至少还在跑
        lastOutcome = `失败:血量只剩${hp}被${d.name}打得快死了,只好传送回家 —— 空手打不过远程怪,得先有武器护甲`
        brainPausedUntil = Date.now() + 10000
      } else if (ranged && hp > 10 && d.dist <= RANGED_RUSH_MAX) {
        /*
         * 🔴 对远程怪:【只有已经贴到 5 格内才冲】。
         *
         * 原来这里是"不管多远都冲上去贴脸",理由是实测"往反方向跑"拉不开距离。
         * 那条观察本身没错,但它来自一次【5 格内】的掠夺者遭遇,被我错误地
         * 推广到了所有距离。全天数据把这个错误量化了出来:
         *   ≥10 格就冲 ≈ 1174 次,≤5 格才冲只有 ≈ 180 次;
         *   死前 7 次连续冲锋、血量全程 14.5 不动(= 一步没走到)、随后被射死。
         * 5 格是一步能跨到的距离,骷髅近战很弱,贴上去确实克它;
         * 10 格以上冲过去要吃 2~3 箭,而它【没剑没甲没盾】,冲到也打不动。
         */
        const rid = d.entity && d.entity.id
        const rnow = Date.now()
        if (rid !== lastFightId) { actFight(); lastFightId = rid }
        if (rnow - lastFightAt > 4000) {
          log(`⚔️ ${d.name} 已经贴到 ${Math.round(d.dist)} 格(≤${RANGED_RUSH_MAX})—— 冲上去打它,近战它很弱(血量 ${hp})`)
          lastFightAt = rnow
        }
        brainPausedUntil = rnow + 5000
      } else if (ranged) {
        /*
         * 🔴 弓箭手在【5 格以外】:先挡箭,再拉开距离。绝不中距离对冲。
         * 箭走直线,中间放一格实心方块就打不着(见 coverFromArrows 的完整实测依据)。
         * 挡箭是异步的且会失败,所以【不等它、也不依赖它】——
         * 同一拍就照常跑,挡上了算白捡,挡不上也不会站在原地挨射。
         * 骷髅射程约 16 格,跑出去就不挨射了;这一点和 5 格内拉不开距离并不矛盾。
         */
        const rnow = Date.now()
        if (d.entity) coverFromArrows({ position: d.entity.position, name: d.name }).catch(() => { })
        actFlee()
        if (rnow - lastRangedRunAt > 4000) {
          lastRangedRunAt = rnow
          log(`🏹 ${d.name} 在 ${Math.round(d.dist)} 格外放冷箭(>${RANGED_RUSH_MAX} 格)—— 边挡箭边拉开距离,不中距离对冲(血量 ${hp})`)
        }
        lastOutcome = `失败:${d.name} 在 ${Math.round(d.dist)} 格外放冷箭,正在挡箭并拉开距离 —— 空手没甲够不着弓箭手,得先做出剑和盾`
        brainPausedUntil = rnow + 4000
      } else if (!ranged && !boomer && hp <= 10 && d.dist < 5) {
        /*
         * 🔴 低血遇到【近战怪】要打,不要逃 —— Owner:
         * 「血量低的情况下 只要没有弓箭手 近战还是有机会打赢的」
         *
         * 实测数据支持这个判断:反射逃跑的对手里有 zombie 5 次、spider 3 次 ——
         * 这两个都是纯近战怪。僵尸移动速度和玩家接近,"往反方向跑"拉不开距离,
         * 等于边跑边被砍,而且跑的时候没法还手、还会把正在做的事(砍树/打猎)冲掉。
         * 贴脸打反而有赢的机会:僵尸 20 血、蜘蛛 16 血,一把剑几下就能解决。
         *
         * ⚠️ 只在【已经贴到 5 格内】时打 —— 更远就没必要主动凑过去。
         * ⚠️ 弓箭手(ranged)不走这一支:对它们低血硬拼是送命,
         *    上面那条"血量见底就传送回家"和下面的逃跑分支照旧接管。
         * ⚠️ 自爆怪(boomer=苦力怕)也不走这一支 —— 见 BOOM_NAMES 处的说明,
         *    实测我上一版漏了这个例外,它在 1.43 血时被指挥去打苦力怕。
         * ⚠️ 血量真见底(≤6)且真有危险时,最外层的传送分支【先于】这里触发,
         *    所以这一支实际覆盖的是 6 < hp ≤ 10 这一段,以及 hp≤6 但没真危险的情况。
         */
        const mid = d.entity && d.entity.id
        const mnow = Date.now()
        if (mid !== lastFightId) { actFight(); lastFightId = mid }
        if (mnow - lastFightAt > 4000) {
          log(`⚔️ 血量 ${hp} 但 ${d.name} 是近战怪(${Math.round(d.dist)} 格)—— 转身打它,跑不掉还挨砍`)
          lastFightAt = mnow
        }
        lastOutcome = `失败:血量只剩${hp},正在和${d.name}近战`
        brainPausedUntil = mnow + 5000
      } else if (hp <= 10) {
        /*
         * 🔴 逃照样逃,但【不再顺手把大脑按住】—— 这是实测逼出来的。
         *
         * 现象(2026-09-16 19:32~19:38 窗口):
         *   反射逃跑 76 次 : 大脑决策 7 次 = 10.9 : 1;
         *   76 次里 65 次(86%)怪在 12~16 格外,其中【39 次是同一只 14 格外的掠夺者】;
         *   同期血量只出现过 4 个值,8.51 连刷 35 次、5 连刷 35 次 —— 它一滴血都没掉;
         *   最长连续 41 秒全是反射,相邻决策间隔被拉到 60~81 秒。
         * 原因就在这一行:每秒都把 brainPausedUntil 往后推 8 秒,
         * 于是一只站在远处、根本打不到它的怪,就能把大脑无限期按死。
         * 而这期间它正饿着(食 0~6),该做的事是去打猎,却连"想"的机会都没有 —— 随后饿死。
         *
         * 新规矩:只有【真的在挨打】(6 秒内掉过血)或【怪已经贴到 8 格内】才暂停大脑;
         * 其余情况照样逃,但让大脑继续转。
         * ⚠️ 绝不动 actFlee() 本身 —— 本文件有前科:屏蔽保命动作那次 260 秒死了 8 次。
         *    这里只改"要不要按住大脑",不改"逃不逃"。
         */
        const reallyInDanger = (Date.now() - lastHurtAt < 6000) || d.dist < 8
        if (Date.now() - lastFleeLogAt > 4000) {
          lastFleeLogAt = Date.now()
          log(`🏃 血量 ${hp},${d.name} 在 ${Math.round(d.dist)} 格外 —— 反射逃跑${reallyInDanger ? '' : '(远处没打到我,大脑继续想)'}`)
        }
        actFlee()
        lastOutcome = `失败:血量只剩${hp},被${d.name}追着跑`
        if (reallyInDanger) brainPausedUntil = Date.now() + 8000
      } else if (d.dist < 4) {
        // 只在【换了目标】或【隔了 5 秒】时才重新下攻击指令并记一行日志。
        // pvp 插件自己会持续追打,不需要每秒重复喊一次;不然日志会被打架刷满。
        const id = d.entity && d.entity.id
        const now = Date.now()
        /*
         * ⚠️ 只按 entity.id 节流是不够的:周围有好几只怪时,nearestEntity 每秒可能返回不同的一只,
         * id 一直在变 → 照样每秒刷一行(实测 12:04:30~36 连刷了 7 行)。
         * 所以:**换目标才重下攻击指令,日志用「时间」当硬闸**,两件事分开管。
         */
        if (id !== lastFightId) { actFight(); lastFightId = id }
        if (now - lastFightAt > 4000) {
          log(`⚔️ 正在还击 ${d.name}(血量 ${hp})`)
          lastFightAt = now
        }
        brainPausedUntil = now + 5000
      }
      // 这里【不要】return:下面还得处理呛水,不然又会顾此失彼
    }

    /*
     * 2) 在水里快没气了 → 一边往上浮一边往岸边游
     *
     * 🔴🔴 这一整段曾经【每次入水都抛异常】,而且被空 catch 静默吞掉整整一晚。
     * 原因:下面这些行引用了 nowMs,而 `const nowMs = Date.now()` 声明在本函数【更下面】
     * (同一个 try 块作用域 → 时间死区 TDZ)→ 每次入水第一行日志打出来之后立刻
     * `ReferenceError: Cannot access 'nowMs' before initialization`,被函数末尾的
     * `catch (e) { }` 吞掉,一个字都不留。
     * 后果:① 换朝向找岸(bot.look)永不执行,只会闷头朝入水那一刻的方向游;
     *       ② swimSince 恒为 0 → "泡够 90 秒传送自救"永不触发,淹水时没有任何逃生门;
     *       ③ 后面 75 秒卡住自救、"掉血看不见凶手"在水中 tick 一律被跳过。
     * 而第一行日志照样会打,所以【从日志看反射层像是正常的】——
     * 实测那串「氧气 6→3→2→1→0→-1」就是这么来的:它在水里什么都没做。
     * 改法:直接复用本函数开头已经算好的 tNow,不再引用后面才声明的 nowMs。
     * ⚠️ 教训:空 catch 是这个 bug 能藏一整晚的唯一原因 —— catch 里补了节流日志。
     */
    if (inWater) {
      if (!reflexSwim) {
        log(`💧 在水里(氧气 ${oxy}),往上浮并找岸`)
        reflexSwim = true
        swimSince = tNow
      }
      bot.setControlState('jump', true)
      // ⚠️ 光按跳只会原地浮着:实测连续 5 次触发仍卡在水里,必须同时往前游 + 隔几秒换朝向才找得到岸
      bot.setControlState('forward', true)
      if (tNow - lastSwimTurn > 2500) {
        lastSwimTurn = tNow
        try { bot.look(Math.random() * Math.PI * 2, -0.2, true) } catch (e) { /* 忽略 */ }
      }
      /*
       * 🔴 别再无限期压住大脑(这是我埋的死锁)。
       * 第一版每秒都把 brainPausedUntil 推后 3 秒 —— 结果它一漂在海里,**大脑永远不会运行**:
       * 实测 280 秒只决策了 1 次,而那一次又因为"在水里"没法安家,就彻底卡死在海上。
       * 现在只在【刚入水的头 10 秒】压制(防止大脑立刻又把它拽回水里),之后放开让它自己想办法。
       */
      if (tNow - swimSince < 10000) brainPausedUntil = tNow + 3000
      // 泡够 90 秒还没上岸 = 多半漂在大洋中央,自己游不出去,用传送自救
      if (tNow - swimSince > 90000) {
        const esc = homePos ? '/home base' : '/spawn'
        log(`💧 在水里泡了 90 秒还上不了岸 —— 发 ${esc} 自救`)
        say(esc)
        lastOutcome = '失败:漂在水里出不来,只好传送脱困'
        swimSince = tNow
        brainPausedUntil = tNow + 8000
      }
      return
    }
    if (reflexSwim) {
      try {
        bot.setControlState('jump', false)
        bot.setControlState('forward', false)   // 上岸了就别接着闷头往前跑
      } catch (e) { /* 忽略 */ }
      reflexSwim = false
      swimSince = 0
    }

    /*
     * 3) 正在掉血、而且【确实看不见怪】(远程骷髅、岩浆、溺水)→ 先离开原地再说
     * ⚠️ 这里的 `!d` 不能少:把怪物分支的 return 去掉之后,只要血量低,
     * 这一段会在**明明看见怪的同一秒**也触发 —— 实测日志里
     * "🏃 反射逃跑" 和 "⚠️ 看不见怪" 并排出现在 12:04:37,自相矛盾,
     * 而且这个错误结论会被当成 lastOutcome 喂给模型。
     */
    if (hurt && hp <= 8 && !d) {
      log(`⚠️ 血量掉到 ${hp} 但看不见怪 —— 先离开原地`)
      actWander()
      lastOutcome = `失败:血量掉到${hp},看不见凶手,先跑开了`
      brainPausedUntil = Date.now() + 5000
    }

    /*
     * 4) 卡住自救。Owner 实测它会卡在建筑里(尤其保护区)出不来。
     * 禁掉搭塔和挖路之后它更没辙了,所以给一个逃生门:直接发 /spawn 回出生点。
     * 只在"它本该在动"的时候判定 —— idle 是它自己选择站着不动,不算卡住。
     */
    const nowMs = Date.now()
    const here = bot.entity.position
    /*
     * ⚠️ 跟着人的时候"站着不动"是正常的 —— 玩家不动,它当然也不动。
     * 实测误判过一次:它正好好跟着 <OWNER>,却被判成"卡住"、一个 /spawn 传回了出生点,
     * 等于把人甩下了。所以:只要"正跟着某人、且那人就在身边",就不算卡住。
     */
    const fp = following && bot.players[following] && bot.players[following].entity
    const followingOk = !!(fp && fp.position.distanceTo(here) < 6)
    if (!lastStuckPos || here.distanceTo(lastStuckPos) > 1.5) {
      lastStuckPos = here.clone()
      lastMovedAt = nowMs
    } else if (lastAction !== 'idle' && !followingOk && nowMs - lastMovedAt > 75000) {
      // 有家就回自己家(出生点是保护区,回去也干不了活);还没安家才退回 /spawn
      const escape = homePos ? '/home base' : '/spawn'
      log(`🧭 75 秒没挪窝(多半卡在建筑或地形里)—— 发 ${escape} 自救`)
      say(escape)
      lastOutcome = '失败:卡住出不来,只好用 /spawn 回了出生点'
      memory.record({
        action: 'stuck', ok: false, reason: '卡住不动,用 /spawn 自救',
        pos: [Math.round(here.x), Math.round(here.z)],
      })
      lastMovedAt = nowMs
      lastStuckPos = here.clone()
      brainPausedUntil = nowMs + 10000
    }
  } catch (e) {
    /*
     * 🔴 这里原来是【完全静默】的空 catch —— 正是它让上面那个 TDZ 异常藏了一整晚。
     * 反射出错依然绝不能拖垮机器人,但必须留下痕迹。节流 30 秒,免得每秒刷一行。
     */
    if (Date.now() - lastReflexErrAt > 30000) {
      lastReflexErrAt = Date.now()
      log(`⚠️ 反射层出错(已吞下,不影响运行):${e && e.message}`)
    }
  }
}

// ——————————— 大脑循环 ———————————
async function brainTick() {
  if (!CFG.brainEnabled || !ready || !bot || thinking) return
  if (Date.now() < brainPausedUntil) return
  /*
   * 🔴 原来这里有一句 `if (pendingAction) return` —— 排着一步就不许再想。
   * Owner:「GPU 应该是连续不断地在思考和执行才对」。那一句正是让显卡歇着的原因之一:
   * 想好一步之后,在身体把它做完之前,大脑一直闲着。
   * 现在改成【永远接着想,新的判断覆盖旧的】—— 最新的判断永远基于最新的处境,
   * 而过时的打算本来就该被丢掉。
   */
  thinking = true
  try {
    const state = buildState()
    /*
     * 战略级硬规则(不交给模型决定):还没有家、且已经跑得够远、在陆地上 → 直接安家。
     * 为什么不靠提示词:我明明写了"最优先:先有自己的家",实测 240 秒里它一次都没选 set_home,
     * 反而两次去选必然失败的 store_items —— 小模型不可靠地遵守"优先级"这种文字指令。
     * 教训和 follow_player 那次一样:**靠菜单结构和硬规则,别靠叮嘱。**
     */
    let forced = null
    if (!homePos && bot.entity) {
      const p = bot.entity.position
      const dist = Math.hypot(p.x - SPAWN.x, p.z - SPAWN.z)
      const far = dist >= CFG.homeMinDist
      const dry = !(bot.oxygenLevel !== undefined && bot.oxygenLevel < 20)
      if (far && dry) forced = { action: 'set_home' }
      // 诊断:实测 240 秒硬规则 0 次触发却查不出原因 —— 把两个条件的实际值打出来,不再猜
      else log(`还没家:离出生点 ${Math.round(dist)} 格(要≥${CFG.homeMinDist})、在水里=${!dry} → 这轮先不安家`)
    }
    if (forced) log('战略规则:还没有家、已离出生点够远、在陆地上 → 直接安家(不问大脑)')
    /*
     * 战略规则 1.5:【手无寸铁 + 材料齐了 → 直接去做剑,不问大脑】
     *
     * 为什么必须升级成硬规则:今晚为了让它做剑,softer 的两招都试过、都失败了 ——
     *   ① 把「我有武器吗:没有,空手」摆进处境 → 做剑 0 次
     *   ② 在提示词里写明"做剑优先级很高"     → 做剑 0 次
     * 而同期它一直在濒死:14 次 flee 里 11 次是在 ≤2.7 血时逃命,贴脸冲锋触发 18 次,
     * 保命传送 3 次,仍然死了。**材料其实早就齐了**(自己做的木棍 + 20 多块木头 + 家门口有工作台)。
     * 这和 set_home、build_base 属于同一类:**"必须先做 A 才能做 B"的前置条件,靠叮嘱不管用,得用代码硬门。**
     *
     * ⚠️ 退避直接复用已有的 `failStreak`(连败计数,成功即清零),不再新增状态 ——
     *    craft 连续失败 3 次这条规则就自动停火,避免重演 build_base 那种"每分钟空转 140 次"的死锁。
     */
    /*
     * 🔴 做东西【永远排在吃饭和活命后面】。
     *
     * 这是我自己在上一版引入的回归,实据(2026-09-16 UTC 03:30:24 饿死前 90 秒):
     *   03:30:09 战略规则 → 做 planks   → 成功:做出了 4 个 birch_planks
     *   03:30:12 战略规则 → 做 planks   → 成功:做出了 4 个 spruce_planks
     *   03:30:16 战略规则 → 做 planks   → 成功:做出了 4 个 birch_planks
     *   03:30:19 战略规则 → 做 planks   → 失败
     *   03:30:23 战略规则 → 做 planks   → 成功:做出了 4 个 birch_planks
     *   03:30:24 ☠️ starved to death
     * **它一路做木板做到饿死。**
     * 原因是结构性的:`forced` 只有一个槽位,而制作链是规则 1.5、
     * 吃饭是 1.6、打猎是 1.7 —— 1.5 一旦命中,后面两条整轮都轮不到。
     * 制作链在这一版之前从没触发过,所以这个顺序问题一直是隐性的;
     * 我把链条补全后它每几秒就命中一次,直接把吃饭挤没了。
     *
     * 修法:给制作链加一道"身体状况"闸,条件和 1.6/1.7 完全对齐 ——
     * 只要已经到了该吃饭或该打猎的地步,就不许做东西。
     * (不改规则顺序,是因为顺序调整牵动五条规则、风险大于收益;
     *  这道闸在语义上等价,而且把意图写在了条件里。)
     */
    const bodyOkToCraft = bot.food === undefined ||
      (bot.food > 8 && !(bot.health !== undefined && bot.health < 12 && bot.food < 18))
    if (!forced && bot.entity && bodyOkToCraft && failCount('craft') < 3 &&
        Date.now() - lastForcedCraftAt > 12000 && Date.now() > craftStallUntil) {
      const armed = WEAPON_RANK.some((n) => countItem(new RegExp('^' + n + '$')) > 0)
      const planks = countItem(/_planks$/)
      const sticks = countItem(/^stick$/)
      const cobble = countItem(/^cobblestone$/)
      const logs = countItem(/_log$/)
      const tableInBag = countItem(/^crafting_table$/) > 0
      let tableNear = false
      try {
        const mcd = require('minecraft-data')(bot.version)
        tableNear = !!bot.findBlock({ matching: mcd.blocksByName.crafting_table.id, maxDistance: 32 })
      } catch (e) { /* 找不到就当没有,顶多多做一个工作台 */ }
      /*
       * 🔴 这条规则原来【一次都没触发过】,因为它只覆盖了链条的最后一步。
       *
       * 实测(2026-09-16 中午,RCON 逐样点名 + beacon 负对照):
       *   oak_log 22 + birch_log 10 = 32 块原木
       *   stick 1 根
       *   木板 0、圆石 0、工作台 0、剑 0
       * 旧条件是 `没武器 && 木棍≥1 && (木板≥2 || 圆石≥2)` —— 木板和圆石都是 0,
       * 于是这条"硬规则"整天空转。而同一天它 30 次选了 craft,结果里写得明明白白:
       *   「失败:做 wooden_sword 需要工作台,附近没有、背包里也没有(先 craft crafting_table)」
       * 它知道该先做工作台,但没有任何东西推它去做 —— 光靠大脑自己想,一次都没想到。
       *
       * 这直接关系到今天 30 次死亡里的 16 次:被射死 10 + 被近战怪砍死 6。
       * 它赤手空拳没护甲,所以打不过也逃不掉。**手里有 32 块原木,却从没做出过一件东西。**
       *
       * 现在把整条链都写成硬规则,从它当前所处的那一环开始推:
       *   原木 →(2x2,不用工作台)木板 → 工作台 → 木棍 →(要工作台)剑
       * ⚠️ 顺序很重要:先囤够木板再做工作台,否则做完工作台木板就不够做剑了。
       *   一次 craft planks = 4 个木板;剑要 2 个 + 工作台要 4 个 + 木棍要 2 个 = 8 个。
       * ⚠️ 仍复用 failCount('craft') < 3 退避,并加 3 秒节流,
       *   避免变成每秒空转的死锁(build_base 那次"每分钟空转 140 次"的教训)。
       */
      if (!armed) {
        let want = null, why = ''
        if (planks < 8 && logs >= 1) {
          want = 'planks'; why = `原木${logs}块但木板只有${planks}个`
        } else if (!tableInBag && !tableNear && planks >= 4) {
          want = 'crafting_table'; why = `有木板${planks}个,但附近和背包都没有工作台(做剑必须要)`
        } else if (sticks < 1 && planks >= 2) {
          want = 'stick'; why = `有木板${planks}个但一根木棍都没有`
        } else if (sticks >= 1 && (planks >= 2 || cobble >= 2)) {
          // 有圆石就做石剑(更耐用),否则木剑
          want = cobble >= 2 ? 'stone_sword' : 'wooden_sword'
          why = `木棍${sticks}根/木板${planks}个/圆石${cobble}块,材料齐了`
        }
        if (want) {
          /*
           * 🔴 断路器:连着推同一样东西却看不到库存增长 → 停火 5 分钟。
           *
           * 实据:上一个窗口这条规则 300 秒内触发 67 次,其中 49 次都是"去做木板",
           * 而木板数量全程在 0↔5 之间跳、从没到过条件里的门槛 8,
           * 于是它把原木源源不断喂进一个没有出口的循环 —— 和当初 build_base
           * "每分钟空转 140 次"是同一种病。failCount 拦不住,因为合成大多"成功"了。
           * ⚠️ 节流也从 3 秒抬到 12 秒:合成现在要站定 + 等结算,4 秒一次根本做不完。
           */
          const nowPlanks = countItem(/_planks$/)
          if (want === craftLastWant && nowPlanks <= craftLastPlanks) {
            craftSameWant++
            if (craftSameWant >= 4) {
              craftStallUntil = Date.now() + 5 * 60 * 1000
              craftSameWant = 0
              log(`⛔ 连着 4 次推它做 ${want},木板却一直没涨(${craftLastPlanks}→${nowPlanks})—— 先停 5 分钟,别把原木全喂进去`)
            }
          } else {
            craftSameWant = 0
          }
          craftLastWant = want
          craftLastPlanks = nowPlanks
          lastForcedCraftAt = Date.now()
          forced = { action: 'craft', item: want }
          log(`战略规则:手无寸铁 —— ${why} → 先去做 ${want}(不问大脑)`)
        }
      }
    }
    /*
     * 战略规则 1.6:快饿死了、身上又【确实】有能吃的 → 直接吃,不问大脑。
     *
     * 实据(2026-09-16,腐肉修复上线后的 50 次决策):
     *   动作分布 gather_wood 34 / flee 28 / explore 9 —— **eat 0 次、hunt 0 次**,
     *   同期饱食度 7→6→5→4→3→2→1,背包里 27 块腐肉一口没吃,最后被 creeper 打死。
     * 提示词里白纸黑字写着「饥饿低于 15 且『背包有食物』为 true → 选 eat」,它就是不选。
     * 这正是本文件反复验证过的规律:**前置条件靠叮嘱治不好,得用硬规则。**
     * (set_home、build_base、做剑,三次都是这么从"劝不动"变成"能做到"的。)
     *
     * ⚠️【2026-09-16 修正:上一版这个门槛是我自己设错的,以下是实测证据】
     *   原来只在「饱食度 ≤ 6」时夺权,结果造出一个死区。RCON 每 10 秒采一次:
     *     18:20:14  血2.67  食11  饱和0   腐肉27
     *     18:20:35  血2.67  食10
     *     18:20:56  血2.67  食10
     *     18:21:17  血2.67  食9    腐肉27   ← 整整 60 秒血量纹丝不动,一口没吃
     *   同期 10 条决策【全是 flee】,而每一条的日志都写着「有吃的是(rotten_flesh)」。
     *   食物 7~12 这一段:高于 6 所以我不夺权,又远低于回血线所以血永远回不来,
     *   于是它揣着 27 块腐肉钉在 2.67 血上,保命传送每 30 秒空放一次(实测 15 次)。
     *
     *   回血线是【实测】出来的,不是我凭印象写的:两小时内排除死亡重生后只有 5 次真回血,
     *   干净的三条全部发生在饱食度 20(19.8→20、18.8→19、19→20),
     *   而饱食度 ≥18 的样本只占 18.5% —— 它几乎从没到过能回血的水平。
     *
     *   所以判据要瞄准【能不能回血】,而不是【会不会饿死】:
     *     · 快饿死(食 ≤6)          → 吃
     *     · 血不够又吃不饱(血<12 且 食<18)→ 也吃,否则血永远回不来
     * ⚠️ 退避复用 failStreak('eat'),连败 3 次就不再强制 ——
     *    免得重演 build_base 那次"硬规则没退避 → 140 次/分钟"的事故。
     * ⚠️ 再加一道【3 秒内不重复夺权】:实测这条规则 2 秒里触发 6 次只换来 2 次真吃,
     *    和我刚修掉的"同一个打断被执行 25 遍"是同一类病(brainTick 是连续循环)。
     * ⚠️ 条件里直接调 foodItem():它为 null 时绝不强制,
     *    所以哪怕腐肉那条修复是错的,这条规则也只会静默不触发,不会制造死循环。
     */
    if (!forced && bot.entity && bot.food !== undefined &&
        failCount('eat') < 3 && Date.now() - lastForcedEatAt > 3000) {
      const starving = bot.food <= 6
      const cantHeal = bot.health !== undefined && bot.health < 12 && bot.food < 18
      if (starving || cantHeal) {
        const ff = foodItem()
        if (ff) {
          lastForcedEatAt = Date.now()
          forced = { action: 'eat' }
          log(`战略规则:血${bot.health} 食${bot.food}(${starving ? '快饿死' : '血不够又吃不饱、回不了血'})、背包里有「${ff.name}」 → 直接吃(不问大脑)`)
        }
      }
    }
    /*
     * 战略规则 1.7:身上一样吃的都没有、又快饿了 → 直接去打猎,不问大脑。
     *
     * 实据(2026-09-16,半径对齐版那 24 次决策):
     *   动作分布 gather_wood 24 / flee 15 / explore 3 —— **hunt 0 次、eat 0 次**;
     *   同期饱食度 16→15→14→9→8→7→2,而「有吃的」字段 24 次全是「否」(腐肉已吃光);
     *   RCON 同时确认(带正负对照:末影龙=空、玩家=命中):
     *     64 格内有 pig / chicken / sheep,128 格内还有 cow。
     *   **猎物就在 64 格内,模型却一次都没想起来去打。**
     *
     * 为什么必须是硬规则:这和"揣着 27 块腐肉饿死"是同一个病 ——
     * 提示词里早就写着「饥饿低而背包没食物 → 选 hunt」,它照样不选。
     * 本文件已经验证过四次:前置条件靠叮嘱治不好(set_home / build_base / 做剑 / 强制吃)。
     * 强制吃上线后 17 次触发换来 17 次真吃,同一套路。
     *
     * 而 hunt 是这份代码里【唯一】能凭空产出食物的动作 —— 没有它,吃的链路就是无源之水。
     * 饿死是服务器权威口径下并列第一的死因(整夜 13 次死亡里占 4 次)。
     *
     * ⚠️ 门槛:食物 ≤8 且【背包里一样吃的都没有】。
     *    还有吃的时候绝不抢 —— 那种情况该由上面的规则 1.6 直接吃,而不是跑出去打猎。
     * ⚠️ 退避复用 failStreak('hunt'),连败 3 次就不再强制(可能附近真的没动物)。
     * ⚠️ 15 秒锁,理由见 lastForcedHuntAt 的声明处。
     */
    /*
     * ⚠️【2026-09-16 补漏:两条硬规则的门槛之间漏了一条缝,它正卡在缝里】
     *   实测现场:血 3.0 / 食 16 / 饱和度 2.4 / 背包里一样吃的都没有(逐样点名确认)。
     *     · 规则 1.6(强制吃)要 foodItem() 非空 —— 肉刚吃完,不触发;
     *     · 本规则原来只看「食 ≤ 8」 —— 食 16,也不触发;
     *     · 而回血要「食 ≥ 18」 —— 于是血 3 永远回不来。
     *   这和之前那个「食物 7~12 死区」是同一类错误,只是换了个位置:
     *   我在规则 1.6 里已经用 `血<12 且 食<18` 补过这个洞,**这条却漏了同样的补丁**。
     *   现在两条规则的判据对齐,形成闭环:【有吃的就吃,没吃的就去打】。
     */
    if (!forced && bot.entity && bot.food !== undefined &&
        failCount('hunt') < 3 && Date.now() - lastForcedHuntAt > 15000) {
      const hungry = bot.food <= 8
      const cantHealNoFood = bot.health !== undefined && bot.health < 12 && bot.food < 18
      if ((hungry || cantHealNoFood) && !foodItem()) {
        lastForcedHuntAt = Date.now()
        forced = { action: 'hunt' }
        log(`战略规则:血${bot.health} 食${bot.food}(${hungry ? '快饿了' : '血不够又吃不饱、回不了血'})、身上一样吃的都没有 → 去打猎弄肉(不问大脑)`)
      }
    }
    /*
     * 战略规则 2(Owner:「他应该自己生产出工作台、自己制作箱子、自己摆放」):
     * 有家了 + 身上有木头 + 却还没有自己的箱子 → 直接回家建,不问大脑。
     * 依据:实测它背着 22 块木头在野外 idle→idle→wander 空转,
     * 因为没有自己的箱子,store_items 不在菜单里,菜单被饿到只剩"逛"和"发呆"。
     */
    if (!forced && homePos && !myChest && bot.entity && Date.now() >= buildPausedUntil &&
        (woodCount() >= 4 || countItem(/_planks$/) >= 4)) {
      forced = { action: 'build_base' }
      log(`战略规则:有木头 ${woodCount()} 块/木板 ${countItem(/_planks$/)} 个、还没有自己的箱子 → 回家造工作台和箱子(不问大脑)`)
    }
    /*
     * 战略规则 2.5:背包满了、又没有杂物可扔 → 回家存箱子,不问大脑。
     *
     * 实测依据(2026-09-17 一夜):`🧹 背包 36 格全满、却没有可以扔的杂物` 出现 52 次。
     * 背包满 = collectblock 在挖之前就抛 `no defined chest locations`,
     * **每一次砍树都必然失败**(gather_wood 从 63% 掉回 41%)。
     * 而 tidyInventory 只扔"对目标毫无用处"的东西,它身上塞的全是自己攒的家当(树苗/竹子/钻石/盔甲…),
     * 一样都不该扔 —— 所以扔不动,只能存。
     *
     * 🔴 位置:排在吃饭(1.6)和打猎(1.7)【之后】,理由同盖房子那条 ——
     *    forced 是单一插槽,把非保命的活排到吃饭前面就会重演"做木板做到饿死"。
     * 🔴 门槛用【空格 ≤1】:留一格余量,别等到彻底满了才动身。
     */
    if (!forced && myChest && bot.entity && bot.inventory.emptySlotCount() <= 1 &&
        bot.food !== undefined && bot.food >= 10 &&
        Date.now() - lastForcedStoreAt > 120000) {
      lastForcedStoreAt = Date.now()
      forced = { action: 'store_items' }
      log(`战略规则:背包只剩 ${bot.inventory.emptySlotCount()} 个空格、又没有杂物可扔 → 回家存箱子(不问大脑)`
        + ` —— 不腾出格子的话,砍树会一次都成不了`)
    }
    /*
     * 战略规则 3(Owner:「怎么造房子是他自己来决策啦 我非常期待小麦可以自己造出房子」):
     * 有家了 + 不饿 + 血够 + 有够一种材料 20 块以上 + 房子还没盖完 → 回家砌墙,不问大脑。
     *
     * 🔴 位置很要紧:这条【排在吃饭(规则 1.6)和打猎(1.7)之后】。
     *    依据是本文件里那条血的教训 —— forced 是单一插槽,craft 排在 eat 前面,
     *    结果它"做木板做到饿死"(死亡追踪显示连续 90 秒在做 planks 直到 starved to death)。
     *    盖房子比做木板更长,更不能抢在吃饭前面。
     * 🔴 也不进决策菜单:实测真实提示打真网关,"空手"处境 6/6 选 craft stick、
     *    build_house 0 次;本文件已有两个同类 0 采纳先例。靠结构,别靠叮嘱。
     */
    if (!forced && homePos && bot.entity && Date.now() >= buildPausedUntil &&
        Date.now() >= buildHousePausedUntil &&
        !(house && house.done) &&
        bot.food !== undefined && bot.food >= 12 &&
        bot.health !== undefined && bot.health >= 12 &&
        Date.now() - lastHurtAt > 15000 &&
        /*
         * 材料门槛:【还没开工】要攒够 20 块(免得刚砌两块就断炊);
         * 【已经开工】只要还有 1 块本房子的材料就继续 —— 也包括"其实已经砌完、
         * 只是 done 标记还没翻过来"这一种:实测墙已经 22/22 被服务器确认,
         * 但因为泥土用到只剩十几块,规则不再触发,done 就一直是 false、🎉 也打不出来。
         */
        (house
          ? countItem(new RegExp('^' + house.material + '$')) >= 1
          : bot.inventory.items().some((i) => /^(dirt|cobblestone|.*_planks|.*_log|stone|sand)$/.test(i.name) && i.count >= 20))) {
      forced = { action: 'build_house' }
      const m = bot.inventory.items().filter((i) => /^(dirt|cobblestone|.*_planks|.*_log|stone|sand)$/.test(i.name) && i.count >= 20)
      log(`战略规则:血${bot.health} 食${bot.food} 都够、身上有 ${m.map((i) => i.name + '×' + i.count).join('、')}`
        + ` → 回家盖房子(不问大脑)${house ? `,已砌到 ${houseBlocks(house).filter((p) => { const b = bot.blockAt(p); return b && b.name === house.material }).length}/${houseBlocks(house).length}` : ',还没开工'}`)
    }
    /*
     * 主脑(5060)不可用时降级到 M1 —— 理由见 brainDownUntil 的声明处。
     * decide() 和 plan() 共用同一套 callModel,入参就是 {url, model, timeoutMs},
     * 所以换一个 cfg 就能换一块显卡,brain.js 一行都不用改。
     * 降级期的超时压到 20 秒:M1 实测 9 秒一次,20 秒足够,又不会像 60 秒那样把循环冻住。
     */
    const primaryDown = Date.now() < brainDownUntil
    if (usingBackupBrain && !primaryDown) {
      usingBackupBrain = false
      log(`↩️ 降级期满,回去试主脑(${CFG.brain.model} @ 5060)`)
    }
    const brainCfg = primaryDown
      ? { url: CFG.backup.url, model: CFG.backup.model, timeoutMs: CFG.backup.timeoutMs }
      : CFG.brain
    const { action, raw, why } = forced
      ? { action: forced, raw: null, why: null }
      : await decide(state, brainCfg, roles.persona(ROLE.key).text)
    /*
     * 主脑失败记账:连续 2 次「没反应」就判定它掉线,降级 2 分钟。
     * ⚠️ 只认「没反应」(网络/超时),不认「回答里找不到 JSON」那类 ——
     *    后者说明模型活着只是答得不好,换机器解决不了,反而会白白丢掉更快的 14b。
     */
    if (!forced && !primaryDown) {
      if (why && why.indexOf('大脑没反应') === 0) {
        brainFailStreak++
        if (brainFailStreak >= 2) {
          brainFailStreak = 0
          brainDownUntil = Date.now() + 120000
          usingBackupBrain = true
          log(`⚠️ 主脑(204网关 ${CFG.brain.model})连续没反应 → 临时改用备用入口 203网关(${CFG.backup.model}),2 分钟后自动回去试`)
        }
      } else if (why) {
        /*
         * 🔴「大脑活着,但答的东西根本用不了」—— 这一类过去是【完全没有声音】的。
         *
         * 为什么需要它:模型活着但答不对时,上面那条降级判据【不会触发】(它只认超时),
         * 于是会变成"一个不停给出废话、却没有任何告警"的状态 —— 比直接掉线更难发现。
         * 这里不自动降级(答得不好换机器不一定解决),只负责【让它看得见】。
         *
         * ⚠️ 这段注释的前一版写错了,现已纠正(2026-09-16 晚):
         *   我原先写"网关在 5060 关机时会回落到 qwen3:4b,而 4b 实测 0/5",
         *   并把 0/5 归因为"这个尺寸跟不住 schema"。**两处都不对:**
         *   ① 网关的兜底已经是三级,第二三级都是 qwen2.5:3b(不是 qwen3:4b);
         *   ② qwen3:4b 那个 0/5 的真因【不是尺寸,也不是 Ollama 版本】——
         *      是普通 `qwen3:4b` 这个模型本身坏:加 think:false 会把推理混进正式回答,
         *      不加则回答为空;`/no_think`、放大 num_predict、改系统指令、换 /api/generate 全无效。
         *      晴海跨 3 台机器 × 2 个 Ollama 版本 × 2 个接口验证,4b 每次都坏、8b 每次都干净。
         *      (我先前跟着写成"Ollama 0.34.1 版本问题",那是错的,已随晴海第三版纠正。)
         *   ③ 兜底那两级现在用的是【不带思考的 instruct 变体】
         *      `qwen3:4b-instruct-2507-q4_K_M`。拿 XiaoMai 的真实提示(3971 字)实测:
         *      205 上 845~3559ms、203 上 3633ms,**两台都是 5/5 可用,选的动作和 8b 一致**。
         *      所以 5060 关机之后它照样能玩 —— 这是建整套降级逻辑的初衷,现在由底座解决了。
         *      ⚠️ 别把兜底当成 qwen2.5:3b:那是晴海第二版的写法,已作废
         *         (我当时测出 3b 也是 5/5,结论没错,但对现在的配置不适用了)。
         */
        brainJunkStreak++
        if (brainJunkStreak >= 5 && Date.now() - lastBrainJunkAt > 60000) {
          lastBrainJunkAt = Date.now()
          log(`🤪 大脑连着 ${brainJunkStreak} 次给不出能用的动作(不是超时,是答得不对):${why}｜原话:${short(raw)}`)
          log(`   ⚠️ 先看网关 http://<AI-GATEWAY>/health 现在派给了哪一级(5060→iMac2→本机);` +
            ` 三级都实测能跑通 XiaoMai 的提示,所以连着答不对更像是提示词或处境异常,不一定是后端问题`)
          brainJunkStreak = 0
        }
      } else if (action) {
        brainFailStreak = 0
        brainJunkStreak = 0
      }
    }
    if (!action) {
      /*
       * 🔴 非法动作【不能只丢弃】—— 丢弃等于没有出路,会死循环。
       * 实测:模型连续 6 分钟每 2.3 秒选一次被屏蔽的 gather_wood,
       * 每次丢弃 → 处境一字未变 → 下一轮必然选同一个 → 无限重复。
       * 显卡 100% 空转,进度卡在 24/64 纹丝不动,日志刷了近 200 行。
       *
       * 两条出路一起上(和今天反复验证的那条原则一致:代码要给退路,不能只靠提示词叮嘱):
       *   ① 把"你选的动作不在允许列表里"如实写进 lastOutcome,下一轮提示词里它就能看见;
       *   ② 连续犯 3 次以上就【代码替它挑一个允许的动作】—— 优先探索,换个地方处境自然会变。
       */
      rejectStreak++
      const nowR = Date.now()
      if (nowR - lastRejectLogAt > 15000) {      // 别让这行日志每 2 秒刷一次
        lastRejectLogAt = nowR
        log(`大脑这次没用上:${why}(已连续 ${rejectStreak} 次)${raw ? ` | 原话: ${short(raw)}` : ''}`)
      }
      lastAction = 'idle'
      lastOutcome = `失败:我选的动作现在不允许(${why})—— 必须从「现在可以做的动作」里挑,换一个`
      if (rejectStreak >= 3) {
        const allowed = Array.isArray(state['现在可以做的动作']) ? state['现在可以做的动作'] : []
        const pick = allowed.includes('explore') ? 'explore' : (allowed[0] || 'wander')
        const dirs = ['东', '东南', '南', '西南', '西', '西北', '北', '东北']
        const fb = pick === 'explore'
          ? { action: 'explore', direction: dirs[Math.floor(Math.random() * dirs.length)] }
          : { action: pick }
        log(`连续 ${rejectStreak} 次都给不出合法动作 → 代码替它选「${fb.action}${fb.direction ? ' ' + fb.direction : ''}」换个处境,别在原地空转`)
        rejectStreak = 0
        pendingAction = { action: fb, at: Date.now() }
      }
      return
    }
    rejectStreak = 0
    // 进度要显示【存进箱子的数量】(目标metric),背包木头只是过程量 ——
    // 之前两个混着显示,日志里出现"进度 73/64"这种看着像超额完成的假象
    // 只负责"想好并排队",做由 actTick 那个循环去做 —— 想和做从此互不阻塞
    pendingAction = { action, at: Date.now() }
    /*
     * ⚠️ 必须把坐标(尤其 Y)记进日志。
     * Owner 说「特别在地下矿洞」,我却【无法验证】—— 因为整份日志只有死亡时才带 Y,
     * 平时根本不记位置高度,等于这个现象不可诊断。不可诊断的问题没法修。
     */
    const bp = bot.entity ? bot.entity.position : null
    const posTag = bp ? `(${Math.round(bp.x)},y=${Math.round(bp.y)},${Math.round(bp.z)})` : '(位置未知)'
    /*
     * ⚠️ 把「我知道的地方」也打进日志。
     * 实测:goto_place 上线后模型 0 次选用,而我【无法判断】是它不想用,
     * 还是这个字段根本就是空的 —— 因为处境 JSON 从不进日志,我看不见它到底看到了什么。
     * 不可诊断的东西没法修(Y 坐标、护栏拒绝原因那两次都是这么吃的亏)。
     */
    let mapTag = ''
    try {
      const mp = state['我知道的地方']
      mapTag = mp ? ` 地图:${Object.entries(mp).map(([k, v]) => `${k}=${v}`).join(' ')}` : ' 地图:空'
    } catch (e) { mapTag = ' 地图:读不到' }
    /*
     * ⚠️ 「有吃的」必须进日志。
     * 实测(新版上线后 50 次决策):eat 0 次、hunt 0 次,饱食度一路 7→1,
     * 背包里 27 块腐肉一口没吃 —— 而我【无法判断】到底是模型不肯选 eat,
     * 还是 foodItem() 根本返回了 null(那样「背包有食物」就是 false,模型选 eat 也白选)。
     * 处境 JSON 从不进日志,这个区别看不见 = 不可诊断。今晚这个亏已经吃过好几次。
     */
    let foodTag = ''
    try { const ff = foodItem(); foodTag = ` 有吃的${ff ? '是(' + ff.name + ')' : '否'}` } catch (e) { foodTag = ' 有吃的读不到' }
    log(`大脑决定: ${JSON.stringify(action)}  ${posTag} [存箱 ${storedTotal}/${CFG.goalCount} 背包木头${woodCount()} 血${bot.health} 食${bot.food}${foodTag}]${mapTag}`)
    /*
     * 偶尔把模型给的理由说给玩家听 —— 这是"看起来不傻"的关键:
     * 玩家看见的不再是一个乱走乱逃的木头人,而是"它在想什么"。
     * 限频 2 分钟一句(公屏上都是小学生,刷屏比不说更糟);
     * 理由已在 brain.js 里过了脏话/命令过滤才会带过来。
     */
    if (action.why && Date.now() - lastWhyAt > 15000) {
      lastWhyAt = Date.now()
      /*
       * ⚠️ 必须同时记一行日志才能【验证】它到底说没说。
       * say() 只是 bot.chat(),内容只进游戏聊天、不进日志 ——
       * 我上一版拿"日志里搜不到这句话"当成"它没说",那个判据【本身是无效的】,
       * 搜不到只能说明日志里没有,证明不了游戏里没说。
       */
      /*
       * 🗣️ 恢复往公屏说想法 —— Owner:「XiaoMai 必须能说话」。
       *
       * 上一轮我为了止损把这句改成"只进日志",那是【当时】正确的:
       * 服务器的 GriefPrevention 会把中文判成乱码并累计封号(已封 2 次)。
       * 但那个原因现在没有了 —— Owner 拍板拆掉了服务器侧的规则:
       *   Spam.Enabled true → false(整个反刷屏模块关闭)
       *   BanOffenders  true → false
       * 按时间戳核对:关闭时刻(11:23:35)之后 Muted gibberish 0 次、Kicking 0 次、Banning 0 次。
       * 止损条件消失,就该把嘴还给它 —— 否则"能说话"只是理论上的:
       * 实测关闭后它一句公屏话都没说过,因为这一条本来就是它最主要的发声来源。
       *
       * ⚠️ 频率:原来是 2 分钟一句(lastWhyAt > 120000)。Owner 说「60 秒才一句话 不行的」,
       *    所以降到 15 秒。完全不节流会变成每 3 秒一句(决策间隔就是 3~4 秒),
       *    公屏上都是小学生,那样是纯噪音 —— 这个数字很容易调,要更勤就改小。
       */
      /*
       * 🔴 Owner 2026-09-16:「xiaomai 话太多了,自己的想法先不要发出来,自己想就好了」。
       *
       * 所以【只关掉"主动播想法"这一条】,不是让它闭嘴:
       *   · 别人叫它、问它时照常回应(handleChat → 交给大脑);
       *   · 完成目标、报坐标、报进度这些照常;
       *   · /home、/register 这类命令本来就走 say(),更不能动。
       * ⚠️ 想法本身【继续想、继续记】—— why 照常进日志(下面这行),
       *    也照常进「玩家刚说的话/上一步理由」喂回给模型。
       *    改的只是"要不要念出来",不是"要不要想"。
       * ⚠️ 要恢复的话:把下面那行 say 解开即可(节流常量 lastWhyAt > 15000 原样留着)。
       */
      log(`🗣️ (只记在日志,不发到公屏)它的想法:${action.why}`)
    }
  } catch (e) {
    log('大脑循环出错:', e.message)
    lastOutcome = `失败:出错了(${short(e.message)})`
  } finally {
    thinking = false
  }
}

/*
 * 身体的循环:把大脑想好的那一步做掉。跑得比大脑快(0.5 秒一轮),
 * 所以大脑一想好就能立刻开做,不用等下一个 8 秒。
 */
/*
 * 大脑的【连续循环】—— 不再是每 8 秒被闹钟叫醒一次,而是想完一轮立刻接着想。
 * Owner:「本地模型应该即时执行,GPU 应该连续不断地思考」。
 * 实测改之前:28 次决策 / 300 秒,每次约 2.2 秒 → 显卡只忙了约 20%,其余时间在等定时器。
 * 留一个很小的间隔(默认 300 毫秒)是为了:模型报错时不至于变成死循环把 CPU 打满。
 */
async function brainLoop() {
  /*
   * 🔴 决策下限 300ms → 2500ms。这不是"降速",是【别当坏邻居】。
   *
   * 实测(2026-09-16 深夜,Owner 把 5060 关掉之后):
   *   · 小麦的 brainLoop 是连续的(想完立刻再想),所以它的请求速率不是固定值,
   *     而是 1÷延迟 —— **它会把可用容量全吃光**。
   *     (我先前算"一个机器人只要 0.37 次/秒"是错的:那个 0.37 是"5060 快所以只需要这么多"
   *      的结果,不是需求。)
   *   · 后果落在唯一有真人在等的那条路上:**老麦回孩子话从 443~3273ms 变成 10156ms**。
   *   · 而且这些请求大多是白花的:5060 在线时决策 257 次、真正开始执行只有 141 次,
   *     **约 45% 当场被丢掉**(动作要跑 3~16 秒,期间想出来的用不上)。
   *
   * 2500ms 的依据:它的动作本来就要 3~16 秒,所以这个下限几乎不改变它的行为,
   * 却把大半容量还给老麦和以后的新角色。
   * ⚠️ 保命完全不受影响 —— 那在每秒一次的 reflexTick 里,不走这个循环。
   * 要调就改 /etc/mcbot.env 的 BRAIN_FLOOR_MS,不用改代码。
   */
  const floorMs = Math.max(100, parseInt(process.env.BRAIN_FLOOR_MS || '2500', 10))
  for (;;) {
    try { await brainTick() } catch (e) { log('大脑循环异常:', e.message) }
    await new Promise((r) => setTimeout(r, floorMs))
  }
}

/*
 * 规划师的连续循环(跑在 M1 上)。
 * 「想得勤、换得少」:一直在想下一个阶段目标(M1 因此始终有活干),
 * 但只有在【还没有计划】或【计划过期】时才真正采纳新的 ——
 * 否则目标每 2 秒换一个,它会永远在改主意、什么都做不完。
 */
async function planLoop() {
  /*
   * 🔴 失败要退避 + 限流,不能硬刷。
   * M1 是 Owner 的笔记本:要解锁 FileVault、可能睡眠、可能关机 —— 掉线是正常情况。
   * 若每秒重试一次并每次打一行日志,M1 一掉线就是每秒一行。
   * 今天的教训里就有一次:一个 1 秒一次的日志 210 秒写了 15MB / 22817 行,
   * 而机器人和游戏服同机,日志失控 = 游戏服有风险。
   */
  let failStreakPlan = 0
  let lastPlanWarnAt = 0
  for (;;) {
    try {
      /*
       * 🔴 主脑掉线、决策已降级到 M1 时,把规划师【暂停】—— 把 M1 整块让给决策。
       *
       * 依据:Ollama 对同一个模型是【串行】处理的,而这个循环每 1 秒就敲一次门、
       * 每次生成又要好几秒;决策请求会一直排在它后面,降级用的 20 秒超时很可能白等,
       * 那样这次降级就等于没做。
       * 阶段目标只是锦上添花,决策才是命根子 —— 缺一个计划无所谓,缺决策它就是木头人
       * (实测:主脑掉线那 11 分钟里「大脑决定 0 次、超时 11 次」,它只能每分钟随机挪一步)。
       * ⚠️ 实测 M1 热模型 + 小提示词只要 0.3~0.9 秒,争用未必致命;
       *    但降级本就是应急状态,把唯一一块还能用的显卡让给最要紧的事更稳妥。
       * 主脑一恢复(brainDownUntil 到期且探活成功),规划师自动回来,不需要人管。
       */
      if (ready && bot && !planning && Date.now() >= brainDownUntil) {
        planning = true
        try {
          const st = buildState()
          const r = await plan(st, CFG.planner)
          if (r.plan) failStreakPlan = 0
          if (r.plan) {
            const stale = !currentPlan || (Date.now() - planSetAt) > CFG.planFreshSec * 1000
            if (stale) {
              const changed = !currentPlan || currentPlan.goal !== r.plan.goal
              currentPlan = r.plan
              planSetAt = Date.now()
              if (changed) {
                log(`🧭 新阶段目标(规划师):${r.plan.goal}` +
                    `${r.plan.steps.length ? ` | 步骤:${r.plan.steps.join(' → ')}` : ''}` +
                    `${r.plan.why ? ` | 因为:${r.plan.why}` : ''}`)
              }
            }
            // 没过期就丢掉这次结果 —— M1 的算力不是白花的,它保证了计划随时是新鲜的备选
          } else if (r.why) {
            failStreakPlan++
            // 同一个毛病最多 60 秒报一次,别让 M1 掉线变成每秒一行日志
            if (Date.now() - lastPlanWarnAt > 60000) {
              lastPlanWarnAt = Date.now()
              log(`规划师这次没用上:${r.why}(已连续 ${failStreakPlan} 次)`)
            }
          }
        } finally { planning = false }
      }
    } catch (e) { log('规划循环异常:', e.message) }
    /*
     * 正常 1 秒一轮(M1 始终有活干);连续失败就逐步退避,最长 30 秒 ——
     * M1 关机时不该还在每秒敲它的门。
     */
    const waitMs = failStreakPlan > 0 ? Math.min(30000, 1000 * Math.pow(2, Math.min(failStreakPlan, 5))) : 1000
    await new Promise((r) => setTimeout(r, waitMs))
  }
}

async function actTick() {
  if (!ready || !bot) return
  /*
   * 打断正在做的事 —— 这才是 Owner 要的"即时"。
   * 大脑现在一直在想;如果它想出来的下一步和正在做的事【不是同一件】,
   * 说明处境变了,就该立刻掐掉手上的动作去干新的,而不是把新判断干等到旧动作做完。
   * (掐掉的方式和超时封顶同一套:停寻路 + 停挖掘,动作那边会自己收尾。)
   */
  /*
   * 🔴 不是所有动作都该被打断 —— 这是今晚打断机制反噬的实测教训。
   *
   * 现象(2026-09-16):夜里怪物不断,模型每 2.4 秒就选一次 flee,
   * 而 hunt 需要 20~30 秒(走过去 + 打死 + 捡肉)。结果日志里
   * 「打断「hunt」→ 改做「flee」」**连刷 35 次,打猎一次都没跑完**,
   * 饱食度一路掉到 0、眼看又要饿死 —— 而 64 格内明明有牛、猪、鸡。
   * 我为了"反应快"加的打断,把唯一能解决饥饿的动作卡死了。
   *
   * ⚠️ 保护它不会让它挨打没反应:真正保命的是 reflexTick 每秒一次的反射,
   *    反射根本不走这个队列(逃跑/还击/血量见底传送回家都在那一层)。
   */
  /*
   * 🔴 把保护从"只保打猎"推广到【所有耗时的生产性动作】。
   *
   * 实测时序(2026-09-16)证明砍树和打猎是同一个病:
   *   17:31:00 打断「gather_wood」→ 改做「flee」
   *   17:32:08 打断「gather_wood」→ 改做「explore」→ 砍不动(The goal was changed)
   *   17:32:04 砍不动(Digging aborted)            ← 正是打断里 stopDigging 造成的
   * 砍一棵树要"走过去 + 挖好几秒",任何一次 flee/explore 插进来就把它掐掉。
   *
   * 更糟的是它会【级联】:
   *   打断 → 砍树失败 → failStreak 累到 3 → gather_wood 被冷却屏蔽 →
   *   模型还在选 → 连续 5 次「大脑这次没用上」→ 第二个死循环。
   *
   * 新规矩:耗时动作只允许被【真正的紧急情况】打断(血量低且要去逃/打),
   * 其余一律让它跑完 —— 反正 ACT_CAP_MS(30 秒)已经封顶,不可能永远挂着。
   * ⚠️ 安全性依旧由 reflexTick 每秒一次的反射兜底,反射不走这个队列(已核实它确实在跑)。
   */
  /*
   * ⚠️ craft 是 2026-09-16 加进来的,实据:
   *   日志里「打断「craft」→ 改做「wander」/「flee」/「explore」」共 3 次,
   *   同期「做 wooden_sword 时出错(Event windowOpen did not fire within timeout)」5 次、成功仅 1 次。
   * 合成现在要"站定 + 开背包窗口 + 等服务端结算"(约 1.5~2 秒),
   * 中途被 setGoal(null)+stopDigging 一掐,窗口就开不起来。
   */
  const LONG_ACTIONS = ['gather_wood', 'hunt', 'build_base', 'goto_place', 'store_items', 'craft']
  if (acting && LONG_ACTIONS.includes(actingName) && pendingAction) {
    const next = pendingAction.action.action
    /*
     * 🔴 紧急的判据:从「血量 ≤ 10」(状态)改成【刚挨打 或 怪已贴脸】(事件)。
     *
     * 上一版失败的实据:本次部署后「打断「gather_wood」」0 次(这半边有效),
     * 而「打断「hunt」」25 次(这半边完全失效)—— 因为当时血量钉在 9.5,
     * `bot.health <= 10` 恒为真,等于这条保护对 hunt 根本没生效过。
     * 而血回不去正是因为饿,饿又正是因为 hunt 被打断:**它自己咬住了自己的尾巴。**
     *
     * ⚠️ 这【不是】"没怪就不给 flee"那条已撤回的屏蔽(那次 260 秒死 8 次)。
     * 区别很要紧:菜单里 flee 一直都在、模型随时能选;这里只管
     * "一个已经在跑的耗时动作要不要被腰斩",而且反射层(每秒一次、独立通道)照常兜底 ——
     * 实测 8 分钟触发 20 次,含「血量只剩 X → 传送回家」和「骷髅放冷箭 → 冲上去」。
     */
    let emergency = false
    if (SURVIVAL.includes(next)) {
      if (Date.now() - lastHurtAt < 6000) emergency = true
      else {
        const h = nearestHostile()
        emergency = !!(h && h.dist < 5)
      }
    }
    /*
     * 🔴 饿肚子【也算紧急】—— 否则把 craft 加进保护名单会造出新的饿死路径。
     * 审查意见(HIGH):craft 一次可占满 30 秒,而 hunt/eat 是唯一的产粮通路,
     * 永远夺不了权。这和今天那个"做木板做到饿死"是同一个坑,只是换了个入口。
     * 判据和硬规则 1.6/1.7 对齐:快饿死了,或者血低到回不了血。
     */
    if (!emergency && actingName === 'craft' && bot.food !== undefined) {
      if (bot.food <= 8) emergency = true
      else if (bot.health !== undefined && bot.health < 12 && bot.food < 18) emergency = true
    }
    if (!emergency && next !== actingName) {
      /*
       * 不是真的紧急 → 手上的活照旧干完,但这个想法【不丢掉】,存成"下一步"。
       * 原来这里是 `pendingAction = null`,等于把大脑刚想出来的结果扔进垃圾桶,
       * 动作跑完只能从头再想一遍 —— 那段 1~4 秒的空转就是"走几步停下来发呆"的真因。
       */
      /*
       * 🔴 队列里已经是【保命动作】时,不许被普通决定原地覆盖。
       * 审查意见(HIGH):queuedNext 是"最后写入者赢"的单槽位,
       * 硬规则 1.6 排进去的「吃饭」会被下一个模型决定冲掉,而吃饭没有第二条通路 ——
       * 那正是今天「一路做木板做到饿死」那个 bug 的翻版。
       */
      if (queuedNext && SURVIVAL.includes(queuedNext.action.action) && !SURVIVAL.includes(next)) {
        pendingAction = null
        return
      }
      // 记下存入时的位置:取出时若已经走远,带方向/地名的旧意图就不该再执行
      try { pendingAction.pos = bot.entity ? bot.entity.position.clone() : null } catch (e) { pendingAction.pos = null }
      queuedNext = pendingAction
      pendingAction = null
      return
    }
  }
  if (acting && pendingAction && pendingAction.action.action !== actingName) {
    if (Date.now() - actingSince > 2000) {   // 刚开始 2 秒内不打断,免得来回抖
      /*
       * 🔴 一个动作只打断【一次】。
       * 原来这里打断之后既不清 pendingAction,acting 也要等动作跑完才落下,
       * 而 actTick 是 `setInterval(actTick, 300)` —— 每 300 毫秒重新进来一次。
       * 于是同一个打断意图被反复执行:实测 11 秒刷出 25 条「打断「hunt」」,
       * setGoal(null) + stopDigging 连发,把打猎彻底钉死。
       * **那不是模型改了 25 次主意,是一次意图被执行了 25 遍。**
       */
      if (interruptedFor !== actingName) {
        interruptedFor = actingName
        /*
         * 🔴 被腰斩的耗时活要【记下来】,险情过去再回来接着做。
         * Owner:「处理完之后还是回到原来的任务上」。
         * 原来这里打断完就彻底丢了 —— 它砍树砍到一半被僵尸赶跑,
         * 之后就再也想不起自己本来在砍树,要靠大脑碰巧又选一次 gather_wood。
         * 存的是完整动作对象(带 item/direction/place 参数),不是名字。
         */
        let noted = ''
        if (LONG_ACTIONS.includes(actingName) && actingAction) {
          /*
           * 🔴【blocker 修复】同一个动作被反复腰斩时【不许刷新时间戳】。
           * 审查意见原话:"每次被再腰斩都刷新 at,60 秒上限形同不存在 → 无限「回去挨打」循环"。
           * 不刷新,那 60 秒上限才是真的封顶。
           */
          if (!resumeAction || resumeAction.action !== actingAction) {
            if (resumeAction) log(`🗑️ 覆盖掉还没回去的「${resumeAction.action.action}」`)
            resumeAction = { action: actingAction, at: Date.now(), pos: (bot.entity ? bot.entity.position.clone() : null) }
            resumeTries = 0
          }
          noted = ',等险情过去再回来接着做'
        }
        log(`打断「${actingName}」→ 改做「${pendingAction.action.action}」(处境变了)${noted}`)
        try { bot.pathfinder.setGoal(null) } catch (e) { /* 忽略 */ }
        try { bot.stopDigging() } catch (e) { /* 没在挖就会抛,忽略 */ }
      }
    }
    return
  }
  if (acting) return
  /*
   * 手上没活了 —— 按这个顺序找下一件事做,目的是【不留空档、不丢线索】:
   *   ① 险情刚过 → 回到被腰斩的那个活(Owner 明确要求的)
   *   ② 否则 → 用大脑在上一个动作执行期间就已经想好的那一步(消掉发呆)
   *   ③ 否则 → 等大脑这一轮的新结果(原有行为)
   */
  if (!pendingAction && resumeAction) {
    const age = Date.now() - resumeAction.at
    const back = resumeAction.action
    /*
     * 🔴 安全判据和【打断时用的那一套】对齐,不再用 brainPausedUntil。
     * 审查意见:远程怪那条分支每秒无条件把 brainPausedUntil 推后 4 秒,
     * 16 格内有骷髅时它永远不为"安全",于是 60 秒后静默丢弃 —— 等于这个功能不存在。
     */
    /*
     * 🔴【我自己引入的回归,已修正】
     *
     * 我一度把 brainPausedUntil 从这里拿掉了(理由是:远程怪分支每秒无条件把它推后 4 秒,
     * 16 格外一只够不着人的骷髅就能让 resume 永远轮不到)。那个观察本身是对的,
     * 但拿掉它会造成【更糟的后果】,反驳者指出了我漏看的两行:
     *   提拔之后紧跟着就是 `if (Date.now() < brainPausedUntil) { pendingAction = null; return }`,
     *   而 resumeAction 在提拔的那一行就已经清空了 ——
     *   于是反射接管期间会变成:清掉记忆 → 塞进动作 → 两行后被抹掉 → 活【当场永久丢失】,
     *   比不改还早丢 59 秒,而且同样不吭声。
     * 而且就算把下面那行一起放开,提拔出来的 gather_wood 会和反射层每秒一次的
     * actFlee()+setGoal() 抢寻路,复现已知的
     * 「The goal was changed → Digging aborted → failStreak → gather_wood 被冷却屏蔽」级联。
     *
     * 所以 brainPausedUntil 这一项是【承重的】,必须和下面那行保持同一口径。
     * ⚠️ 「远处的骷髅无限按住大脑」是一个【独立于本次改动】的老问题
     *    (改动前的 bot.js 里一字不差),它牵动保命行为,要单独评估、不要混进来。
     * 等不到安全时的兜底不是"放宽判据",而是下面那条 60 秒丢弃【一定要打日志】——
     * 那才是真正缺的东西(今天已经因为静默失效整夜白跑过)。
     */
    let safe = Date.now() >= brainPausedUntil
    if (safe) {
      try {
        if (Date.now() - lastHurtAt < 6000) safe = false
        const h = nearestHostile()
        if (h && h.dist < 5) safe = false
        if (bot.health !== undefined && bot.health <= 6) safe = false
      } catch (e) { /* 判断不了就当安全,反射层兜底 */ }
    }
    /*
     * 🔴 回去之前【重跑一遍闸门】。
     * 审查意见(HIGH):resume 是直接往 pendingAction 塞动作,绕过了 brainTick 那边所有的
     * 退避和护栏 —— 其中 bodyOkToCraft 那道闸,正是今天为「做木板做到饿死」装上的。
     * 绕过它等于把刚补好的洞又挖开。
     * ⚠️ 每一条丢弃都要打日志:今天刚因为"静默失效"整夜白跑过。
     */
    let block = ''
    if (age > 60000) block = `记下来已经 ${Math.round(age / 1000)} 秒,处境多半变了`
    else if (resumeTries >= 2) block = '已经捡回来过 2 次还是没干成,把决定权还给大脑'
    else if (failCount(back.action) >= 3) block = `${back.action} 已经连续失败 ${failCount(back.action)} 次,正在冷却`
    else if (back.action === 'build_base' && Date.now() < buildPausedUntil) block = '建基地正在冷却'
    else if (back.action === 'craft' && Date.now() < craftStallUntil) block = '合成正在冷却(断路器)'
    else if (back.action === 'craft' && bot.food !== undefined &&
             (bot.food <= 8 || (bot.health !== undefined && bot.health < 12 && bot.food < 18))) {
      block = '现在该先吃饭而不是做东西'
    } else if (resumeAction.pos && bot.entity) {
      try {
        const moved = bot.entity.position.distanceTo(resumeAction.pos)
        if (moved > 32) block = `已经离开原地 ${Math.round(moved)} 格`
      } catch (e) { /* 算不出就不拦 */ }
    }
    if (block) {
      log(`🗑️ 放弃回到「${back.action}」:${block}`)
      resumeAction = null
      resumeTries = 0
    } else if (safe) {
      resumeAction = null
      resumeTries++
      pendingAction = { action: back, at: Date.now() }
      log(`↩️ 险情过去了,回到原来的活:${back.action}(第 ${resumeTries} 次捡回)`)
    }
  }
  let fromQueue = false
  if (!pendingAction && queuedNext) {
    /*
     * 取出前先看"还是不是同一处境":带方向/地名的旧意图,人走远了就不该再执行。
     * 保命动作另算一道更短的保鲜期 —— 29 秒前的 flee 会对着空地跑,还把假教训写进经验库。
     */
    let drop = ''
    const qAge = Date.now() - queuedNext.at
    if (SURVIVAL.includes(queuedNext.action.action) && qAge > 6000) drop = '保命动作过期'
    else if (queuedNext.pos && bot.entity) {
      try { if (bot.entity.position.distanceTo(queuedNext.pos) > 12) drop = '已经走远' } catch (e) { /* 不拦 */ }
    }
    if (drop) { queuedNext = null } else { pendingAction = queuedNext; queuedNext = null; fromQueue = true }
  }
  if (!pendingAction) return
  // 反射(逃跑/游泳/吃饭)接管期间,之前想好的那一步已经不合时宜了,直接丢掉
  if (Date.now() < brainPausedUntil) { pendingAction = null; return }
  const { action, at } = pendingAction
  pendingAction = null
  const waited = Date.now() - at
  if (waited > 20000 && !SURVIVAL.includes(action.action)) {
    log(`丢掉一个过期的打算(${action.action},想好后等了 ${Math.round(waited / 1000)} 秒还没轮到,情况多半变了)`)
    return
  }
  /*
   * 🔴 记账放在【两道丢弃闸门之后、真正开始执行之前】。
   * 审查意见(HIGH):原来计数和日志打在闸门之前,反射接管时这一步其实被销毁了,
   * 却照样记成"接上了" —— 那个"累计 N 次"是上限不是实测值。
   */
  if (fromQueue) {
    queuedUsed++
    if (Date.now() - lastQueueLogAt > 30000) {
      lastQueueLogAt = Date.now()
      log(`⏭️ 上一步刚做完就直接接上了早想好的「${action.action}」(累计 ${queuedUsed} 次,省掉的就是"发呆"那几秒)`)
    }
  }
  // 动作【开始】的标记 —— 没有它就没法量"发呆"到底有多久(等了多少毫秒才轮到)
  log(`▶️ 开始做「${action.action}」(想好后等了 ${waited}ms${fromQueue ? ',来自预排队列' : ''})`)
  acting = true
  actingName = action.action        // 供"新判断要不要打断它"用
  actingAction = action             // 完整对象 —— 被打断后要靠它原样回来
  actingSince = Date.now()
  interruptedFor = ''               // 新动作开始 → 重新允许打断一次
  /*
   * 🔴 超时封顶的定时器【必须显式取消】—— 这是 2026-09-17 凌晨用诊断钩子当场抓到的 bug。
   *
   * 原来写的是 `Promise.race([executeAction(action), new Promise(res => setTimeout(...))])`。
   * 问题:**Promise.race 不会取消输掉的那一边**。动作正常完成后,
   * 那个 30 秒的 setTimeout 还活着 —— 30 秒后照样触发,
   * 对着【当时正在跑的另一个动作】执行 setGoal(null) + stopDigging()。
   *
   * 而决策是每 2.5 秒一次(BRAIN_FLOOR_MS),等于空中永远飘着一串"定时炸弹",
   * 每颗在自己那个动作结束 30 秒后炸一次别人。
   *
   * 现场证据(诊断钩子打出来的调用链,同一个 bot.real.js:3473):
   *   「gather_wood」跑了 29999ms 时目标被改成 null  ← 合理,是它自己的封顶
   *   「goto_place」 跑了  3212ms 时目标被改成 null  ← 才跑 3.2 秒,不可能是它自己的
   *   「explore」    跑了  2645ms 时目标被改成 null  ← 同上
   *
   * 这同时解释了两类报错:setGoal(null) → `The goal was changed before it could be completed!`
   * (见 mineflayer-pathfinder 的 lib/goto.js:34,它监听 goal_updated);
   * stopDigging() → `Digging aborted`。
   *
   * ⚠️ 教训:**Promise.race 里任何带副作用的定时器都必须 clearTimeout**,
   *    否则副作用会延迟到别人身上 —— 而且因为延迟,现场看起来和起因毫无关系。
   */
  let capTimer = null
  try {
    const outcome = await Promise.race([
      executeAction(action),
      new Promise((res) => {
        capTimer = setTimeout(() => {
          capTimer = null   // 自己已经触发了,finally 里就别再 clear
          log(`⏱️ 「${action.action}」卡了 ${ACT_CAP_MS / 1000} 秒,掐掉(停寻路 + 停挖掘)`)
          try { bot.pathfinder.setGoal(null) } catch (e) { /* 忽略 */ }
          try { bot.stopDigging() } catch (e) { /* 没在挖就会抛,忽略 */ }
          res(`失败:这个动作卡了 ${ACT_CAP_MS / 1000} 秒还没做完,我掐掉了 —— 不能让一个动作把大脑堵死`)
        }, ACT_CAP_MS)
      }),
    ])
    lastAction = action.action + (action.player ? `(${action.player})` : '')
    lastOutcome = outcome
    /*
     * 建基地连续失败就先停一停,把决定权还给模型(让它去找块平地)。
     * 不加这个的话,硬规则会在同一个放不下的地方无限重试(实测 1 分钟 140 次)。
     */
    if (action.action === 'build_base') {
      if (outcome.startsWith('成功')) { buildFailStreak = 0 } else {
        buildFailStreak++
        if (buildFailStreak >= 3) {
          buildPausedUntil = Date.now() + 90000
          buildFailStreak = 0
          log(`🏗️ 建基地连续失败 3 次(${short(outcome)})—— 先停 90 秒,让大脑自己想办法换块平地`)
          lastOutcome = `失败:这地方放不下工作台和箱子(多半站在树上或不平的地方)—— 先 explore 找块平整的实地再建`
        }
      }
    }
    const p = bot.entity ? bot.entity.position : null
    const ok = outcome.startsWith('成功')
    /*
     * 🔴【最重要的一条修复】在动作【真正结束】的地方判断它是不是被腰斩的。
     *
     * 审查意见原话:"resumeAction 只在 actTick 的打断分支记账,而真正腰斩长动作的是
     * reflexTick —— 改动 2 在主路径上根本不会触发"。这话是对的:
     * 反射层每秒一次、【不走动作队列】,它直接 actFlee()/say('/home base')/setGoal(...)
     * 把正在跑的 gather_wood 的寻路目标冲掉,然后只设 brainPausedUntil,全程不碰 resumeAction。
     * 只在 actTick 的打断分支记账 = 只覆盖了次要路径。
     * 这和今天另外两次"只修了一半"(看到动物才记 / 打到猎物才记)是同一种病。
     *
     * 同时修掉另一条(HIGH):【自己跑完了的动作绝不能再捡回来重做一遍】。
     */
    if (LONG_ACTIONS.includes(action.action)) {
      if (ok) {
        if (resumeAction && resumeAction.action === action) { resumeAction = null; resumeTries = 0 }
      } else if (!resumeAction) {
        // 只有在"保命反射当时正在接管"时才算被腰斩;单纯做失败了不算,那该走连败退避
        const cutByReflex = (Date.now() < brainPausedUntil) || (Date.now() - lastHurtAt < 6000)
        if (cutByReflex) {
          let pos = null
          try { pos = bot.entity ? bot.entity.position.clone() : null } catch (e) { pos = null }
          resumeAction = { action, at: Date.now(), pos }
          log(`📌 「${action.action}」被保命反射打断了(${short(outcome)})—— 记下来,险情过去再回来`)
        }
      }
    }
    // 连败计数:成功就清零,失败就累加 —— 供屏蔽/冷却和处境展示用
    failStreak.set(action.action, ok ? 0 : failCount(action.action) + 1)
    failStreakAt.set(action.action, Date.now())
    memory.record({
      action: action.action,
      ok,
      reason: outcome,
      pos: p ? [Math.round(p.x), Math.round(p.z)] : null,
    })
    log(`执行结果: ${outcome}`)
    checkGoal()
  } catch (e) {
    log('执行动作出错:', e.message)
    lastOutcome = `失败:出错了(${short(e.message)})`
  } finally {
    // 动作已经结束 —— 把封顶定时器拆掉,绝不让它 30 秒后去炸别的动作
    if (capTimer) { clearTimeout(capTimer); capTimer = null }
    acting = false
    actingAction = null
  }
}

// ——————————— 玩家指挥(永远优先于大脑)———————————
/*
 * 🗣️ 玩家最近说的话 —— Owner 的想法:「让 XiaoMai 身边的玩家跟他的对话来影响他的想法」。
 *
 * 原来这些话只用来匹配四个关键词(跟我来/在这等/你在哪/目标),其余一律丢掉;
 * 现在把原话也留一份塞进处境 JSON,模型每轮都看得见,就能顺着接话、改主意。
 * ⚠️ 只留最近 3 条、每条截断 60 字:小模型吃不下长列表(memory.js 已经验证过这条)。
 * ⚠️ 丢掉以 / 开头的内容 —— 绝不让玩家借这个字段诱导它去发游戏命令。
 * ⚠️ 这是【别人写的文字】,对模型来说是数据不是命令;它只能从固定动作清单里挑,
 *    所以最坏情况也就是被带偏去砍树/探索,闯不出护栏之外。
 */
const recentChats = []
let lastReplyAt = 0
const lastReplyTo = new Map()
const lastGaveTo = new Map()

/*
 * 🔴 真的把东西递给玩家 —— Owner 2026-09-16:
 * 「小麦不仅仅是要语言上的回答玩家,实际的动作反馈啥的都要符合他的人格设定,
 *   比如"小麦你给我一点吃的吧",小麦可能自己都快饿死了所以不给,
 *   或者自己有很多食物可以给」
 *
 * 分工(这一版的界限我改过一次,以 Owner 后来那句为准):
 *   · 【模型按人格决定】给不给、给多少 —— 若由代码定死,三个角色就只剩腔调不同,
 *     大方/小气这种真正的人格差别根本表达不出来;
 *   · 【代码只管物理】:没有的给不出去、不能超过实际持有量、同一个人不能无限索要。
 * 关键是决定以结构化的 give 字段回来、由这里执行 —— 所以"说了给"和"真的给"不可能分叉。
 *
 * ⚠️ 刻意【不设】"留几份给自己"的下限:那是人格该决定的事,不是我该替它决定的。
 *    但给完必须把前后账目打进日志(饥饿 x→y、剩几份),
 *    这样"大方会不会把自己饿死"是能被测出来的,而不是靠猜。
 */
async function giveTo(username, kind, count) {
  if (!bot || !bot.entity) return '失败:还没准备好'
  const isFood = kind === 'food'
  const re = isFood ? FOOD_RE : /_log$|_planks$/
  const word = isFood ? '吃的' : '木头'
  let items
  try { items = bot.inventory.items().filter((i) => re.test(i.name)) } catch (e) { return '失败:看不了背包' }
  const have = items.reduce((a, i) => a + i.count, 0)
  if (have <= 0) return `失败:身上一份${word}都没有,给不了`
  const want = Math.max(1, Math.min(count, have))   // 夹紧:不能给超过实际持有
  const pl = bot.players && bot.players[username]
  const pe = pl && pl.entity
  if (!pe || !pe.position) return `失败:看不见 ${username}(离太远或区块没加载)`
  let d = 999
  try { d = pe.position.distanceTo(bot.entity.position) } catch (e) { return '失败:算不出距离' }
  if (d > 4) {
    try {
      await bot.pathfinder.goto(new goals.GoalNear(pe.position.x, pe.position.y, pe.position.z, 2))
    } catch (e) { /* 走不到也先试试,可能本来就够近 */ }
    try { d = pe.position.distanceTo(bot.entity.position) } catch (e) { /* 忽略 */ }
    if (d > 6) return `失败:走不到 ${username} 跟前(还差 ${Math.round(d)} 格),东西没给出去`
  }
  try { await bot.lookAt(pe.position.offset(0, 1.6, 0), true) } catch (e) { /* 不看也能丢 */ }
  const foodBefore = bot.food
  let left = want
  let gave = 0
  for (const it of items) {
    if (left <= 0) break
    const take = Math.min(left, it.count)
    try { await bot.toss(it.type, null, take); gave += take; left -= take }
    catch (e) { break }
  }
  if (gave <= 0) return `失败:丢东西的时候出错了,一份都没给出去`
  let after = 0
  try { after = bot.inventory.items().filter((i) => re.test(i.name)).reduce((a, i) => a + i.count, 0) } catch (e) { /* 忽略 */ }
  return `成功:给了 ${username} ${gave} 份${word}(${word} ${have}→${after},饥饿 ${foodBefore}→${bot.food})`
}
function rememberChat(username, message) {
  const t = String(message || '').replace(/[\r\n]+/g, ' ').trim()
  if (!t || t.startsWith('/')) return
  recentChats.push(`${username}:${t.slice(0, 60)}`)
  while (recentChats.length > 3) recentChats.shift()
}

/*
 * 🔴 同一句话只处理一次 —— 这是死循环换来的教训。
 *
 * 实测(2026-09-16 11:13~11:14):Owner 在游戏里问了一句
 *   「XiaoMai,你现在打算去做什么」
 * 然后日志里出现:
 *   11:13:39 XiaoMai: 我在呢!可以让我"跟我来"或"在这等"…
 *   11:13:51 同一句      11:14:03 同一句      11:14:23 同一句   ← 4 次
 *   [GriefPrevention] Kicking XiaoMai for spam.  ×5
 * 机制:mineflayer 每次【重连】都会把服务器补发的聊天再抛一遍 chat 事件,
 * 而下面那条"被点名就回一句"是无条件的 —— 于是
 *   进服 → 看到那句话 → 念台词 → 被踢 → 重连 → 又看到 → 又念…  自己撞自己。
 * 所以按 (说话人 + 原话) 去重,重复的直接丢掉。
 */
const handledChats = new Set()

function handleChat(username, message) {
  if (!ready) return
  if (username === bot.username) return
  const key = `${username}|${String(message || '').slice(0, 80)}`
  if (handledChats.has(key)) return
  handledChats.add(key)
  if (handledChats.size > 50) {
    // 只留最近 50 条,别让这个 Set 无限长胖(常驻进程)
    const first = handledChats.values().next().value
    handledChats.delete(first)
  }
  rememberChat(username, message)
  const mentioned = NAME_RE.test(message)
  if (mentioned || RE_FOLLOW.test(message) || RE_STOP.test(message)) log(`听到 ${username}: ${message}`)

  if (RE_STOP.test(message) && (mentioned || following === username)) {
    // 动作照旧执行(它正跟着你,你就该能叫停);但没点名就【默默停下】,不出声
    stopFollow(!mentioned)
    brainPausedUntil = Date.now() + 60 * 1000
    lastAction = 'idle'; lastOutcome = `${username} 让我停下`
    return
  }
  /*
   * 🔴 必须【提到名字】才算指令。两个理由:
   * ① Owner 的规格:「除非有人在聊天框里提到他们的名字,他们才回答」;
   * ② 更要紧的 —— 原来这条【不要求名字】,于是任何孩子在公屏说一句"跟我来"
   *    就能把机器人牵走。那不只是吵不吵,是【谁能指挥它】的问题。
   */
  if (RE_FOLLOW.test(message) && mentioned) {
    startFollow(username)
    brainPausedUntil = Date.now() + 5 * 60 * 1000
    lastAction = `follow_player(${username})`; lastOutcome = `${username} 让我跟着他`
    return
  }
  if (RE_WHERE.test(message) && mentioned) {
    const p = bot.entity && bot.entity.position
    say(p ? `我在 ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : '我也不知道我在哪…')
    return
  }
  if (RE_GOAL.test(message) && mentioned) {
    say(`我的目标是${CFG.goalText},现在收集了 ${woodCount()} 块木头。`)
    return
  }
  if (mentioned) {
    /*
     * 🔴 不再念固定台词 —— Owner 的原话是「让身边玩家跟他的对话来影响他的想法」。
     *
     * 原来这里无条件 say 一句"我在呢!可以让我跟我来或在这等…",
     * 结果 Owner 问「你现在打算去做什么」,它答「可以让我跟我来」——
     * 这不是对话,是自动应答机,而且正是刷屏被踢的直接来源。
     *
     * 现在把这句话交给【大脑】:rememberChat 已经把原话塞进处境 JSON 的
     * 「玩家刚说的话」字段,模型每轮都看得见,可以自己决定
     *   · 用 say 动作认真回一句(它知道自己在干什么,答得上来)
     *   · 或者干脆改变行动(比如 Owner 说"你不造个房子吗" → 它去 build_base)
     * 这才是"对话影响想法",而不是"对话触发台词"。
     */
    /*
     * 🔴 被点名 → 真的回一句话。
     * Owner 的规格是两半:【不主动说想法】+【被点名才回答】。
     * 我今天关掉"说出想法"时顺手把唯一的发声渠道也关了,于是后半句其实【不存在】——
     * 它只记日志、一个字都不回。这里补上,走 brain.js 里和决策完全分开的 chat() 通道
     * (只会说话、说不出游戏命令,且有三道硬闸:禁 / 开头、脏词表、长度截断)。
     * ⚠️ 节流:同一个人 6 秒内只回一次,全场 3 秒内只回一次(几个人同时叫不能变刷屏)。
     * ⚠️ 不 await:回话是顺便的事,绝不能堵住每 300ms 的动作循环。
     * ⚠️ 想不出合格内容就沉默 —— 宁可不说,不要乱讲。
     */
    const cnow = Date.now()
    const lastForThis = lastReplyTo.get(username) || 0
    if (cnow - lastReplyAt < 3000 || cnow - lastForThis < 6000) {
      log(`👂 ${username} 叫我,但离上次回话太近,这次不回(避免刷屏)`)
    } else {
      lastReplyAt = cnow
      lastReplyTo.set(username, cnow)
      if (lastReplyTo.size > 50) { const k0 = lastReplyTo.keys().next().value; lastReplyTo.delete(k0) }
      /*
       * 给模型【真实的账】,它才有得判断。
       * 刻意写成大白话而不是字段名:模型对"我背包里有 3 份吃的"的理解
       * 比对 {food:3} 稳得多(今天验证过好几次:结构化数据要么原样透传,要么说成人话)。
       */
      let foodN = 0, woodN = 0
      try { foodN = countItem(FOOD_RE); woodN = countItem(/_log$|_planks$/) } catch (e) { /* 忽略 */ }
      const situation = `我在做 ${lastAction || '没事'};我的血 ${bot.health}、饥饿 ${bot.food}(20 是饱);` +
        `我背包里有 ${foodN} 份能吃的东西、${woodN} 块木头`
      log(`👂 ${username} 点名叫我:${String(message).slice(0, 40)} —— 去想一句回话(我有吃的${foodN}/木头${woodN},饿${bot.food})`)
      chat(username, String(message).slice(0, 120), situation, CFG.brain, roles.persona(ROLE.key).text)
        .then(async (r) => {
          if (!r || !r.say) { log('   (没想出合格的回话,这次就不说了)'); return }
          log(`   💬 回 ${username}:${r.say}${r.give ? `  (它决定给 ${r.give.count} 份 ${r.give.what})` : ''}`)
          say(r.say)
          if (!r.give) return
          /*
           * 同一个人 3 分钟只能拿一次 —— 这是【防无限索要】,属于物理限制,
           * 不是替它做人格判断(给不给仍然是它自己定的)。
           */
          const gnow = Date.now()
          const lastG = lastGaveTo.get(username) || 0
          if (gnow - lastG < 180000) {
            log(`   ⏳ ${username} 刚拿过东西(${Math.round((gnow - lastG) / 1000)} 秒前),这次不给(防无限索要)`)
            return
          }
          lastGaveTo.set(username, gnow)
          if (lastGaveTo.size > 50) { const k1 = lastGaveTo.keys().next().value; lastGaveTo.delete(k1) }
          const out = await giveTo(username, r.give.what, r.give.count)
          log(`   🎁 ${out}`)
        })
        .catch((e) => log('   回话出错(不影响其它):', e && e.message))
    }
  }
}

function createBot() {
  /*
   * 🔴 启动第一件事:把【实际拿到的身份和白名单】打出来。
   * 审查意见原话:"启动第一行把实际拿到的白名单打进日志(写错第一秒就能看见)"。
   * 不打的话,ROLE 配错、roles.json 被改坏、白名单为空这三种情况都是【静默】的 ——
   * 机器人照样登录、照样跑,只是什么都不做,而日志里看不出为什么。
   */
  const pr = roles.persona(ROLE.key)
  log(`👤 我是【${ROLE.cnName}】(${ROLE.login},角色 ${ROLE.key}${ROLE.relation ? ',' + ROLE.relation : ''})`)
  log(`   能做的 ${ROLE.actions.length} 件事:${ROLE.actions.join(' ')}`)
  log(`   大目标:${CFG.goalText}`)
  log(`   人格 ${pr.text.length} 字${pr.err ? `(⚠️ 读档案出错:${pr.err})` : '(改 roles.json 存盘即生效,不用重启)'}`)
  log(`连接 ${CFG.host}:${CFG.port} 用户名=${CFG.username}`)
  ready = false
  bot = mineflayer.createBot({
    host: CFG.host, port: CFG.port, username: CFG.username, auth: 'offline',
  })
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)   // 挖掉方块 + 自动把掉落物捡起来(自己写的捡拾不靠谱)
  bot.loadPlugin(pvp)            // 打架:自动靠近、瞄准、挥手

  bot.on('login', () => log(`登录包 OK,协议版本 ${bot.version}`))

  bot.once('spawn', () => {
    log('已进入世界')
    reconnectDelay = 5000
    setTimeout(() => { log('发送 /register'); say(`/register ${CFG.password} ${CFG.password}`) }, 1500)
    setTimeout(() => { log('发送 /login'); say(`/login ${CFG.password}`) }, 4000)
    setTimeout(() => {
      try {
        const mcData = require('minecraft-data')(bot.version)
        const moves = new Movements(bot, mcData)
        moves.canDig = false          // 寻路时不许破坏方块开路;砍树是单独显式执行的
        moves.allowSprinting = true
        /*
         * 🔴 真正让它"在别人地盘上放方块"的元凶在这儿,不是 placeFromInventory。
         * pathfinder 默认允许 1x1 搭塔:遇到高地就往脚下垫方块爬上去。
         * CoreProtect 查出它堆了好几根 4 格高的圆石/泥土柱子(如 (33,69~72,-92)),
         * 一共放了 27 块。在有孩子建筑和保护区的生存服上,这就是乱建。
         * 我之前只禁了 canDig,**从没禁过搭塔**,所以"禁止放置"那版修复根本没盖住真凶。
         * (注意 scafoldingBlocks 是库里本身就拼错的名字,别"顺手改对"。)
         */
        moves.allow1by1towers = false
        moves.scafoldingBlocks = []
        moves.canOpenDoors = false    // 也别去开别人家的门
        // 它淹死过、也被水里的 Drowned 打死过 —— 把水设成很贵的路,寻路能绕就绕开
        moves.liquidCost = 20
        /*
         * 🔴 会扎人/烧人的方块,寻路必须绕开。
         *
         * 依据是【服务器自己的死亡记录】(这才是真死因,不是我日志里那句"旁边有什么怪"):
         *   XiaoMai was poked to death by a sweet berry bush   ×2
         * 今晚 12 次死亡里有 2 次是【走进甜浆果丛被扎死】的,
         * 而这份代码原本对浆果丛【毫无认识】—— 寻路把它当成可以随便穿过去的草。
         *
         * blocksToAvoid 是寻路库里装 block id 的 Set(默认只有火/蛛网/岩浆,
         * 见 mineflayer-pathfinder/lib/movements.js:49),这里把同类
         * "站上去就掉血"的方块一起补上。sweet_berry_bush 在本服 1.21.4 上 id=816(已实测确认)。
         * ⚠️ 逐个判空再 add:某个方块名在别的版本里可能不存在,
         *    取不到就跳过,绝不能让机器人【开不了机】—— 那比被扎死严重得多。
         */
        for (const n of AVOID_BLOCKS) {
          const b = mcData.blocksByName[n]
          if (b) moves.blocksToAvoid.add(b.id)
        }
        log(`已让寻路绕开会掉血的方块(浆果丛/仙人掌/细雪/岩浆块等),清单共 ${moves.blocksToAvoid.size} 种`)
        bot.pathfinder.setMovements(moves)
        myMoves = moves

        /*
         * 🔬 纯诊断,不改任何行为:到底是谁在【长动作跑到一半】时改了寻路目标。
         *
         * 取证(2026-09-17 凌晨,25 分钟窗口):砍树失败 30 次,分三类 ——
         *   Digging aborted 13、The goal was changed 10、Took to long 7。
         * 失败当时的身体状态:血量平均 19.2、最低 17.0,【血量 ≤10 的是 0/29】。
         * → **不是保命反射干的**(反射要血量 ≤6/≤8 才动手)。我本来会猜错,数据拦住了。
         *
         * 唯一的强信号是"紧接着有新决策"(abort 10/13、goalchg 8/9),
         * 可 actTick 里明明有护栏:耗时动作不会被普通动作打断,会进 queuedNext 排队。
         * 而全文有 20 多处会改寻路目标(actFlee / wander / 各种 goto / 反射层…),
         * 光读代码分辨不出是哪一处 —— 所以在唯一的出口上记调用栈,让现场自己说话。
         *
         * 开销:平时只是一个布尔判断;只有 acting 为真才取栈,再加 10 秒节流。
         * 📖 机制(读 mineflayer-pathfinder 2.4.5 的 lib/goto.js 得到,不是猜的):
         *    goto() 会监听 'goal_updated',只要别人调了 setGoal 且新目标不是它自己那个,
         *    就立刻 reject('GoalChanged')。而 collectBlock 内部自己会调 goto ——
         *    所以【任何】外部 setGoal 都能掐掉正在进行的砍树。
         *    ⚠️ 另外两条报错性质完全不同,别混为一谈:
         *      · 'Took to long to decide path to goal!' 是 A* 在 thinkTimeout(默认 5000ms)
         *        内【没算出路来】,不是被打断;
         *      · 'Digging aborted' 不在 pathfinder 里,是 mineflayer 核心的挖掘中断。
         *
         * ⚠️ 这是【诊断】不是修复。查清楚之前不动任何行为 —— 静默地猜着改,等于没修。
         */
        try {
          const origSetGoal = bot.pathfinder.setGoal.bind(bot.pathfinder)
          let lastGoalLogAt = 0
          bot.pathfinder.setGoal = function (goal, dynamic) {
            try {
              // >1500ms 是为了跳过【动作自己开场那次 setGoal】——
              // 否则开场那一次会把 10 秒节流窗口吃掉,真正的打断者反而记不到。
              if (acting && actingName && Date.now() - actingSince > 1500
                  && Date.now() - lastGoalLogAt > 10000) {
                lastGoalLogAt = Date.now()
                const where = String(new Error().stack || '').split('\n').slice(2, 7)
                  .map((s) => s.trim().replace(/^at\s+/, '').replace(/\/home\/[^\s)]*\//g, ''))
                  .join(' ← ')
                log(`🔬 「${actingName}」跑了 ${Date.now() - actingSince}ms 时,有人把寻路目标改成 `
                  + `${goal && goal.constructor ? goal.constructor.name : String(goal)} —— 调用链:${where}`)
              }
            } catch (e) { /* 诊断本身绝不能影响寻路 */ }
            return origSetGoal(goal, dynamic)
          }
          log('🔬 已挂上「寻路目标被谁改了」的诊断钩子(只记录,不改行为)')
        } catch (e) { log('挂诊断钩子失败:', e.message) }

        /*
         * 🔴 放方块的【总闸】—— 不再跟寻路库的内部状态捉迷藏。
         *
         * CoreProtect 实据:即使我在启动时已经禁掉了搭塔、清空了脚手架清单
         * (日志明确打出"已同时禁掉 collectBlock 自带寻路的搭塔与脚手架"),
         * 它仍然在 09-16 01:08 放下圆石 —— 而且 x=49,50,51,52 同一高度连成一排,
         * 是【横向搭桥过沟】,和我只禁掉的"垂直搭塔"是两回事。
         * 材料来自它自己挖石头掉的圆石。
         *
         * 与其逐个去堵库里的行为分支,不如在唯一的出口上设闸:
         * 只有我主动放置、且【坐标对得上】那一格时才准放,其余一律拒绝。
         * 这样不管哪份 Movements 生效、库怎么更新,这条底线都不会被绕过。
         */
        if (!bot._placeGuardInstalled) {
          bot._placeGuardInstalled = true
          const realPlace = bot.placeBlock.bind(bot)
          bot.placeBlock = async (refBlock, faceVector) => {
            const okHere = placeAllowedAt && refBlock && refBlock.position &&
              refBlock.position.x === placeAllowedAt.x &&
              refBlock.position.y === placeAllowedAt.y &&
              refBlock.position.z === placeAllowedAt.z
            if (!okHere) {
              placeBlocked++
              if (placeBlocked <= 3 || placeBlocked % 50 === 0) {
                log(`🚫 拦下一次寻路自动放方块(累计 ${placeBlocked} 次)—— 只有我主动建造时才准放`)
              }
              throw new Error('放方块已被禁止(只有主动建造时才允许)')
            }
            return realPlace(refBlock, faceVector)
          }
          log('已安装"放方块总闸":寻路自动搭桥/搭塔一律拦截,只放行主动建造')
        }
        /*
         * collectBlock 有它自己的一份 Movements(源码 CollectBlock.js:153),砍树时会顶掉我的。
         * 所以【它那份也要一起禁搭塔】—— 只关"放方块"的能力,不动挖掘,
         * 否则它连目标方块都挖不了,砍树功能会整个失效。
         */
        try {
          const cm = bot.collectBlock && bot.collectBlock.movements
          if (cm) {
            cm.allow1by1towers = false
            cm.scafoldingBlocks = []
            cm.canOpenDoors = false
            /*
             * 🔴 绕障清单【也必须补给它这一份】—— 这才是浆果丛修复失败的真因。
             *
             * 昨晚我只给自己那份 moves 加了 blocksToAvoid,实测无效:
             * 修复上线后仍被扎死 4 次(服务器权威,JST 06:06 / 07:18 / 08:18 / 11:07)。
             * 原因在 collectblock 源码:CollectBlock.js:153 在【构造时】自建一份 Movements,
             * 每次采集都 `setMovements(this.movements)` 把我的那份顶掉(源码 192~195 行)。
             * 而它一天里主要就在砍树 —— 等于绝大部分时间寻路根本不认识浆果丛。
             * 好消息是那份是构造一次、之后复用,所以在这里补一次就长期有效。
             * ⚠️ 只补"绕开"、不碰挖掘能力,否则它连目标树都挖不了。
             */
            let added = 0
            for (const n of AVOID_BLOCKS) {
              const b = mcData.blocksByName[n]
              if (b && cm.blocksToAvoid && !cm.blocksToAvoid.has(b.id)) { cm.blocksToAvoid.add(b.id); added++ }
            }
            log(`已同时禁掉 collectBlock 自带寻路的搭塔与脚手架,并给它补了 ${added} 种绕开的方块(浆果丛等)`)
          } else {
            log('⚠️ 拿不到 collectBlock.movements,砍树时仍可能搭塔')
          }
        } catch (e) { log('配置 collectBlock 寻路失败:', e.message) }
        /*
         * 🔴 mineflayer-pvp 也自带一份 Movements,而且【全是默认值】。
         *    这是第三份,也是唯一一份我从来没配过的 —— 2026-09-17 凌晨按 Owner 的要求
         *    去查社区资料时,从源码里查出来的。
         *
         * 源码实据(node_modules/mineflayer-pvp/lib/PVP.js,我们实际装的 1.3.2):
         *   :50  this.movements = new Movements(bot, require('minecraft-data')(bot.version))
         *   :70  if (this.movements) pathfinder.setMovements(this.movements)   ← 每次 attack() 都装上
         *   打完架【不还原】。
         * 而 pathfinder 2.4.5 的默认值(lib/movements.js)是:
         *   :23 canDig = true      :31 allow1by1towers = true
         *   :76 scafoldingBlocks = [dirt, cobblestone]
         *   :49 blocksToAvoid 只有 fire / cobweb / lava —— 【没有浆果丛】
         *
         * 🔑 这解开了上面(原第 3897 行附近)那个我一直没解开的谜:
         *    「我明明已经禁掉搭塔、清空脚手架清单了,它仍然在 09-16 01:08 放下圆石,
         *      而且 x=49,50,51,52 同一高度连成一排」。
         *    我当时归因成"横向搭桥和垂直搭塔是两回事"。**真相是:**
         *    【打完一架之后,生效的是 pvp 这份带泥土+圆石脚手架的默认配置】——
         *    横向搭桥用的也是 scafoldingBlocks,而我清空过的那一份当时已经被顶掉了。
         *    同理,打完架之后浆果丛绕行清单也是空的 —— 这可能是"浆果丛修复后仍被扎死"的第二个源头。
         *
         * 🔑 修法选的是【把三份都配安全】,不是"事后还原":
         *    还原方案要和 pvp/collectblock 赛跑(它们在 attack()/collect() 的第一时间就 setMovements),
         *    而"谁生效都安全"没有竞态。这和"放方块总闸设在唯一出口"是同一个思路。
         */
        try {
          const pm = bot.pvp && bot.pvp.movements
          if (pm) {
            pm.canDig = false
            pm.allow1by1towers = false
            pm.scafoldingBlocks = []
            pm.canOpenDoors = false
            pm.liquidCost = 20
            let addedP = 0
            for (const n of AVOID_BLOCKS) {
              const b = mcData.blocksByName[n]
              if (b && pm.blocksToAvoid && !pm.blocksToAvoid.has(b.id)) { pm.blocksToAvoid.add(b.id); addedP++ }
            }
            log(`已禁掉 pvp 自带寻路的挖路/搭塔/脚手架/开门,并给它补了 ${addedP} 种绕开的方块`
              + ` —— 这是第三份 Movements,在此之前它一直是默认值(能挖、能搭、不认浆果丛)`)
          } else {
            log('⚠️ 拿不到 bot.pvp.movements,打完架之后寻路仍可能挖路搭塔')
          }
        } catch (e) { log('配置 pvp 寻路失败:', e.message) }
        /*
         * 🔬 NaN 位置探针 —— 只记录,不改行为。
         *
         * 依据 mineflayer 4.39.0 的 lib/plugins/physics.js:81 / 105 / 129 / 162,
         * 四处都有 `if (!Number.isFinite(bot.entity.position.x)) return`。
         * 一旦位置变成 NaN,physics 就【永久 early-return】:走不动、拿不到吃的、
         * pathfinder 全部超时返回 —— 这正是"站着饿死"和"explore 只挪几格"的形态。
         * 上游 open issue #3882(环境 Paper 1.21.4,和我们一模一样)的原话大意是:
         * 被打一下之后机器人冻住,直到被打死或者重连才恢复。修复 PR #3883 至今未合并,
         * 4.39.0 里这个 bug 还在。
         *
         * ⚠️ 社区那个"记住上一个合法位置再写回去"的 workaround 今晚【坚决不上】——
         *    报告人自己说"能用,但它把所有击退效果都吃掉了",那是改战斗手感,不是诊断。
         *    先只量:如果一晚一次都不触发,这条就彻底划掉;如果反复触发,
         *    那"动作转化率低"的所有结论都要重估。
         */
        try {
          let nanHits = 0
          let lastNanLog = 0
          bot.on('physicsTick', () => {
            const p = bot.entity && bot.entity.position
            if (!p) return
            if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return
            nanHits++
            if (Date.now() - lastNanLog < 10000) return   // 节流,别刷爆日志
            lastNanLog = Date.now()
            let v = '?'
            try { v = JSON.stringify(bot.entity.velocity) } catch (e2) { /* 取不到就算了 */ }
            log(`🧊 位置变成 NaN 了(累计 ${nanHits} 次)—— physics 会永久停摆,它从此走不动也吃不上饭。速度=${v}`)
          })
          log('🔬 已挂上 NaN 位置探针(只记录,不改行为)')
        } catch (e) { log('挂 NaN 探针失败:', e.message) }
        ready = true
        log(`寻路就绪。大目标=${CFG.goalText},现有木头 ${woodCount()} 块,经验记忆 ${memory.count()} 条`)
        // 保命反射:每秒一次,不经过大脑(大脑 25 秒才想一次,来不及)
        if (reflexTimer) clearInterval(reflexTimer)
        reflexTimer = setInterval(reflexTick, 1000)
        if (CFG.brainEnabled) {
          /*
           * 大脑不再靠定时器叫醒,改成【连续循环】:想完一轮立刻接着想。
           * Owner:「GPU 应该是连续不断地在思考和执行才对」。
           * 实测旧版:38 次决策 / 357 秒,平均 9.6 秒一次、每次思考约 2.2 秒
           * → 显卡只忙了约 23%,四分之三时间在干等定时器。
           * ⚠️ 必须只启动一次:掉线重连会再走一遍这里,每次都开一个 for(;;)
           *    会让循环叠加、对显卡的调用成倍增长,而且没有句柄能关掉它们。
           * (CFG.brainEverySec 从此不再用于节流,保留只为兼容旧配置。)
           */
          log(`大脑已接入: ${CFG.brain.model} @ ${CFG.brain.url}`)
          if (brainTimer) { clearInterval(brainTimer); brainTimer = null }
          if (!brainLoopStarted) {
            brainLoopStarted = true
            brainLoop()
            log('大脑改为【连续思考】:想完立刻接着想,不再等固定间隔')
          }
          // 规划师另起一路,跑在 M1 上 —— 同样只启动一次(重连会再走到这里)
          if (!planLoopStarted) {
            planLoopStarted = true
            planLoop()
            log(`规划师已接入: ${CFG.planner.model} @ ${CFG.planner.url}(自己定阶段目标)`)
          }
          // 身体的快循环:大脑一想好就立刻开做,并负责在处境变了时打断手上的动作
          if (actTimer) clearInterval(actTimer)
          actTimer = setInterval(actTick, 300)
        } else {
          log('大脑未启用(BRAIN_ENABLED=0),只听玩家指挥')
        }
      } catch (e) {
        log('寻路初始化失败:', e.message)
      }
    }, 6000)
  })

  bot.on('chat', handleChat)

  /*
   * 把服务器回给它的【关键系统消息】打进日志。
   * 为什么需要:验证 /sethome 能不能用时,我绕了三轮间接路子都不确定 ——
   *   · `lp permission check` / `co lookup` 的输出走 RCON 捞不到(返回空 ≠ 否定)
   *   · Essentials 玩家数据延迟落盘,刚设完去读文件读到的是旧的
   *   · 机器人一直在动,坐标变化也证明不了传送成功
   * 而服务器直接回它的那句话("Home set" / "You don't have permission")是毫不含糊的。
   * ⚠️ 只记命中关键词的消息,绝不全量记 —— 今天已经被 15MB 日志刷屏坑过一次。
   */
  const NOTE_RE = /home|permission|权限|没有权限|cooldown|Essentials|spawn/i
  bot.on('message', (msg) => {
    try {
      const t = String(msg).replace(/\s+/g, ' ').trim()
      if (!t) return
      /*
       * 🔴 认出「这是别人的地」。服务器原话(实测抓到的):
       *   You don't have <PLAYER>'s permission to build here.
       * 7 秒里连刷 15 条 —— 它在别人领地里反复砍同一棵树,一块也挖不掉,
       * 纯粹白费时间还要站在那儿挨怪打。
       * ⚠️ 这条消息是【服务器说的事实】,不是我猜的原因 —— 正好可以如实喂给大脑当教训。
       */
      if (/permission to build here|permission to (?:break|place)|你没有.*权限|这块地/i.test(t)) {
        const now = Date.now()
        claimDenyPos = bot.entity ? bot.entity.position.clone() : null
        if (now - lastClaimDenyAt > 4000) {   // 同一波会连刷十几条,别把日志刷满
          lastClaimDenyAt = now
          log(`🚫 这儿是别人的地(服务器原话:${t.slice(0, 60)})—— 记下位置,不在这儿动手`)
          lastOutcome = `失败:这里是别人的领地,服务器不让我动(${t.slice(0, 40)})—— 换个没人圈地的地方`
        }
        try { bot.stopDigging() } catch (e) { /* 没在挖就会抛,忽略 */ }
        return
      }
      /*
       * 🔴 抓住服务器自己广播的死亡消息(showDeathMessages 已确认为 true)。
       * 这是唯一不会骗人的判据 —— 见 DEATH_MSG_RE 处那段实测记录。
       * ⚠️ 排除以 '<' 开头的玩家聊天:那种是「<XiaoMai> ...」,里面也含用户名,
       *    真正的死亡消息是系统广播,不带尖括号。
       */
      if (!t.startsWith('<') && t.includes(bot.username) && DEATH_MSG_RE.test(t)) {
        lastDeathMsgAt = Date.now()
        log(`[服务器判定死亡] ${t.slice(0, 90)}`)
      }
      if (NOTE_RE.test(t) && t.length < 160) log(`[服务器] ${t}`)
    } catch (e) { /* 记日志失败不能影响机器人 */ }
  })
  bot.on('path_update', (r) => {
    if (r.status === 'noPath' && following) log(`暂时找不到通往 ${following} 的路`)
  })

  // 死亡是最有价值的失败记录:记下死在哪、旁边有什么,下次它就知道那地方危险
  bot.on('death', () => {
    /*
     * 🔴 先【同步】把"接着干"的两个槽位清空,不进 setTimeout、不受死亡核实判据约束。
     * 审查意见(HIGH):原来这两行挂在"确认是真死亡"的分支里、还延后 1.5 秒,
     * 而 actTick 每 300 毫秒跑一次 —— 那 1.5 秒里它早就把死前那个活捡回去了,
     * 可人已经在重生点,坐标完全不同(甚至可能在别人的领地里动手)。
     * 清空是无害操作:误清一次只是少接一次活;漏清一次是在错误的地方干活。
     */
    resumeAction = null
    queuedNext = null
    interruptedFor = ''
    resumeTries = 0
    /*
     * 🔴 这个事件【会误报】,必须先核实再记账 —— 见 DEATH_MSG_RE 处那段实测记录。
     * 整夜 67 次「我死了」里只有 13 次是真的,其余多半是 /home 传送触发的重生包。
     *
     * 两条【互相独立】的判据,任一成立就算真死:
     *   ① 服务器刚广播过我的死亡消息(权威,showDeathMessages=true 已确认);
     *   ② 血量和饱食度都回到了满值 —— 真死亡重生后必然是 20/20,
     *      而误报时会保留传送前的数值(实测 16.67 / 14.5 / 19.33)。
     * ⚠️ 要等一下再判:重生包和血量同步不是同一帧到的,立刻读会读到旧值。
     * ⚠️ 位置必须在【事件当下】就抓住并 clone:等 1.5 秒后它可能已经跑开了,
     *    那样记进地图的就是错的坐标。
     */
    const p = bot.entity && bot.entity.position ? bot.entity.position.clone() : null
    const d = nearestHostile()
    // 一定要记 Y:第一次死亡循环时我只记了 x,z,结果看不出它是摔下去还是掉进虚空
    const where = p ? `(${Math.round(p.x)}, y=${Math.round(p.y)}, ${Math.round(p.z)})` : '不知道哪'
    const killer = d ? d.name : '不确定(也可能是摔死或掉进岩浆)'
    setTimeout(() => {
      try {
        /*
         * 🔴 从「任一成立」收紧成【两条都要成立】—— 这是第二轮实测逼出来的。
         *
         * 第一版用 OR(服务器广播过 或 满血满饱食),结果两条判据【各自】都放进了误报:
         *   · 19:06:09 收到「XiaoMai was shot by Skeleton」,当时血量 4.5;
         *   · 19:06:29 又收到一模一样的一条,当时血量 5。
         *   而服务器 latest.log 全量搜索 `was shot by Skeleton` 只有 4 条
         *   (00:07:12 / 00:28:09 / 01:05:46 / 01:10:28),04:06 那两条【根本不存在】。
         *   也就是说聊天里飘来过服务器日志里没有的死亡广播(插件回显或包重放,没继续深究)。
         * 真死亡【必然同时满足】两条:服务器广播过,且重生后血量和饱食度都回满 20。
         * 幻影广播满足不了第二条,/home 传送的重生包满足不了第一条 —— AND 把两类误报一起挡住。
         *
         * ⚠️ 代价:万一服务器广播丢了,真死亡会被漏记一次。
         *    这个方向的错误是可接受的 —— 漏记只是少一条日志,
         *    误记却会把假死亡点写进地图记忆和「过去的教训」,一路喂回给模型(已经污染过一次)。
         */
        /*
         * 🔴🔴 2026-09-17 06:4x 第三轮更正:把"满血满饱食"这一条【去掉】,只认服务器广播。
         *
         * 上面那段(收紧成 AND)的依据是「服务器 latest.log 里根本没有那两条广播」。
         * **那个依据是错的** —— 我后来发现 `latest.js`… 准确说是 `logs/latest.log`
         * 【漏记死亡约 5~10 倍】(控制台并不把每条死亡消息都写下来)。
         * 所以当时判定的"幻影广播"很可能是【真死亡】,AND 是建在错前提上的。
         *
         * 这一轮的证据强得多 —— 同一个 34.7 分钟窗口三方对账:
         *   服务器玩家统计(world/stats/<uuid>.json 的 minecraft:deaths)= **194**
         *   机器人收到的死亡广播 [服务器判定死亡]                      = **194**   ← 精确相等
         *   机器人真记账 ☠️我死了                                      = **4**
         *   被当成误报丢掉                                             = **189**
         * 也就是说:**广播是准的(1:1),坏的是我这道过滤,它把 97% 的真实死亡扔了。**
         * 原因很直白:keepInventory 下瞬间重生,1.5 秒后读到的血量常是 16.33 而不是 20
         *   (刚重生就被怪继续打),于是"满血满饱食"永远不成立。
         *
         * 🔴 去重窗口也从 30 秒压到 2 秒:夜里它每 10 秒就死一次,
         *    30 秒的窗口本身就会吞掉三分之二的真实死亡。
         *    2 秒只够挡住"同一条广播被重放"这种真重复。
         *
         * ⚠️ 留一个自检:如果以后广播数和统计文件又对不上,说明幻影广播是真的存在,
         *    那时再加判据 —— 但【不要再用"满血满饱食"】,那一条已被证明会否掉真死亡。
         */
        const byServer = Date.now() - lastDeathMsgAt < 8000
        const hp = bot && bot.health !== undefined ? bot.health : -1
        const fd = bot && bot.food !== undefined ? bot.food : -1
        if (!byServer) {
          log(`↩️ 忽略一次没有服务器广播的死亡事件(血${hp} 食${fd})—— 多半是 /home 传送下发的重生包`)
          return
        }
        if (Date.now() - lastAcceptedDeathAt < 2000) {
          log(`↩️ 忽略一次疑似重复的死亡(距上一次只隔 ${Date.now() - lastAcceptedDeathAt} 毫秒,同一条广播被重放)`)
          return
        }
        lastAcceptedDeathAt = Date.now()
        /*
         * 🔴 这次死亡是不是"刚传送回家就死"?连续两次就把家标记成暂时不安全。
         * 20 秒的窗口:传送落地 + 僵尸走两步打死它,实测就是 6~10 秒一轮。
         */
        // 刚死过 12 秒内:旁边有怪就无条件先跑(见 justDiedUntil 的声明处)
        justDiedUntil = Date.now() + 12000
        if (Date.now() - lastHomeTpAt < 20000) {
          homeDeathStreak++
          if (homeDeathStreak >= 2 && Date.now() >= homeUnsafeUntil) {
            homeUnsafeUntil = Date.now() + 300000
            log(`🏚️ 连着 ${homeDeathStreak} 次【一回家就死】—— 家那边多半蹲着怪,`
              + `接下来 5 分钟不回家,逃命改去出生点(这是为了打断死亡循环,不是永久放弃这个家)`)
          }
        } else {
          homeDeathStreak = 0
        }
        /*
         * 记下死亡地点,但**只作为事实**,不贴"危险"标签。
         * Owner:「死过的地方也不一定要绕开」—— 死在某处常常只是"当时天黑刚好刷了怪",
         * 那片林子白天可能很好用。去不去,让模型自己权衡。
         */
        try { if (p) places.remember('death', p) } catch (e) { /* 记地图失败不能影响重生流程 */ }
        const reason = `我死了:在 ${where},旁边有 ${killer}`
        log(`☠️ ${reason}(服务器已广播;血${hp} 食${fd})`)
        lastAction = 'died'
        lastOutcome = '失败:' + reason
        memory.record({ action: 'died', ok: false, reason, pos: p ? [Math.round(p.x), Math.round(p.z)] : null })
        memory.save()
      } catch (e) { log('死亡判定出错:', e.message) }
    }, 1500)
  })

  bot.on('kicked', (reason) => log('被踢:', typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 200)))
  bot.on('error', (err) => log('错误:', err.message))
  bot.on('end', (reason) => {
    log('连接断开:', reason)
    stopFollow(true)
    if (brainTimer) { clearInterval(brainTimer); brainTimer = null }
    if (actTimer) { clearInterval(actTimer); actTimer = null }
    pendingAction = null
    acting = false
    // 断线期间攒下的"接着干"也要清掉 —— 重连后世界已经不是断线前那个样子了
    queuedNext = null
    resumeAction = null
    actingAction = null
    actingName = ''
    interruptedFor = ''
    resumeTries = 0
    // 反射定时器也必须停:不停的话每次重连都叠一个,一堆定时器对着已经死掉的 bot 乱按
    if (reflexTimer) { clearInterval(reflexTimer); reflexTimer = null }
    reflexSwim = false
    memory.save()
    bot = null
    setTimeout(createBot, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 60000)
  })
}

process.on('uncaughtException', (e) => log('未捕获异常(继续跑):', e && e.message))
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝:', e && e.message))
process.on('SIGTERM', () => { memory.save(); process.exit(0) })

if (!CFG.password) {
  log('❌ 没有设置 MC_PW(nLogin 密码),无法登录。检查 /etc/mcbot.env')
  process.exit(1)
}
loadHome()     // 先读存档里的家,免得每次重启都重新安家
loadHouse()    // 房子盖到一半重启也能接着盖
forgetChestIfFarFromHome('启动时对账')   // 家和箱子对不上就先忘掉旧箱子,否则会卡死(见函数注释)
createBot()
