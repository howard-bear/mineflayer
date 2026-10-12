# 屏幕中心 (8, 70.5, 45);离屏幕 range 格以内、这一首已经放完(或还没放过)的人 → 给他放下一首
$execute as @a[x=8,y=70,z=45,distance=..$(range)] unless score @s ycm_t matches 1.. run function yangcinema:start
