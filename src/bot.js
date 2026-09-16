// 入口壳子(systemd 跑的就是这个文件)。三种模式,靠有没有对应的标记文件切换:
//   STOP.on  → 安全模式:根本不连服务器,碰不到任何方块
//   PROBE.on → 探测模式:跑 probe.js 量保护区,量完自己退出
//   都没有   → 正常模式:跑 bot.real.js(AI 玩家)
const fs = require("fs"), path = require("path")
const has = (f) => fs.existsSync(path.join(__dirname, f))
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19)

if (has("STOP.on")) {
  console.log(stamp() + " [STOP] 安全模式:不连服务器、不动任何方块")
  setInterval(() => {}, 1 << 30)   // 挂着不退出,systemd 才不会每 10 秒反复重启
} else if (has("PROBE.on")) {
  console.log(stamp() + " [PROBE] 探测模式:开始量保护区")
  require("./probe.js")
} else {
  require("./bot.real.js")
}
