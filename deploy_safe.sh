#!/bin/bash
# 部署两件事:
#   1) 🔴 不准再拆别人的房子:只砍"上面有树叶 + 周围3格没人造方块"的真树
#   2) 🎮 让 5060 真正忙起来:每个动作封顶 30 秒,不许再把大脑堵在门外
# 不需要 root 密码(换文件 + 杀自己的进程,systemd 自动拉起)
set -u
cd ~/mcbot || exit 1

# ══════════════════════════════════════════════════════════════════
# 🔒 部署互斥锁 —— 2026-09-17 补上,因为这件事真的发生过。
#
# 那天晚上有【两个 Claude 会话】同时在改同一个机器人(一个是另一个 fork 出来的),
# 20:05 那次两边隔 **22 秒** 先后跑这个脚本 —— 只是运气好才没把对方的改动抹掉。
# 这个脚本原来一个锁都没有:`mv -f _new_bot.js bot.real.js` 是无条件覆盖,
# 谁最后跑谁赢,而且【没有任何痕迹】。
#
# 两道防护:
#   ① flock:同一时刻只允许一个部署在跑(互斥)。
#   ② EXPECT_MD5:可选的乐观并发检查 —— 调用方把"我读代码时的 md5"传进来,
#      如果现在的文件已经不是那一份(说明别人在这中间部署过),就【拒绝】而不是覆盖。
#      用法:EXPECT_MD5=<我读到的md5> bash ~/deploy_safe.sh
#      不传就跳过这一检查(向后兼容,不破坏别人现有的用法)。
# ══════════════════════════════════════════════════════════════════
exec 9>/home/howard/.mcbot-deploy.lock
if ! flock -n 9; then
  echo "❌ 另一个部署正在进行中(锁文件 ~/.mcbot-deploy.lock)—— 本次中止。"
  echo "   这不是错误,是防止两个会话互相覆盖。等对方跑完再来。"
  echo "   想看是谁占着:fuser -v /home/howard/.mcbot-deploy.lock"
  exit 1
fi

CUR_MD5=$(md5sum bot.real.js 2>/dev/null | cut -d' ' -f1)
# ──────────────────────────────────────────────────────────────────
# 🔴 不传 EXPECT_MD5 = 默认拒绝(2026-09-17 09:5x 收紧)
#
# 第一版把 EXPECT_MD5 做成【可选】,平级会话一句话点破了问题:
#   **flock 只挡"同时",挡不住"先后" —— 而静默的先后覆盖才是致命的那个。**
# 可选的检查等于没检查:未来任何一次忘了传,就退回到"谁最后跑谁赢、不留痕迹"。
# 所以把安全的那条路改成【默认】:不传就拒绝,要盲部署必须显式说出来。
# 盲部署也照样记进审计日志,事后能查是谁绕过的。
# ──────────────────────────────────────────────────────────────────
if [ -z "${EXPECT_MD5:-}" ] && [ "${BLIND_DEPLOY:-0}" != "1" ]; then
  echo "❌ 拒绝部署:没告诉我你读代码时的 md5。"
  echo "   现在服务器上的是: $CUR_MD5"
  echo "   👉 正确做法:EXPECT_MD5=$CUR_MD5 bash ~/deploy_safe.sh"
  echo "      (前提是这个 md5 和你拉下来改的那份一致;不一致说明别人部署过,"
  echo "       要重新拉、重新打补丁,不要覆盖。)"
  echo "   真要盲部署(明知可能抹掉别人的改动):BLIND_DEPLOY=1 bash ~/deploy_safe.sh"
  exit 1
fi
if [ -z "${EXPECT_MD5:-}" ]; then
  echo "⚠️ 盲部署(BLIND_DEPLOY=1):跳过并发检查,可能抹掉别人的改动。已记进审计日志。"
  printf '%s  🔴BLIND  user=%s  from=%s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$(whoami)" "${CUR_MD5:0:12}" \
    >> /home/howard/deploy-audit.log
fi
if [ -n "${EXPECT_MD5:-}" ] && [ "$EXPECT_MD5" != "$CUR_MD5" ]; then
  echo "❌ 拒绝部署:现在的 bot.real.js 不是你读过的那一份。"
  echo "   你以为是: $EXPECT_MD5"
  echo "   实际是  : $CUR_MD5"
  echo "   说明在你改代码的这段时间里【别人部署过】。"
  echo "   👉 正确做法:重新把服务器上的 bot.real.js 拉下来,把你的改动重新打上去,再部署。"
  echo "      不要直接覆盖 —— 那会抹掉对方的改动(2026-09-17 差点就这么发生了)。"
  exit 1
fi

# 部署审计:谁、什么时候、从哪个 md5 换到哪个 md5。撞车了要能查。
NEW_MD5=$(md5sum _new_bot.js 2>/dev/null | cut -d' ' -f1)
# ⚠️ tty 的输出可能是 "not a tty"(带空格),会把后面的字段挤到下一行 —— 去掉空格
DEPLOY_TTY=$(tty 2>/dev/null | tr -d ' ' || echo '-')
printf '%s  user=%s  tty=%s  from=%s  to=%s\n' \
  "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$(whoami)" "${DEPLOY_TTY:--}" \
  "${CUR_MD5:0:12}" "${NEW_MD5:0:12}" >> /home/howard/deploy-audit.log
echo "🔒 已取得部署锁;当前 ${CUR_MD5:0:12} → 将换成 ${NEW_MD5:0:12}(记录在 ~/deploy-audit.log)"

echo "=== 1) 语法检查(不过就不放它出来）==="
# 语法关必须用【服务真正会用的那个 node】,不是 PATH 里那个。
# 2026-09-17:mcbot 被 systemd drop-in 切到了 Node 22,而 /usr/bin/node 仍是 Debian 的 20。
# 用 20 去 --check 一份将来可能含 22 语法的文件,这道关会【静默放过】——
# 那正是这个脚本存在的意义的反面。所以从 systemd 单元里抠出真正的解释器,抠不到才退回 PATH。
NODE_BIN="$(systemctl show -p ExecStart --value mcbot 2>/dev/null | sed -n 's/.*path=\([^ ]*\).*/\1/p' | head -1)"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
echo "   语法关用的解释器:$NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"
"$NODE_BIN" --check _new_bot.js || { echo "   ❌ 语法错,中止,小麦继续停着"; exit 1; }
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
