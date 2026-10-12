package de.erethon.mccinema;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Hanging;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPistonExtendEvent;
import org.bukkit.event.block.BlockPistonRetractEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.hanging.HangingBreakByEntityEvent;
import org.bukkit.event.hanging.HangingBreakEvent;
import org.bukkit.event.hanging.HangingPlaceEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerBucketFillEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.plugin.Plugin;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 羊羊补丁 yy6(2026-10-12):Owner「我發現屏幕可以被我破壞掉 你把它鎖死」。
 * 出生点是领地插件的管理员领地,但管理员(op)照样能拆,创造模式还能打掉「固定」的画框。
 * 这里按 config.yml 的 protect.boxes(世界,x1,y1,z1,x2,y2,z2,两头都含)把大屏锁住:框里的方块不能拆、不能放,
 * 画框不能打、不能拆、不能转、不能往里放东西,也不能在上面挂新的;爆炸、活塞、火、末影人都动不了 —— 对所有玩家都一样(包括管理员)。
 * 维护走服务器命令(fill / kill / summon 不经过这些事件)。每 10 秒重读一次 config.yml 的这一段,改了不用重启。
 */
public final class YangProtect implements Listener {
    private final Plugin plugin;
    private volatile List<String> worlds = List.of();
    private volatile List<double[]> boxes = List.of();      // 每个:x1,y1,z1,x2,y2,z2(右边界不含)
    private final Map<UUID, Long> told = new ConcurrentHashMap<>();

    private YangProtect(Plugin plugin) {
        this.plugin = plugin;
    }

    public static void enable(Plugin plugin) {
        YangProtect p = new YangProtect(plugin);
        p.load();
        Bukkit.getPluginManager().registerEvents(p, plugin);
        Bukkit.getScheduler().runTaskTimer(plugin, p::load, 200L, 200L);
        plugin.getLogger().info("[羊羊] 大屏保护已启用:" + p.boxes.size() + " 个区域");
    }

    private void load() {
        try {
            YamlConfiguration c = YamlConfiguration.loadConfiguration(new File(plugin.getDataFolder(), "config.yml"));
            List<String> w = new ArrayList<>();
            List<double[]> b = new ArrayList<>();
            if (c.getBoolean("protect.enabled", true)) {
                for (String s : c.getStringList("protect.boxes")) {
                    String[] p = s.split(",");
                    if (p.length != 7) {
                        continue;
                    }
                    try {
                        int x1 = Integer.parseInt(p[1].trim()), y1 = Integer.parseInt(p[2].trim()), z1 = Integer.parseInt(p[3].trim());
                        int x2 = Integer.parseInt(p[4].trim()), y2 = Integer.parseInt(p[5].trim()), z2 = Integer.parseInt(p[6].trim());
                        w.add(p[0].trim());
                        b.add(new double[]{Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2),
                                Math.max(x1, x2) + 1, Math.max(y1, y2) + 1, Math.max(z1, z2) + 1});
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            worlds = w;
            boxes = b;
        } catch (Exception e) {
            plugin.getLogger().warning("[羊羊] 读大屏保护区域出错:" + e);
        }
    }

    private boolean in(String world, double x, double y, double z) {
        List<String> w = worlds;
        List<double[]> b = boxes;
        for (int i = 0; i < b.size(); i++) {
            double[] q = b.get(i);
            if (w.get(i).equals(world) && x >= q[0] && y >= q[1] && z >= q[2] && x < q[3] && y < q[4] && z < q[5]) {
                return true;
            }
        }
        return false;
    }

    private boolean in(Block bl) {
        return bl != null && in(bl.getWorld().getName(), bl.getX() + 0.5, bl.getY() + 0.5, bl.getZ() + 0.5);
    }

    private boolean in(Entity e) {
        Location l = e.getLocation();
        return l.getWorld() != null && in(l.getWorld().getName(), l.getX(), l.getY(), l.getZ());
    }

    /** 告诉动手的人这是锁住的(同一个人 3 秒内只说一次),并记一行日志 */
    private void tell(Player p, String what) {
        if (p == null) {
            return;
        }
        long now = System.currentTimeMillis();
        Long last = told.get(p.getUniqueId());
        if (last != null && now - last < 3000) {
            return;
        }
        told.put(p.getUniqueId(), now);
        p.sendMessage(ChatColor.GRAY + "大屏是锁住的,拆不了、也不能在上面放东西。");
        plugin.getLogger().info("[羊羊] 挡住了 " + p.getName() + " " + what);
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onBreak(BlockBreakEvent e) {
        if (in(e.getBlock())) {
            e.setCancelled(true);
            tell(e.getPlayer(), "拆方块 " + e.getBlock().getType());
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPlace(BlockPlaceEvent e) {
        if (in(e.getBlockPlaced())) {
            e.setCancelled(true);
            tell(e.getPlayer(), "放方块");
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onBucketEmpty(PlayerBucketEmptyEvent e) {
        if (in(e.getBlock())) {
            e.setCancelled(true);
            tell(e.getPlayer(), "倒水/岩浆");
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onBucketFill(PlayerBucketFillEvent e) {
        if (in(e.getBlock())) {
            e.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onEntityExplode(EntityExplodeEvent e) {
        e.blockList().removeIf(this::in);
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onBlockExplode(BlockExplodeEvent e) {
        e.blockList().removeIf(this::in);
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPistonExtend(BlockPistonExtendEvent e) {
        if (in(e.getBlock().getRelative(e.getDirection()))) {
            e.setCancelled(true);
            return;
        }
        for (Block b : e.getBlocks()) {
            if (in(b) || in(b.getRelative(e.getDirection()))) {
                e.setCancelled(true);
                return;
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPistonRetract(BlockPistonRetractEvent e) {
        for (Block b : e.getBlocks()) {
            if (in(b) || in(b.getRelative(e.getDirection()))) {
                e.setCancelled(true);
                return;
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onEntityChangeBlock(EntityChangeBlockEvent e) {
        if (in(e.getBlock())) {
            e.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onBurn(BlockBurnEvent e) {
        if (in(e.getBlock())) {
            e.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onIgnite(BlockIgniteEvent e) {
        if (in(e.getBlock())) {
            e.setCancelled(true);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onHangingBreak(HangingBreakEvent e) {
        if (in(e.getEntity())) {
            e.setCancelled(true);
            if (e instanceof HangingBreakByEntityEvent hb && hb.getRemover() instanceof Player p) {
                tell(p, "拆画框");
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onHangingPlace(HangingPlaceEvent e) {
        if (in(e.getEntity()) || in(e.getBlock().getRelative(e.getBlockFace()))) {
            e.setCancelled(true);
            tell(e.getPlayer(), "挂画框/画");
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onDamage(EntityDamageEvent e) {
        if (e.getEntity() instanceof Hanging && in(e.getEntity())) {
            e.setCancelled(true);
            if (e instanceof EntityDamageByEntityEvent d && d.getDamager() instanceof Player p) {
                tell(p, "打画框");
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onInteract(PlayerInteractEntityEvent e) {
        if (e.getRightClicked() instanceof Hanging && in(e.getRightClicked())) {
            e.setCancelled(true);
        }
    }
}
