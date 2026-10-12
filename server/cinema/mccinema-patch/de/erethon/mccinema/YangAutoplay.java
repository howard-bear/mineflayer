package de.erethon.mccinema;

import de.erethon.mccinema.screen.Screen;
import de.erethon.mccinema.video.VideoPlayer;
import io.papermc.paper.event.player.PlayerTrackEntityEvent;
import org.bukkit.Bukkit;
import org.bukkit.entity.ItemFrame;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.MapMeta;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;

import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 羊羊补丁(2026-10-12):出生广场大屏要「全天循环、谁走过来谁看」,原版 2.2.2 是「管理员给在场的人放一场」设计的。
 * 每 10 tick(半秒)看一次每块在放的屏幕附近有谁:
 *   · 新来的(走过来的、刚进服的、离开后又回来的)→ 补一张完整画面(否则只收到后续的局部更新,画面是花的);
 *   · 附近一个人都没有 → 暂停(省 CPU,声音也停);有人来了 → 从「这一段声音的开头」接着放(VideoPlayer.yangAutoResume)。
 * 开关都在 config.yml:playback.loop / playback.auto-pause / screen.viewer-distance。
 *
 * yy4(10-12):刚进服 / 换世界回来的玩家,游戏本身会在大约 1 秒后把这 28 张地图按存档里的内容(全空白)发一遍,
 * 盖掉我们刚补的完整画面;之后插件只发「变了的部分」,画面不动的地方就一直是空白(看着是一块块黑)。
 * 实测(观察号逐包记录):0.4 秒收到完整画面 → 1.1 秒收到 28 张全空白 → 之后只有局部更新。
 * 所以新来的人在第 0、2、5 秒各补一次完整画面;另外每 60 秒给附近所有人补一次(兜底,每人约 2 KB/秒)。
 * yy5(10-12):那张「空白」不是固定 1 秒后到 —— 重启后实测 10.9 秒才到(游戏是在玩家【开始看见画框】的时候发的,
 * 看见画框要等那块地形发到玩家手里,快慢不定)。所以改成听 Paper 的 PlayerTrackEntityEvent:玩家开始看见我们屏幕的画框
 * (正面、背面都算)→ 0.6 秒、1.25 秒后各补一次完整画面(游戏的空白在看见后半秒内发出)。同一批画框只排一次。
 */
public final class YangAutoplay {
    private static final Set<VideoPlayer> PLAYERS = ConcurrentHashMap.newKeySet();
    private static final Map<VideoPlayer, Map<UUID, Integer>> AGE = new ConcurrentHashMap<>();   // 每个观众来了几轮(一轮半秒)
    private static final int[] RESEND_AT = {0, 4, 10};          // 第 0、2、5 秒补完整画面
    private static final int REFRESH_EVERY = 120;               // 每 60 秒给所有观众补一次
    private static long rounds = 0;
    private static final Map<UUID, Long> TRACK_QUEUED = new ConcurrentHashMap<>();   // 玩家 → 上次因「看见画框」排补画面的时刻
    private static BukkitTask task;

    private YangAutoplay() {
    }

    public static boolean loopEnabled(Plugin plugin) {
        return plugin.getConfig().getBoolean("playback.loop", false);
    }

    public static synchronized void track(Plugin plugin, VideoPlayer vp) {
        PLAYERS.add(vp);
        if (task == null) {
            Screen.VIEWER_DISTANCE = plugin.getConfig().getDouble("screen.viewer-distance", 32.0);
            task = Bukkit.getScheduler().runTaskTimer(plugin, () -> tick(plugin), 20L, 10L);
            Bukkit.getPluginManager().registerEvents(new TrackListener(plugin), plugin);
            plugin.getLogger().info("[羊羊] 自动循环/附近没人暂停 已启动,附近范围 " + Screen.VIEWER_DISTANCE + " 格");
        }
    }

