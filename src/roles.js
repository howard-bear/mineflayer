/*
 * 麦家的角色档案 —— 一份代码跑三个角色。
 *
 * 为什么不复制成三份代码目录:那四条护栏(不砍别人用原木盖的房子 / 只在家附近放方块 /
 * 放方块总闸 / 不碰别人的箱子)是一年踩坑换来的。复制成三份就会分三份地腐烂,
 * 修一次要改三处,漏一处就是在有孩子的服上出事。
 *
 * 分工:
 *   · 启动时固定:登录名、密码、能做的动作、大目标 —— 这些是"身份",中途变了会乱;
 *   · 【热加载】:人格文字 —— Owner 调性格时应该是"改一行看一眼",不是"改一行等一次部署"。
 */
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, 'roles.json')
let cache = null
let cacheMtime = 0

function readAll() {
  /*
   * ⚠️ 读失败时【绝不静默回退】—— 这个文件决定一个角色能做什么,
   * 读不到就应该让调用方当场炸掉,而不是拿一份默认值悄悄跑起来
   * (一个 ROLE 写错就静默丢掉全部护栏,是这套系统最危险的失败方式)。
   */
  const st = fs.statSync(FILE)
  if (cache && st.mtimeMs === cacheMtime) return cache
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  cache = raw
  cacheMtime = st.mtimeMs
  return cache
}

/** 有哪些角色(给报错信息用) */
function names() {
  return Object.keys(readAll()).filter((k) => !String(k).startsWith('_'))
}

/**
 * 取一个角色的完整档案。认不出就抛 —— 让调用方退出,不许有默认值。
 */
function load(roleKey) {
  const all = readAll()
  const key = String(roleKey || '').trim()
  if (!key) throw new Error(`没有指定 ROLE。可选:${names().join(' / ')}`)
  const r = all[key]
  if (!r || typeof r !== 'object') {
    throw new Error(`认不出角色「${key}」。roles.json 里只有:${names().join(' / ')}`)
  }
  const acts = Array.isArray(r['能做的动作']) ? r['能做的动作'].slice() : []
  if (!acts.length) throw new Error(`角色「${key}」的"能做的动作"是空的,这样它什么都做不了`)
  const login = String(r['登录名'] || '').trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(login)) {
    throw new Error(`角色「${key}」的登录名「${login}」不合法(必须 3~16 位纯 ASCII 字母数字下划线)`)
  }
  return {
    key,
    login,
    cnName: String(r['中文名'] || login),
    relation: String(r['关系'] || ''),
    actions: acts,
    goalText: String(r['大目标'] || ''),
  }
}

/**
 * 取人格文字 —— 每次调用都看一眼文件改没改,所以是热加载的。
 * 读失败时返回上一次的内容并把原因交给调用方记日志(人格读不到不该让机器人停摆,
 * 但也绝不能静默 —— 这两者的区别今天付过学费)。
 */
function persona(roleKey) {
  try {
    const r = readAll()[String(roleKey)]
    return { text: String((r && r['人格']) || ''), err: null }
  } catch (e) {
    return { text: String((cache && cache[roleKey] && cache[roleKey]['人格']) || ''), err: e.message }
  }
}

module.exports = { load, persona, names, FILE }
