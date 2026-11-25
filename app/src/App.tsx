import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Game, GenState } from './game/Game';
import { InputController } from './game/input';
import { AmbientMusic } from './game/music';
import { Hud, TileGrid } from './ui/Hud';
import { WorldMap, ExploredBounds } from './ui/WorldMap';
import { HelpPanel, SettingsPanel, GeneratePanel, ModelSettingsPanel, EngineSettings, DEFAULT_SETTINGS } from './ui/panels';
import { aiApi, StatusInfo } from './game/aiClient';

type Mode = 'playing' | 'map' | 'help' | 'settings' | 'generate' | 'models';

const SETTINGS_KEY = 'mist.settings.v1';

function loadSettings(): EngineSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    /* corrupt or unavailable storage: fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * The load screen's cloud field. Lobes are placed across (and well past) the frame,
 * each with its own size, drift vector and stagger, so the veil does not fade as a
 * sheet: it breaks apart lobe by lobe, over the island that is already rendering
 * behind it.
 */
function useCloudLobes() {
  return useMemo(() => {
    let seed = 20261123;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const lobes: React.CSSProperties[] = [];
    // many small-to-medium masses, not a handful of discs: the veil has to read as
    // a bank of cumulus, so that it can break up cloud by cloud
    const cols = 9;
    const rows = 7;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const jitterX = (rnd() - 0.5) * 15;
        const jitterY = (rnd() - 0.5) * 15;
        // varied wide-to-tall proportions: a field of similar ellipses reads as a
        // pattern, real cumulus varies a lot mass to mass
        const w = 15 + rnd() * 20;
        const h = w * (0.66 + rnd() * 0.5);
        // drift away from the centre so the hole opens in the middle, first
        const cx = ((c + 0.5) / cols) * 100 + jitterX;
        const cy = ((r + 0.5) / rows) * 100 + jitterY;
        const dx = (cx - 50) * 3.4 + (rnd() - 0.5) * 30;
        const dy = (cy - 50) * 2.8 - 26 - rnd() * 26;
        // The stagger must be at least as long as one lobe's own dissolve, or every
        // cloud is still solid while the first ones leave and the field reads as a
        // single fade. So the delays span ~1.8 s against a ~2.2 s dissolve: at any
        // moment some clouds are whole, some are thinning, some are already gone.
        const delay =
          Math.abs(c - (cols - 1) / 2) * 132 + Math.abs(r - (rows - 1) / 2) * 186 + rnd() * 420;
        lobes.push({
          left: `${cx - w / 2}%`,
          top: `${cy - h / 2}%`,
          width: `${w}%`,
          height: `${h}%`,
          animationDelay: `${Math.round(delay)}ms`,
          ['--dx' as string]: `${dx}vw`,
          ['--dy' as string]: `${dy}vh`,
        });
      }
    }
    return lobes;
  }, []);
}

/**
 * The "opening" card: a turning white ring, the stamina pill's own track and fill,
 * and a cancel. It is anchored to the tile box in the world (Game.genHud), so it
 * hangs directly above the square the mist is about to give up, and follows it as
 * the camera and the player move.
 */
