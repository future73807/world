import { useEffect, useRef } from 'react';
import { Minimap } from './Minimap';
import { IconGearGlyph, IconHelpGlyph, IconMapGlyph } from './icons';

interface HudProps {
  minimapSource: HTMLCanvasElement | null;
  exploredSource: HTMLCanvasElement | null;
  fogVersion: number;
  px: number;
  pz: number;
  cameraYaw: number;
  stamina: number;
  device: 'kbm' | 'touch';
  /** true whenever a page owns the screen */
  hidden?: boolean;
  onOpenMap: () => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  onOpenGenerate: () => void;
  /** stamina bar click: a short dash */
  onDash: () => void;
}

/**
 * World-first HUD. Everything here is white: a glass minimap disc top-left, three
 * icon-pack marks top-right in one shared slot height (equal optical size, one
 * centre line, one capital-letter row beneath), and a white stamina pill that is
 * also the dash button.
 */
export function Hud({
  minimapSource, exploredSource, fogVersion, px, pz, cameraYaw, stamina, device,
  hidden, onOpenMap, onOpenHelp, onOpenSettings, onOpenGenerate, onDash,
}: HudProps) {
  return (
    <div className={`hud ${hidden ? 'hidden' : ''}`}>
      <div className="minimap-wrap">
        <div className="orb">
          <Minimap
            size={272}
            source={minimapSource}
            explored={exploredSource}
            fogVersion={fogVersion}
            px={px}
            pz={pz}
            yaw={cameraYaw}
          />
          <div className="orb-haze" />
          <div className="orb-glass" />
          <span className="orb-north">N</span>
        </div>
      </div>

      {/* one slot per mark: identical icon box, identical caption baseline */}
      <div className="top-right">
        <button className="glyph-btn ctl" onClick={onOpenMap} aria-label="地图 (M)" title="地图 (M)">
          <span className="glyph-slot"><IconMapGlyph size={27} /></span>
          <span className="kb">M</span>
        </button>
        <button className="glyph-btn ctl" onClick={onOpenHelp} aria-label="帮助 (I)" title="帮助 (I)">
          <span className="glyph-slot"><IconHelpGlyph size={27} /></span>
          <span className="kb">I</span>
        </button>
        <button className="glyph-btn ctl" onClick={onOpenSettings} aria-label="设置 (C)" title="设置 (C)">
          <span className="glyph-slot"><IconGearGlyph size={27} /></span>
          <span className="kb">C</span>
        </button>
      </div>

      <StaminaRibbon stamina={stamina} onDash={onDash} />
      <MistMarker onOpen={onOpenGenerate} device={device} />
    </div>
  );
}

/**
 * The E prompt sits on the mist edge in world space: the engine projects the
 * point every frame into `__mistIsles.mistPrompt`, and this component paints it
 * at full frame rate without re-rendering React.
 */
function MistMarker({ onOpen, device }: { onOpen: () => void; device: 'kbm' | 'touch' }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = (window as unknown as { __mistIsles?: { mistPrompt: MistPromptState } }).__mistIsles;
      const el = ref.current;
      if (g && el) {
        const p = g.mistPrompt;
        if (p.visible) {
          el.style.opacity = '1';
          el.style.pointerEvents = 'auto';
          el.style.transform = `translate(0, -50%) translate(${p.x + 34}px, ${p.y}px)`;
        } else {
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // reference shape: a key cap and the action name, nothing else
  return (
    <button ref={ref} className="mist-marker ctl" onClick={onOpen} aria-label="开拓迷雾 (E)" title="开拓迷雾 (E)">
      <span className="mist-key">{device === 'kbm' ? 'E' : '!'}</span>
      <span className="mist-label">开拓迷雾</span>
    </button>
  );
}

interface MistPromptState {
  x: number;
  y: number;
  visible: boolean;
  inRange: boolean;
  dist: number;
}

/**
 * Stamina pill above the slime's crown. White, and clickable: the click spends
 * stamina on a short forward dash (see Player.dash). The fill runs from bright
 * white at full to a pale blue when nearly empty — the inverted reading of the
 * old dark teal track.
 */
function StaminaRibbon({ stamina, onDash }: { stamina: number; onDash: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = (window as unknown as { __mistIsles?: { staminaHud: MistPromptState } }).__mistIsles;
      const el = ref.current;
      if (g && el) {
        const s = g.staminaHud;
        el.style.opacity = s.visible ? '1' : '0';
        el.style.pointerEvents = s.visible ? 'auto' : 'none';
        el.style.transform = `translate(-50%, -100%) translate(${s.x}px, ${s.y}px)`;
        const fill = fillRef.current;
        if (fill) fill.style.transform = `scaleX(${Math.max(0.03, stamina)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stamina]);
  return (
    <div
      ref={ref}
      className="stamina-ribbon ctl"
      role="button"
      tabIndex={-1}
      aria-label="冲刺（点击消耗少量体力）"
      title="点击冲刺"
      onPointerDown={(e) => {
        // never let the click fall through to the canvas: that would request
        // pointer lock and eat the press
        e.stopPropagation();
        e.preventDefault();
        onDash();
      }}
    >
      <i ref={fillRef} />
    </div>
  );
}
