// docs/19 里那张「举闩之后下一个 goto 会怎样」的实测脚本。
//
// 跑法(在任意空目录):
//   npm i mineflayer-pathfinder@2.4.5 minecraft-data vec3
//   node latch.mjs
//
// 它把 mineflayer-pathfinder 的真身 inject() 装到一个桩 bot 上 —— 不跑 physicsTick,
// 所以 goto 永远不会 resolve。要证的只是:举起 stopPathing 这个闩之后,
// 下一个 goto 会不会在第一时间就被 reject 成 PathStopped(一步没走)。
import { EventEmitter } from 'events'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const { pathfinder: inject } = require('mineflayer-pathfinder')
const Movements = require('mineflayer-pathfinder/lib/movements.js')
const gotoUtil = require('mineflayer-pathfinder/lib/goto.js')

function makeBot () {
  const bot = new EventEmitter()
  bot.registry = mcData
  bot.version = '1.21.4'
  bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, isInWater: false, height: 1.8 }
  bot.inventory = { items: () => [], slots: [] }
  bot.world = { getBlock: () => null, getBlockStateId: () => 0 }
  bot.game = { gameMode: 'survival' }
  bot.physicsEnabled = true
  bot.setControlState = () => {}
  bot.clearControlStates = () => {}
  bot.stopDigging = () => {}
  bot.look = async () => {}
  return bot
}

class AlwaysFar { // 永远到不了的目标,goto 不会自己 resolve
  heuristic () { return 100 }
  isEnd () { return false }
  hasChanged () { return false }
}

function race (p, ms) {
  return Promise.race([
    p.then(() => 'RESOLVED').catch(e => 'REJECT:' + e.name),
    new Promise(r => setTimeout(() => r('进入寻路,没被拒'), ms))
  ])
}

async function scenario (name, prep) {
  const bot = makeBot()
  inject(bot)
  bot.pathfinder.setMovements(new Movements(bot))
  let stops = 0
  bot.on('path_stop', () => stops++)

  bot.pathfinder.stop()          // ← 举闩(cancelTask 第一句干的事)
  const stopsAfterLatch = stops
  prep(bot)                      // ← 各方案的「清场」动作
  const consumed = stops > stopsAfterLatch
  const r = await race(gotoUtil(bot, new AlwaysFar()), 120)
  console.log(
    name.padEnd(34),
    '| 清场时吃掉闩:', (consumed ? '是' : '否').padEnd(2),
    '| 随后的 goto:', r
  )
}

console.log('pathfinder 2.4.5 · 举闩后下一个 goto 会怎样\n')
await scenario('① 什么都不做', () => {})
await scenario('② setGoal(null)  (我提的修法)', b => b.pathfinder.setGoal(null))
await scenario('③ setMovements(...) (他们用的)', b => b.pathfinder.setMovements(new Movements(b)))
console.log('\n对照:没举过闩的 goto')
{
  const bot = makeBot(); inject(bot); bot.pathfinder.setMovements(new Movements(bot))
  console.log('④ 从未 stop()'.padEnd(34), '|', ' '.repeat(17), '| 随后的 goto:', await race(gotoUtil(bot, new AlwaysFar()), 120))
}
