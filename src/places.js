'use strict'
/*
 * XiaoMai 的「地图记忆」
 *
 * Owner 的原话:「得让他脑子里有地图啊,不能限制他的活动范围啊」—— 这话点中了要害。
 *
 * 【为什么需要】
 * 它此刻的全部世界观只有两样:周围 24~32 格里有什么、八个方向 20 格外是水是地。
 * 它【不记得任何地方】—— 不记得东边那片林子能砍、猪在哪儿、上次死在哪儿。
 * 于是每一轮都从零摸索,而我只能用"半径 64""离家 24 格内才能建"这类硬边界兜底。
 * **边界越加越多,它就越像被关在笼子里。**
 * 正确的解法不是放宽半径,而是让它【有理由、有方向地走远】—— 这就需要一份会积累的地图。
 *
 * 【设计要点】
 * 1. 按 8 格网格去重:同一片林子不会被记成几十个点,否则地图会爆炸。
 * 2. 会过期:世界会变(树被砍光、动物跑掉),旧记忆自动淡出。
 * 3. 喂给模型的必须【极短】—— 小模型吃不下长列表(memory.js 已经验证过这条)。
 *    所以只给最近的几条,并且换算成"方向+距离"这种它能直接用的说法。
 */
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, 'places.json')
const GRID = 8                       // 去重网格:8 格内算同一个地方
const MAX = 400                      // 最多记这么多,防止常驻进程内存长胖
const TTL = {                        // 各类记忆的保鲜期(毫秒)
  tree: 30 * 60 * 1000,              // 林子会被砍光,半小时后就不一定还有
  /*
   * 🔴 20 分钟 → 6 小时。
   * 原注释写"动物会走" —— 单个动物会走,但【哪片草地有动物】这个地方是稳定的:
   * MC 的动物是世界生成时成群刷出来的,基本不远离出生点。
   * 20 分钟的代价是实测出来的(2026-09-16 UTC 03:55~04:15):
   *   那 20 分钟里饿死 2 次,`附近 64 格内没有动物` 出现 10 次,
   *   强制打猎规则正确触发 9 次、大脑另外选了 13 次 hunt —— 全都停在"找不到"上。
   *   而 places.json 当时 16 条记忆里 tree 11 条、death 5 条、**animal 0 条**。
   * 死结在于:animal 记忆【只有成功打到猎物时才会写】,而它正是打不到,
   * 所以记忆一过期就再也回不来 —— 和 failStreak 没有衰减那次是同一种自锁。
   * 水源是 6 小时,动物栖息地至少一样稳定,所以给同样的保鲜期。
   */
  animal: 6 * 60 * 60 * 1000,
  death: 60 * 60 * 1000,             // 危险地点记久一点
  water: 6 * 60 * 60 * 1000,         // 水源基本不动
  claim: 60 * 60 * 1000,             // 别人的领地
  home: Number.MAX_SAFE_INTEGER,     // 家不过期
}
/*
 * ⚠️ 标签要【中性】,不要替模型下判断。
 * Owner:「死过的地方也不一定要绕开」—— 说得对。死在某处往往只说明"当时天黑刚好刷了怪",
 * 那片林子白天可能很好用。我原本写成"死过人(危险)",等于把结论塞给它、逼它绕路。
 * 现在只陈述事实,去不去由它自己权衡。
 */
const LABEL = {
  tree: '能砍的林子', animal: '有动物', death: '以前在这儿死过',
  water: '水源', claim: '别人的领地', home: '家',
}

let places = []
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  if (Array.isArray(raw)) places = raw
} catch (e) { places = [] }          // 第一次跑没这个文件,正常

let dirty = false
function save() {
  if (!dirty) return
  try { fs.writeFileSync(FILE, JSON.stringify(places.slice(-MAX))); dirty = false } catch (e) { /* 存盘失败不能拖垮机器人 */ }
}
const timer = setInterval(save, 15000)
if (timer.unref) timer.unref()

const key = (kind, x, z) => `${kind}@${Math.round(x / GRID)},${Math.round(z / GRID)}`

/** 记一个地方。同一网格内重复记只会刷新时间,不会堆成一堆点。 */
function remember(kind, pos, note) {
  if (!pos || typeof pos.x !== 'number') return
  if (!LABEL[kind]) return
  const k = key(kind, pos.x, pos.z)
  const now = Date.now()
  const old = places.find((p) => p.k === k)
  if (old) { old.t = now; if (note) old.n = String(note).slice(0, 24); dirty = true; return }
  places.push({ k, kind, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), t: now, n: note ? String(note).slice(0, 24) : '' })
  if (places.length > MAX) places = places.slice(-MAX)
  dirty = true
}

function fresh(p) {
  const ttl = TTL[p.kind] || 30 * 60 * 1000
  return Date.now() - p.t <= ttl
}

/** 清掉过期的。顺手在查询时调用,不需要单独的定时器。 */
function prune() {
  const before = places.length
  places = places.filter(fresh)
  if (places.length !== before) dirty = true
}

const DIRS = [
  ['东', 1, 0], ['东南', 0.7, 0.7], ['南', 0, 1], ['西南', -0.7, 0.7],
  ['西', -1, 0], ['西北', -0.7, -0.7], ['北', 0, -1], ['东北', 0.7, -0.7],
]
/** 把坐标差换算成它听得懂的方向词(和 explore 的方向词表一致)。 */
function dirOf(from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const len = Math.hypot(dx, dz) || 1
  let best = DIRS[0]
  let bestDot = -Infinity
  for (const d of DIRS) {
    const dot = (dx / len) * d[1] + (dz / len) * d[2]
    if (dot > bestDot) { bestDot = dot; best = d }
  }
  return best[0]
}

/** 找某一类里离当前位置最近的一个地方(给 goto_place 用)。 */
function nearest(kind, from) {
  prune()
  let best = null
  let bestD = Infinity
  for (const p of places) {
    if (p.kind !== kind) continue
    const d = Math.hypot(p.x - from.x, p.z - from.z)
    if (d < bestD) { bestD = d; best = p }
  }
  return best ? { ...best, dist: Math.round(bestD) } : null
}

/**
 * 给模型看的地图 —— 【必须很短】。
 * 每类只给最近的一个,换算成"方向 + 距离",这是它能直接拿去 explore/goto_place 的说法。
 */
function forModel(from, kinds) {
  prune()
  if (!from || typeof from.x !== 'number') return undefined
  const want = kinds || ['tree', 'animal', 'water', 'home', 'death']
  const out = {}
  for (const kind of want) {
    const p = nearest(kind, from)
    if (!p) continue
    if (p.dist < 6) continue                       // 就在脚下,没必要说
    out[LABEL[kind]] = `${dirOf(from, p)}边约 ${p.dist} 格${p.n ? `(${p.n})` : ''}`
  }
  return Object.keys(out).length ? out : undefined
}

function count() { prune(); return places.length }

module.exports = { remember, nearest, forModel, dirOf, save, count }