function GenCard({ progress, hidden, onCancel }: { progress: number; hidden: boolean; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = (window as unknown as { __mistIsles?: { genHud: { x: number; y: number; visible: boolean } } }).__mistIsles;
      const el = ref.current;
      if (g && el) {
        const p = g.genHud;
        el.style.opacity = p.visible ? '1' : '0';
        el.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y - 12}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={ref} className={`gen-card ${hidden ? 'hidden' : ''}`} role="status" aria-live="polite" style={{ opacity: 0 }}>
      <div className="gen-card-main">
        <span className="gen-spin" aria-hidden />
        <div className="gen-card-text">
          <div className="gen-card-title">正在开拓</div>
          <div className="gen-card-bar" aria-hidden>
            <i style={{ transform: `scaleX(${Math.max(0.03, Math.min(1, progress))})` }} />
          </div>
        </div>
        <button className="gen-cancel ctl" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const inputRef = useRef<InputController | null>(null);
  const musicRef = useRef<AmbientMusic | null>(null);
  const modeRef = useRef<Mode>('playing');
  const fogTimer = useRef(0);
  const gridTimer = useRef(0);
  const lastGrid = useRef('');

  const cloudLobes = useCloudLobes();
  const [booted, setBooted] = useState(false);
  /** the boot overlay stays mounted through the mist-dissolve, then unmounts */
  const [bootGone, setBootGone] = useState(false);
  const [bootText, setBootText] = useState('迷雾正在聚拢…');
  /** false while the opening mist is still parting: the HUD waits for the island to show */
  const [settled, setSettled] = useState(false);
  const [mode, setMode] = useState<Mode>('playing');
  const [minimap, setMinimap] = useState<HTMLCanvasElement | null>(null);
  const [explored, setExplored] = useState<HTMLCanvasElement | null>(null);
  const [fogSpan, setFogSpan] = useState(300);
  const [fogVersion, setFogVersion] = useState(0);
  /** the part of the world the map can see: bounds how far the map may pan and zoom out */
  const [bounds, setBounds] = useState<ExploredBounds | null>(null);
  const [device, setDevice] = useState<'kbm' | 'touch'>('kbm');
  const [pose, setPose] = useState({ x: 0, z: 12, cameraYaw: Math.PI, stamina: 1, inWater: false, underwater: false });
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<EngineSettings>(loadSettings);
  const [bootError, setBootError] = useState<string | null>(null);
  const [gen, setGen] = useState<GenState | null>(null);
  const [aiStatus, setAiStatus] = useState<StatusInfo | null>(null);
  /** true once the server has answered (or refused) the first status request */
  const [aiChecked, setAiChecked] = useState(false);
  const [grid, setGrid] = useState<TileGrid>({ frontier: [], gen: null });

  // settings survive a reload
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable */
    }
  }, [settings]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let game: Game | null = null;
    let input: InputController | null = null;
    let raf = 0;
    let lastFrame = 0;
    let resizeHandler: (() => void) | null = null;
    let onCanvasDown: ((e: PointerEvent) => void) | null = null;
    let fogTicker = 0;
    /** the fog mask's change counter as last seen: sprites rebuild only when it moves */
    const lastFogStamp = { current: -1 };
    let cancelled = false;

    (async () => {
      try {
        input = new InputController(host);
        inputRef.current = input;
        input.onDevice((d) => setDevice(d));

        // the world is built once the Blender model library and terrain are in
        game = await Game.create(
          host,
          input,
          {
            onMinimapReady: (c) => {
              setMinimap(c);
              const g = gameRef.current;
              if (g) {
                const fog = g.fogMask();
                if (fog.canvas) setExplored(fog.canvas);
                setFogSpan(fog.span);
                lastFogStamp.current = g.fogStamp;
                setBounds(g.exploredBounds());
              }
              setFogVersion((v) => v + 1);
            },
            onTick: (t) => setPose({ x: t.x, z: t.z, cameraYaw: t.cameraYaw, stamina: t.stamina, inWater: t.inWater, underwater: t.underwater }),
            onGenerate: (g) => setGen({ ...g }),
          },
          (text) => {
            if (!cancelled) setBootText(text);
          },
        );
        if (cancelled) {
          game.dispose();
          return;
        }
        gameRef.current = game;
        (window as unknown as { __mistIsles?: Game }).__mistIsles = game;

        const loop = (now: number) => {
          // frame-rate cap applied here so the engine stays decoupled from timing
          const cap = game!.fpsCap;
          const minDelta = cap > 0 ? 1000 / cap : 0;
          if (now - lastFrame >= minDelta - 1) {
            const dt = lastFrame > 0 ? now - lastFrame : 16;
            lastFrame = now;
            game!.update(dt / 1000);
          }
          // the fog of war moves as the player walks and opens land: the map sprites
          // are rebuilt when it does, and only then (checked ~2x/second)
          if (now - fogTimer.current > 500) {
            fogTimer.current = now;
            if (game!.fogStamp !== lastFogStamp.current) {
              lastFogStamp.current = game!.fogStamp;
              const fog = game!.fogMask();
              if (fog.canvas) {
                setExplored(fog.canvas);
                setFogSpan(fog.span);
              }
              setBounds(game!.exploredBounds());
              setFogVersion((v) => v + 1);
            }
          }
          // the tile grid only changes when the camera swings to another frontier tile
          if (now - gridTimer.current > 400) {
            gridTimer.current = now;
            // the generating tile is only marked while it is actually being generated
            const next = JSON.stringify({ f: game!.frontierTiles(), g: game!.gen.active ? game!.gen.tile : null });
            if (next !== lastGrid.current) {
              lastGrid.current = next;
              const parsed = JSON.parse(next) as { f: TileGrid['frontier']; g: TileGrid['gen'] };
              setGrid({ frontier: parsed.f, gen: parsed.g });
            }
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        void fogTicker;

        resizeHandler = () => {
          if (!host) return;
          game!.resize(host.clientWidth, host.clientHeight);
        };
        window.addEventListener('resize', resizeHandler);
        // while the pointer is locked, clicks land on the canvas — so the world
        // prompt's clickable area is handled here instead of by the DOM button
        const onCanvas = (e: PointerEvent) => {
          if (modeRef.current !== 'playing' || !game) return;
          if (game.generating) return;
          const p = game.mistPrompt;
          if (!p.visible) return;
          const dx = e.clientX - p.x;
          const dy = e.clientY - p.y;
          if (dx * dx + dy * dy < 80 * 80) setMode('generate');
        };
        onCanvasDown = onCanvas;
        host.addEventListener('pointerdown', onCanvas);

        setBooted(true);
        // the opening mist takes about three seconds to part; the title goes with it,
        // and the HUD fades in behind them
        // the cloud field takes about three seconds to break apart; the overlay
        // must outlive its last lobe, or the reveal is cut off mid-way
        window.setTimeout(() => setBootGone(true), 4700);
        window.setTimeout(() => setSettled(true), 1900);
      } catch (err) {
        console.error('Failed to start 3D scene', err);
        setBootError(err instanceof Error ? err.message : String(err));
        setBooted(true);
        setBootGone(true);
        setSettled(true);
      }
    })();

    return () => {
      cancelled = true;
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      if (host && onCanvasDown) host.removeEventListener('pointerdown', onCanvasDown);
      cancelAnimationFrame(raf);
      input?.dispose();
      game?.dispose();
      gameRef.current = null;
      inputRef.current = null;
    };
  }, []);

  // settings → engine (also the first apply once the engine exists)
  useEffect(() => {
    gameRef.current?.applySettings(settings);
  }, [settings, booted]);

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
    // the AI configuration may have changed while a page was open
    if (mode === 'generate' || mode === 'models') {
      aiApi
        .status()
        .then(setAiStatus)
        .catch(() => setAiStatus(null))
        .finally(() => setAiChecked(true));
    }
  }, [mode]);

  // toast helper
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 5200);
  }, []);

  // global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        setMode('playing');
        return;
      }
      // a page's own key closes it again: M, I and C toggle
      const page: Partial<Record<'KeyM' | 'KeyI' | 'KeyC', Mode>> = { KeyM: 'map', KeyI: 'help', KeyC: 'settings' };
      const open = page[e.code as keyof typeof page];
      if (open) {
        e.preventDefault();
        setMode(modeRef.current === open ? 'playing' : open);
        return;
      }
      if (modeRef.current !== 'playing') return;
      if (e.code === 'KeyE') {
        e.preventDefault();
        const g = gameRef.current;
        if (!g) return;
        // a region is already being generated: E is refused, and the player is told why
        if (g.generating) {
          showToast('迷雾正在散开，等当前区域完成后再开拓');
          return;
        }
        // E outside the frontier does NOTHING — no dialog, no toast, no state
        if (g.canWish) setMode('generate');
      } else if (e.code === 'AltLeft' || e.code === 'AltRight') {
        // show the mouse cursor on demand
        e.preventDefault();
        inputRef.current?.releaseLock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleGenerate = useCallback(
    async (wish: string) => {
      const g = gameRef.current;
      if (!g) return;
      // E is only legal at the mist frontier; the panel is unreachable otherwise,
      // but a stale click (panel opened, then the player walked away) must not
      // silently build an island in the middle of nowhere
      if (!g.canWish) {
        showToast('没有靠近迷雾边境，无法开拓');
        return;
      }
      setMode('playing');
      const ok = await g.generate(wish);
      if (ok) {
        showToast('新区域已经生成');
      } else if (g.gen.cancelled) {
        showToast('已取消开拓');
      } else {
        showToast(`开拓失败：${g.gen.error ?? '未知原因'}`);
      }
      setFogVersion((v) => v + 1);
    },
    [showToast],
  );

  const handleResetWorld = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    const seed = g.resetWorld();
    setFogVersion((v) => v + 1);
    showToast(`世界已重新生成（种子 ${seed}）`);
  }, [showToast]);

  // a model endpoint is configured on the local server; unknown only until the first answer
  const aiReady = !!aiStatus?.configured;

  return (
    <div className={`stage ${settled ? '' : 'settling'}`}>
      <div className="viewport" ref={hostRef} />

      {!bootGone && (
        <div className={`boot ${booted ? 'reveal' : ''}`}>
          <div className="boot-haze" aria-hidden />
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
            <div className="boot-hint">{bootText}</div>
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
        inWater={pose.inWater}
        underwater={pose.underwater}
        device={device}
        hidden={mode !== 'playing'}
        grid={grid}
        gen={gen}
        onOpenMap={() => setMode('map')}
        onOpenHelp={() => setMode('help')}
        onOpenSettings={() => setMode('settings')}
        onOpenGenerate={() => setMode('generate')}
        onDash={() => gameRef.current?.requestDash()}
        onJump={() => gameRef.current?.requestJump()}
        onDive={(v) => gameRef.current?.requestDive(v)}
      />

      {/* while a region is being made: the turning white ring, the bar the stamina pill is
          drawn with, and a cancel — hung right above the square being opened, so it is
          clear which piece of ground the progress belongs to */}
      {gen && gen.active && (
        <GenCard
          progress={gen.progress}
          hidden={mode !== 'playing'}
          onCancel={() => gameRef.current?.cancelGenerate()}
        />
      )}

      {mode === 'map' && (
        <WorldMap
          field={gameRef.current?.fieldRef ?? null}
          fog={explored}
          fogSpan={fogSpan}
          fogVersion={fogVersion}
          px={pose.x}
          pz={pose.z}
          yaw={pose.cameraYaw}
          grid={grid}
          bounds={bounds}
          onClose={() => setMode('playing')}
        />
      )}

      {mode === 'help' && <HelpPanel onClose={() => setMode('playing')} />}

      {mode === 'settings' && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setMode('playing')}
          onResetWorld={handleResetWorld}
          onOpenModels={() => setMode('models')}
        />
      )}

      {mode === 'models' && <ModelSettingsPanel onClose={() => setMode('playing')} />}

      {mode === 'generate' && (
        <GeneratePanel aiReady={aiReady} aiChecked={aiChecked} onGenerate={(wish) => void handleGenerate(wish)} onClose={() => setMode('playing')} />
      )}

      {toast && <div className="gen-toast">{toast}</div>}
    </div>
  );
}
