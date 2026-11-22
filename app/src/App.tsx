import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Game } from './game/Game';
import { InputController } from './game/input';
import { AmbientMusic } from './game/music';
import { Hud } from './ui/Hud';
import { WorldMap } from './ui/WorldMap';
import { HelpPanel, SettingsPanel, GeneratePanel, EngineSettings, DEFAULT_SETTINGS } from './ui/panels';

type Mode = 'playing' | 'map' | 'help' | 'settings' | 'generate';

/**
 * The load overlay's cloud field. Lobes are positioned across (and well past)
 * the frame, each with its own size, drift vector and stagger, so the reveal
 * opens as a field of cumulus breaking apart instead of a sheet fading.
 */
function useCloudLobes() {
  return useMemo(() => {
    let seed = 20261123;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const lobes: React.CSSProperties[] = [];
    const cols = 5;
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const jitterX = (rnd() - 0.5) * 22;
        const jitterY = (rnd() - 0.5) * 22;
        // varied wide-to-tall proportions: a field of similar ellipses reads as
        // a pattern, real cumulus varies a lot mass to mass
        const w = 26 + rnd() * 40;
        const h = w * (0.62 + rnd() * 0.55);
        // drift away from the centre so the hole opens in the middle
        const cx = (c + 0.5) / cols * 100 + jitterX;
        const cy = (r + 0.5) / rows * 100 + jitterY;
        const dx = (cx - 50) * 2.9 + (rnd() - 0.5) * 26;
        const dy = (cy - 50) * 2.4 - 30 - rnd() * 34;
        lobes.push({
          left: `${cx - w / 2}%`,
          top: `${cy - h / 2}%`,
          width: `${w}%`,
          height: `${h}%`,
          animationDelay: `${rnd() * 260 + Math.abs(c - 2) * 40 + Math.abs(r - 1.5) * 55}ms`,
          ['--dx' as string]: `${dx}vw`,
          ['--dy' as string]: `${dy}vh`,
        });
      }
    }
    return lobes;
  }, []);
}

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const inputRef = useRef<InputController | null>(null);
  const musicRef = useRef<AmbientMusic | null>(null);
  const modeRef = useRef<Mode>('playing');
  const fogTimer = useRef(0);

  const [booted, setBooted] = useState(false);
  /** the boot overlay stays mounted through the mist-dissolve, then unmounts */
  const [bootGone, setBootGone] = useState(false);
  const [mode, setMode] = useState<Mode>('playing');
  const [minimap, setMinimap] = useState<HTMLCanvasElement | null>(null);
  const [explored, setExplored] = useState<HTMLCanvasElement | null>(null);
  const [fogSpan, setFogSpan] = useState(300);
  const [fogVersion, setFogVersion] = useState(0);
  const [exploredPct, setExploredPct] = useState(0);
  const [device, setDevice] = useState<'kbm' | 'touch'>('kbm');
  const [pose, setPose] = useState({ x: 0, z: 12, cameraYaw: Math.PI, stamina: 1 });
  const [regionCount, setRegionCount] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<EngineSettings>(DEFAULT_SETTINGS);
  const [bootError, setBootError] = useState<string | null>(null);
  const cloudLobes = useCloudLobes();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: Game | null = null;
    let input: InputController | null = null;
    let raf = 0;
    let lastFrame = 0;
    let resizeHandler: (() => void) | null = null;
    let onCanvasDown: ((e: PointerEvent) => void) | null = null;
    let bootTimer = 0;
    let fogTicker = 0;

    try {
      input = new InputController(host);
      game = new Game(host, input, {
        onMinimapReady: (c) => {
          setMinimap(c);
          const g = gameRef.current;
          if (g) {
            const fog = g.fogMask();
            if (fog.canvas) setExplored(fog.canvas);
            setFogSpan(fog.span);
          }
          setFogVersion((v) => v + 1);
        },
        onTick: (t) => setPose({ x: t.x, z: t.z, cameraYaw: t.cameraYaw, stamina: t.stamina }),
        onRegionCount: (n) => setRegionCount(n),
      });
      gameRef.current = game;
      inputRef.current = input;
      (window as unknown as { __mistIsles?: Game }).__mistIsles = game;
      input.onDevice((d) => setDevice(d));

      const loop = (now: number) => {
        // frame-rate cap applied here so the engine stays decoupled from timing
        const cap = game!.fpsCap;
        const minDelta = cap > 0 ? 1000 / cap : 0;
        if (now - lastFrame >= minDelta - 1) {
          const dt = lastFrame > 0 ? now - lastFrame : 16;
          lastFrame = now;
          game!.update(dt / 1000);
        }
        // fog mask grows as the player walks: refresh the sprites ~2x/second
        if (now - fogTimer.current > 500) {
          fogTimer.current = now;
          const fog = game!.fogMask();
          if (fog.canvas) {
            setExplored(fog.canvas);
            setFogSpan(fog.span);
            setFogVersion((v) => v + 1);
            setExploredPct(game!.exploredRatio());
          }
        }
        raf = requestAnimationFrame(loop);
      };
      void lastFrame;
      raf = requestAnimationFrame(loop);
      void fogTicker;

      resizeHandler = () => {
        if (!host) return;
        game!.resize(host.clientWidth, host.clientHeight);
      };
      window.addEventListener('resize', resizeHandler);
      // while the pointer is locked, clicks land on the canvas — so the world
      // prompt's clickable area is handled here instead of by the DOM button
      const onCanvasDown = (e: PointerEvent) => {
        if (modeRef.current !== 'playing' || !game) return;
        const p = game.mistPrompt;
        if (!p.visible) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        if (dx * dx + dy * dy < 80 * 80) setMode('generate');
      };
      host.addEventListener('pointerdown', onCanvasDown);
      bootTimer = window.setTimeout(() => {
        setBooted(true);
        // let the cloud-dissolve finish before unmounting the boot overlay
        window.setTimeout(() => setBootGone(true), 1350);
      }, 850);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
      setBooted(true);
    }

    return () => {
      window.clearTimeout(bootTimer);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      if (host && onCanvasDown) host.removeEventListener('pointerdown', onCanvasDown);
      cancelAnimationFrame(raf);
      input?.dispose();
      game?.dispose();
      gameRef.current = null;
      inputRef.current = null;
    };
  }, []);

  // settings → engine
  useEffect(() => {
    gameRef.current?.applySettings(settings);
  }, [settings]);

  // ambient music: starts once the world has loaded; browsers suspend audio
  // created before a gesture, so the first pointer press unlocks it
  useEffect(() => {
    if (!musicRef.current) musicRef.current = new AmbientMusic();
    musicRef.current.setEnabled(settings.musicOn, settings.musicVolume);
  }, [settings.musicOn, settings.musicVolume]);

  useEffect(() => {
    if (!booted) return;
    const unlock = () => musicRef.current?.setEnabled(true, settings.musicVolume);
    window.addEventListener('pointerdown', unlock, { once: true });
    const t = window.setTimeout(unlock, 600);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.clearTimeout(t);
    };
  }, [booted, settings.musicVolume]);

  // overlay state
  useEffect(() => {
    modeRef.current = mode;
    gameRef.current?.setFrozen(mode !== 'playing');
    if (inputRef.current) inputRef.current.suspendLook = mode !== 'playing';
    if (mode !== 'playing') inputRef.current?.releaseLock();
  }, [mode]);

  // global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        setMode('playing');
        return;
      }
      if (modeRef.current !== 'playing') return;
      if (e.code === 'KeyM') {
        e.preventDefault();
        setMode('map');
      } else if (e.code === 'KeyI') {
        e.preventDefault();
        setMode('help');
      } else if (e.code === 'KeyC') {
        e.preventDefault();
        setMode('settings');
      } else if (e.code === 'KeyE') {
        e.preventDefault();
        // E outside the frontier does NOTHING — no dialog, no toast, no state
        if (gameRef.current?.canWish) setMode('generate');
      } else if (e.code === 'AltLeft' || e.code === 'AltRight') {
        // show the mouse cursor on demand
        e.preventDefault();
        inputRef.current?.releaseLock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // toast helper
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4200);
  }, []);

  const handleGenerate = useCallback(
    (name: string, random: boolean) => {
      const g = gameRef.current;
      if (!g) return;
      // E is only legal at the mist frontier; the panel is unreachable otherwise,
      // but a stale click (panel opened, then the player walked away) must not
      // silently build an island in the middle of nowhere
      if (!g.canWish) {
        showToast('没有靠近迷雾边境，无法开拓');
        return;
      }
      // the island rises in the direction the camera is facing
      const label = g.generateRegion(name || '', random, g.facing);
      if (label) {
        setRegionCount(g.worldExtent().regions.length + 1);
        showToast(`新区域「${label}」已生成`);
      } else {
        showToast('生成失败：附近找不到合适的海域');
      }
    },
    [showToast],
  );

  const handleResetWorld = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    const seed = g.resetWorld();
    setRegionCount(1);
    setFogVersion((v) => v + 1);
    showToast(`世界已重新生成（种子 ${seed}）`);
  }, [showToast]);

  return (
    <div className="stage">
      <div className="viewport" ref={hostRef} />

      {!bootGone && (
        <div className={`boot ${booted ? 'reveal' : ''}`}>
          <div className="boot-sky" aria-hidden />
          <div className="boot-mist" aria-hidden>
            {cloudLobes.map((style, i) => (
              <i key={i} style={style} />
            ))}
          </div>
          <div className="boot-inner">
            <div className="boot-title">迷雾群岛</div>
            <div className="boot-sub">MIST ISLES</div>
            <div className="boot-bar">
              <i />
            </div>
            <div className="boot-hint">正在生成浮岛与潮汐</div>
          </div>
        </div>
      )}

      {bootError && (
        <div className="page" style={{ zIndex: 60 }}>
          <div className="page-head">
            <h1 className="page-title">无法启动 3D 场景</h1>
          </div>
          <p style={{ marginTop: 18, fontSize: 13, lineHeight: 1.9, color: 'rgba(24,70,80,0.72)' }}>
            浏览器未能创建 WebGL 上下文：{bootError}
            <br />
            请确认已启用硬件加速，或在支持 WebGL2 的浏览器中打开。
          </p>
        </div>
      )}

      <Hud
        minimapSource={minimap}
        exploredSource={explored}
        fogVersion={fogVersion}
        px={pose.x}
        pz={pose.z}
        cameraYaw={pose.cameraYaw}
        stamina={pose.stamina}
        device={device}
        hidden={mode !== 'playing'}
        onOpenMap={() => setMode('map')}
        onOpenHelp={() => setMode('help')}
        onOpenSettings={() => setMode('settings')}
        onOpenGenerate={() => setMode('generate')}
        onDash={() => gameRef.current?.requestDash()}
      />

      {mode === 'map' && (
        <WorldMap
          field={gameRef.current?.fieldRef ?? null}
          fog={explored}
          fogSpan={fogSpan}
          fogVersion={fogVersion}
          px={pose.x}
          pz={pose.z}
          yaw={pose.cameraYaw}
          onClose={() => setMode('playing')}
        />
      )}

      {mode === 'help' && <HelpPanel onClose={() => setMode('playing')} exploredPct={exploredPct} />}

      {mode === 'settings' && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setMode('playing')}
          onResetWorld={handleResetWorld}
        />
      )}

      {mode === 'generate' && (
        <GeneratePanel regionCount={regionCount} onGenerate={handleGenerate} onClose={() => setMode('playing')} />
      )}

      {toast && <div className="gen-toast">{toast}</div>}
    </div>
  );
}
