package de.erethon.mccinema;

import de.erethon.mccinema.screen.Screen;
import de.erethon.mccinema.video.VideoPlayer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;

import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
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
 */
public final class YangAutoplay {
    private static final Set<VideoPlayer> PLAYERS = ConcurrentHashMap.newKeySet();
    private static final Map<VideoPlayer, Set<UUID>> LAST_VIEWERS = new ConcurrentHashMap<>();
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
            plugin.getLogger().info("[羊羊] 自动循环/附近没人暂停 已启动,附近范围 " + Screen.VIEWER_DISTANCE + " 格");
        }
    }

    public static void untrack(VideoPlayer vp) {
        PLAYERS.remove(vp);
        LAST_VIEWERS.remove(vp);
    }

    private static void tick(Plugin plugin) {
        boolean autoPause = plugin.getConfig().getBoolean("playback.auto-pause", false);
        for (VideoPlayer vp : PLAYERS) {
            try {
                VideoPlayer.State st = vp.getState();
                if (st != VideoPlayer.State.PLAYING && st != VideoPlayer.State.PAUSED) {
                    LAST_VIEWERS.remove(vp);
                    continue;
                }
                Screen screen = vp.getScreen();
                screen.updateViewerCache();
                Collection<Player> viewers = screen.getViewers();
                Set<UUID> now = new HashSet<>();
                Set<UUID> before = LAST_VIEWERS.getOrDefault(vp, Collections.emptySet());
                for (Player p : viewers) {
                    now.add(p.getUniqueId());
                    if (!before.contains(p.getUniqueId())) {
                        vp.getPacketDispatcher().sendLastFrameToPlayer(p, screen);
                    }
                }
                LAST_VIEWERS.put(vp, now);
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
