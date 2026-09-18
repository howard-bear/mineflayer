#!/bin/bash
# 「模型失败记账 + 主脑降级」的桩测试 —— 见 docs/27「第一刀『失败记账』:上线后我怎么核的」
#
# 做法:把线上 bot.real.js 里那段记账代码【原样】抽出来(从 `const MODEL_KINDS =` 到
# `function modelStatLine` 之前),前面补上它依赖的几个变量和 log/short,
# 用可控的假时钟喂 9 种情况,看「该切备用 / 不该切」对不对。
#
# 只能在跑机器人的那台服务器上跑(它读的是线上文件,不是仓库里的副本 —— 要验的就是线上那一份)。
# 用法:bash model-note-harness.sh [bot.real.js 的路径,默认 ~/mcbot/bot.real.js]
set -e
SRC=${1:-$HOME/mcbot/bot.real.js}
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"
awk '/^const MODEL_KINDS = /{p=1} /^function modelStatLine/{p=0} p' "$SRC" > body.js
echo "抽出 $(wc -l < body.js) 行(md5 $(md5sum "$SRC" | cut -c1-8))"
[ -s body.js ] || { echo "没抽到 —— 线上代码变了,先看锚点还在不在"; exit 1; }
cat > h.js <<'JS'
let NOW = 1e12; Date.now = () => NOW
const logs = []; const log = (...a) => logs.push(a.join(' ')); const short = (s) => String(s)
let brainFailStreak = 0, brainJunkStreak = 0, lastBrainJunkAt = 0, brainDownUntil = 0, usingBackupBrain = false
const CFG = { brain: { model: 'P' }, backup: { model: 'B' } }
JS
cat body.js >> h.js
cat >> h.js <<'JS'
function reset(){ brainFailStreak=0; brainJunkStreak=0; brainDownUntil=0; usingBackupBrain=false; lastBrainFailAt=0; logs.length=0 }
const T='大脑没反应: timeout', J='回答里找不到 JSON'
const out = []
// steps: [距上一步的毫秒, 调用种类, 成没成, 失败原因, 发出去时是不是备用入口]
function c(name, steps, expectDown){ reset(); for (const [dt,kind,ok,why,bk] of steps){ NOW+=dt; modelNote(kind,1000,ok,why,null,bk) }
  const down = brainDownUntil > NOW; out.push(`${down===expectDown?'PASS':'FAIL'}  ${name}: 切备用=${down}`) }
c('单步决策连着 2 次没反应,隔 30 秒',            [[0,'decide',false,T],[30e3,'decide',false,T]], true)
c('挑小目标没反应,60 秒后单步决策也没反应',     [[0,'pick',false,'挑小目标时模型没反应: x'],[60e3,'decide',false,T]], true)
c('2 次没反应,但隔了 6 分钟',                   [[0,'decide',false,T],[360e3,'decide',false,T]], false)
c('没反应 → 成功 → 没反应',                      [[0,'decide',false,T],[10e3,'decide',true,null],[10e3,'decide',false,T]], false)
c('没反应 → 答不对 → 没反应',                    [[0,'decide',false,T],[10e3,'decide',false,J],[10e3,'decide',false,T]], false)
c('备用入口自己连着 2 次没反应(不算主脑)',       [[0,'decide',false,T,true],[10e3,'decide',false,T,true]], false)
c('主脑没反应 → 备用成功 → 主脑没反应',          [[0,'decide',false,T],[10e3,'decide',true,null,true],[10e3,'decide',false,T]], true)
c('聊天 / 设计房子失败 3 次(只计数)',            [[0,'chat',false,'x'],[5e3,'design',false,'x'],[5e3,'chat',false,'x']], false)
reset(); for (let i=0;i<5;i++){ NOW+=37e3; modelNote('decide',7000,false,'动作「gather_wood」现在做不到') }
out.push(`${logs.some(l=>l.startsWith('🤪'))?'PASS':'FAIL'}  答不对 5 次(每 37 秒一次)→ 出 🤪 告警`)
console.log(out.join('\n'))
process.exit(out.some(l=>l.startsWith('FAIL')) ? 1 : 0)
JS
node h.js