    public static void untrack(VideoPlayer vp) {
        PLAYERS.remove(vp);
        AGE.remove(vp);
    }

    private static boolean screenHasMap(Screen screen, int mapId) {
        for (de.erethon.mccinema.screen.MapTile t : screen.getTiles()) {
            if (t.getMapId() == mapId) {
                return true;
            }
        }
        return false;
    }

    /** 玩家开始看见我们屏幕的某个画框(正面插件的、背面镜像的都算)→ 稍后补完整画面,盖掉游戏随后发的那张空白 */
    static final class TrackListener implements Listener {
        private final Plugin plugin;

        TrackListener(Plugin plugin) {
            this.plugin = plugin;
        }

        @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
        public void onTrack(PlayerTrackEntityEvent e) {
            if (!(e.getEntity() instanceof ItemFrame frame)) {
                return;
            }
            ItemStack item = frame.getItem();
            if (item == null || !(item.getItemMeta() instanceof MapMeta meta) || !meta.hasMapId()) {
                return;
            }
            int mapId = meta.getMapId();
            Player p = e.getPlayer();
            for (VideoPlayer vp : PLAYERS) {
                if (!screenHasMap(vp.getScreen(), mapId)) {
                    continue;
                }
                long now = System.currentTimeMillis();
                Long last = TRACK_QUEUED.get(p.getUniqueId());
                if (last != null && now - last < 2000) {
                    return;                                     // 同一批画框(正面 + 背面 56 个)只排一次
                }
                TRACK_QUEUED.put(p.getUniqueId(), now);
                for (long delay : new long[]{12L, 25L}) {
                    Bukkit.getScheduler().runTaskLater(plugin, () -> {
                        VideoPlayer.State st = vp.getState();
                        if (!p.isOnline() || (st != VideoPlayer.State.PLAYING && st != VideoPlayer.State.PAUSED)) {
                            return;
                        }
                        if (!vp.getScreen().getViewers().contains(p)) {
                            return;                             // 还不在附近:走近时会补(见 tick)
                        }
                        vp.getPacketDispatcher().sendLastFrameToPlayer(p, vp.getScreen());
                    }, delay);
                }
                return;
            }
        }
    }

    private static void tick(Plugin plugin) {
        boolean autoPause = plugin.getConfig().getBoolean("playback.auto-pause", false);
        boolean refreshAll = (++rounds % REFRESH_EVERY) == 0;
        for (VideoPlayer vp : PLAYERS) {
            try {
                VideoPlayer.State st = vp.getState();
                if (st != VideoPlayer.State.PLAYING && st != VideoPlayer.State.PAUSED) {
                    AGE.remove(vp);
                    continue;
                }
                Screen screen = vp.getScreen();
                screen.updateViewerCache();
                Collection<Player> viewers = screen.getViewers();
                Map<UUID, Integer> before = AGE.getOrDefault(vp, Collections.emptyMap());
                Map<UUID, Integer> now = new HashMap<>();
                for (Player p : viewers) {
                    UUID id = p.getUniqueId();
                    Integer prev = before.get(id);
                    int age = prev == null ? 0 : Math.min(prev + 1, 1000);
                    now.put(id, age);
                    boolean resend = refreshAll;
                    for (int a : RESEND_AT) {
                        resend |= age == a;
                    }
                    if (resend) {
                        vp.getPacketDispatcher().sendLastFrameToPlayer(p, screen);
                    }
                }
                AGE.put(vp, now);
                if (!autoPause) {
                    continue;
                }
                if (viewers.isEmpty() && st == VideoPlayer.State.PLAYING) {
                    vp.yangAutoPause();
                } else if (!viewers.isEmpty() && st == VideoPlayer.State.PAUSED && vp.isYangAutoPaused()) {
                    vp.yangAutoResume();
                }
            } catch (Exception e) {
                plugin.getLogger().warning("[羊羊] 自动循环出错:" + e);
            }
        }
    }
}
