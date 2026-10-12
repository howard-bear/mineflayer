# 出生广场大屏的背景音乐(2026-10-12):每个人走近屏幕就从一首的开头放,放完接下一首。
# 曲目、范围、开关都在 storage yangcinema:cfg 里,由服务器上的 mc-cinema 按后台「大屏」页的设置写进来,改设置不用 reload。
# ycm_t:这个人这一首还剩几 tick;ycm_i:这个人放到清单第几首
scoreboard objectives add ycm_t dummy
scoreboard objectives add ycm_i dummy
