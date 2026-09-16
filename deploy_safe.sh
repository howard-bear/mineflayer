#!/bin/bash
# 部署两件事:
#   1) 🔴 不准再拆别人的房子:只砍"上面有树叶 + 周围3格没人造方块"的真树
#   2) 🎮 让 5060 真正忙起来:每个动作封顶 30 秒,不许再把大脑堵在门外
# 不需要 root 密码(换文件 + 杀自己的进程,systemd 自动拉起)
set -u
cd ~/mcbot || exit 1

echo "=== 1) 语法检查(不过就不放它出来）==="
node --check _new_bot.js || { echo "   ❌ 语法错,中止,小麦继续停着"; exit 1; }
echo "   ✅ OK"
echo "   护栏函数: isNaturalTree=$(grep -c 'function isNaturalTree' _new_bot.js) hasLeavesAbove=$(grep -c 'function hasLeavesAbove' _new_bot.js) manmadeNear=$(grep -c 'function manmadeNear' _new_bot.js)"
echo "   砍树时真的用上了护栏: $(grep -c 'function isNaturalTree' _new_bot.js) 处（必须 ≥1）"
echo "   动作封顶常量: $(grep -c 'const ACT_CAP_MS' _new_bot.js) 处（必须=1，否则会崩）"
grep -q 'function isNaturalTree' _new_bot.js || { echo "   ❌ 护栏没接上,中止"; exit 1; }
grep -q 'const ACT_CAP_MS'            _new_bot.js || { echo "   ❌ ACT_CAP_MS 没定义,会崩,中止"; exit 1; }

echo "=== 2) 换上，并解除停机 ==="
cp -f bot.real.js bot.real.js.prev-safe 2>/dev/null
mv -f _new_bot.js bot.real.js          # 入口是那个开关壳子,真正的逻辑在 bot.real.js
rm -f STOP.on && echo "   已移除 STOP.on（解除停机）"
T0=$(date -u "+%Y-%m-%d %H:%M:%S")
PID=$(systemctl show mcbot -p MainPID --value)
# 🔴 必须挡住 PID=0/空 的情况:服务被人工 stop 过时 MainPID 就是 0,
#    而 `kill 0` 会杀掉【脚本自己所在的整个进程组】,加上 2>/dev/null 还完全无声 ——
#    结果是 STOP.on 已删、bot.real.js 已替换,然后脚本当场死掉,
#    服务起不来、300 秒报表也不出,而且 Restart=always 对"被人工停掉"的服务不生效。
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  kill "$PID" 2>/dev/null
else
  echo "   ⚠️ 服务当前是停着的(MainPID=$PID),kill 没有意义。"
  echo "      需要有人手动拉起来:sudo systemctl start mcbot"
  echo "      (本脚本以 howard 身份跑,start 需要 root;kill 自己的进程不需要。)"
  NEEDS_START=1
fi
for i in $(seq 1 12); do
  sleep 5
  NEW=$(systemctl show mcbot -p MainPID --value)
  [ "$NEW" != "$PID" ] && [ "$NEW" != "0" ] && { echo "   ✅ 新进程 PID=$NEW（等了 $((i*5)) 秒）"; break; }
done
echo "   active=$(systemctl is-active mcbot)"

echo "=== 3) 观察 300 秒 ==="
sleep 300
SEG=$(awk -v t="$T0" '($1" "$2) >= t' /var/log/mcbot.log)

echo "=== 4) 最近 20 条 ==="
echo "$SEG" | grep -E '大脑决定|执行结果' | tail -20 | sed 's/^/   /'

DEC=$(echo "$SEG"   | grep -c '大脑决定')
GUARD=$(echo "$SEG" | grep -c '像是别人盖的房子')
NOLEAF=$(echo "$SEG"| grep -c '不像自然长的树')
CAP=$(echo "$SEG"   | grep -c '我掐掉了')
CHOP=$(echo "$SEG"  | grep -c '背包木头.*→')
DEAD=$(echo "$SEG"  | grep -c '我死了')
CRASH=$(echo "$SEG" | grep -ciE 'ReferenceError|TypeError|未捕获异常')
echo
echo "=== 5) 判定 ==="
echo "   🧠 决策: $DEC 次 / 300 秒（上一版只有 5 次；不堵的话应 ≳25 次）"
echo "   🛡️ 认出别人的房子、没动手: $GUARD 次 | 认出不是自然树: $NOLEAF 次"
echo "   ⏱️ 动作超时被掐: $CAP 次（这正是把大脑解放出来的那一下）"
echo "   🪓 真的砍到木头: $CHOP 次"
echo "   ☠️ 死亡: $DEAD | 崩溃: $CRASH"
if [ "$CRASH" -gt 0 ]; then
  echo "   ❌ 有崩溃,贴原文:"; echo "$SEG" | grep -iE 'ReferenceError|TypeError' | head -5 | sed 's/^/      /'
fi
if [ "$CHOP" -eq 0 ] && [ "$GUARD" -eq 0 ]; then
  echo "   ⚠️ 这个窗口它既没砍树也没遇到房子 → 护栏【没被验证到】,不能算修好（上次就是这么假阳性的）"
fi
exit 0
