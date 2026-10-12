execute unless score @s ycm_i matches 0.. run scoreboard players set @s ycm_i -1
scoreboard players add @s ycm_i 1
execute store result score #n ycm_i run data get storage yangcinema:cfg n
execute if score @s ycm_i >= #n ycm_i run scoreboard players set @s ycm_i 0
execute store result storage yangcinema:tmp i int 1 run scoreboard players get @s ycm_i
function yangcinema:pick with storage yangcinema:tmp
data modify storage yangcinema:tmp cur.v set from storage yangcinema:cfg vol
function yangcinema:play with storage yangcinema:tmp cur
