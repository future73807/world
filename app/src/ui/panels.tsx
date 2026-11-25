import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { aiApi, AiConfigPatch, StatusInfo } from '../game/aiClient';
import { IconClose, IconChevron } from './icons';

export interface EngineSettings {
  renderPrecision: number; // device pixel ratio cap
  resolution: number; // internal render scale 0.4–1
  fpsCap: number; // 0 = uncapped
  showFps: boolean;
  shadows: boolean;
  vegetationDensity: 'full' | 'sparse';
  fogDistance: number; // full-occlusion distance
  musicOn: boolean;
  musicVolume: number; // 0–100
  lookSensitivity: number; // 0.4–2.2
  invertY: boolean;
  cameraDistance: number; // resting follow distance
  movementAssist: boolean;
  /** half-angle cone in front of the camera inside which a frontier tile can be opened */
  coneDeg: number; // 30–120
}

export const DEFAULT_SETTINGS: EngineSettings = {
  renderPrecision: 1.5,
  resolution: 1,
  fpsCap: 0,
  showFps: false,
  shadows: true,
  vegetationDensity: 'full',
  fogDistance: 60,
  musicOn: true,
  musicVolume: 45,
  lookSensitivity: 1,
  invertY: false,
  cameraDistance: 7.4,
  movementAssist: false,
  coneDeg: 60,
};

/**
 * Page shell: a WHITE translucent sheet floating over a blurred world. The
 * reference build is white surfaces with dark ink; the earlier dark-teal sheet
 * was the odd one out.
 */
function Page({
  title,
  sub,
  onClose,
  children,
  className = '',
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`page ${className}`} role="dialog" aria-label={title}>
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        {sub && <span className="page-sub">{sub}</span>}
      </div>
      <div className="page-body">{children}</div>
      <button className="close-btn ctl" onClick={onClose} aria-label="关闭">
        <IconClose size={26} />
      </button>
    </div>
  );
}

/* ---------------------------------- settings --------------------------------- */

/**
 * One row: label and explanation side by side on the LEFT, control on the right.
 * The hint used to sit under the label, which made every row two lines tall and
 * pushed the control out of alignment.
 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span className="set-row-name">{label}</span>
        {hint && <small className="set-row-hint">{hint}</small>}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  display: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <span className="slider-val">{display}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--pct' as string]: `${pct}%` }}
      />
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`switch ctl ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

function Seg({ value, options, onChange }: { value: string | number; options: { v: string | number; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={value === o.v ? 'on' : ''} onClick={() => onChange(String(o.v))}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Native dropdown styled into the white pill language (分辨率 uses this). */
function Dropdown({ value, options, onChange }: { value: string | number; options: { v: string | number; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="dropdown">
      <select value={String(value)} onChange={(e) => onChange(e.target.value)} aria-label="选项">
        {options.map((o) => (
          <option key={String(o.v)} value={String(o.v)}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevron size={16} className="dropdown-chev" />
    </div>
  );
}

/** Single-line text field in the white pill language. */
function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
  width = 260,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  width?: number;
  ariaLabel?: string;
}) {
  return (
    <input
      className="text-input ctl"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      style={{ width }}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/** Secondary text button (测试连接 / 自动检测 / 保存). */
function GhostButton({ children, onClick, disabled, primary = false }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button className={`btn-ghost ctl ${primary ? 'primary' : ''}`} onClick={onClick} disabled={disabled} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </button>
  );
}

/** One status line under a control: `kind` picks the colour. */
function StatusLine({ text, kind }: { text: string | null; kind: 'ok' | 'err' | 'info' }) {
  if (!text) return <div className="model-status" />;
  return <div className={`model-status ${kind}`}>{text}</div>;
}

/**
 * Settings (C): one calm WHITE page, every option on a single sheet with real
 * switches, label and explanation side by side, and a confirm dialog for the
 * world reset.
 */
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  onResetWorld,
  onOpenModels,
}: {
  settings: EngineSettings;
  onChange: (s: EngineSettings) => void;
  onClose: () => void;
  onResetWorld: () => void;
  onOpenModels: () => void;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  const set = <K extends keyof EngineSettings>(k: K, v: EngineSettings[K]) => onChange({ ...settings, [k]: v });

  return (
    <Page title="设置" sub="SETTINGS" className="page-settings" onClose={onClose}>
      <div className="set-list single">
        <Row label="渲染精度" hint="像素倍率 · 越高越清晰">
          <Slider
            value={settings.renderPrecision}
            min={0.5}
            max={2}
            step={0.1}
            onChange={(v) => set('renderPrecision', v)}
            display={`${settings.renderPrecision.toFixed(1)}×`}
          />
        </Row>
        <Row label="分辨率" hint="内部渲染分辨率占窗口比例">
          <Dropdown
            value={settings.resolution}
            options={[
              { v: '0.5', label: '50%' },
              { v: '0.75', label: '75%' },
              { v: '1', label: '100%' },
            ]}
            onChange={(v) => set('resolution', Number(v))}
          />
        </Row>
        <Row label="视野距离" hint="浓雾完全遮挡视野的距离 · 50–150">
          <Slider
            value={settings.fogDistance}
            min={50}
            max={150}
            step={1}
            onChange={(v) => set('fogDistance', v)}
            display={`${settings.fogDistance} BU`}
          />
        </Row>
        <Row label="开拓扇形" hint="镜头前方多少度以内的迷雾格子可以按 E 开拓">
          <Slider
            value={settings.coneDeg}
            min={30}
            max={120}
            step={5}
            onChange={(v) => set('coneDeg', v)}
            display={`${settings.coneDeg}°`}
          />
        </Row>
        <Row label="模型与 AI" hint="AI 的接口、模型名与 Key · Blender 路径 · 预制模型库">
          <button className="btn-reset ctl" onClick={onOpenModels}>
            配置
          </button>
        </Row>
        <Row label="植被密度" hint="稀疏模式隐藏远景植被，更流畅">
          <Seg
            value={settings.vegetationDensity}
            options={[
              { v: 'full', label: '完整' },
              { v: 'sparse', label: '稀疏' },
            ]}
            onChange={(v) => set('vegetationDensity', v as 'full' | 'sparse')}
          />
        </Row>
        <Row label="阴影" hint="角色与植被的接触阴影">
          <Toggle on={settings.shadows} onChange={(v) => set('shadows', v)} />
        </Row>
        <Row label="帧率上限" hint="限制上限可以降低发热">
          <Seg
            value={settings.fpsCap}
            options={[
              { v: 30, label: '30' },
              { v: 60, label: '60' },
              { v: 120, label: '120' },
              { v: 0, label: '不限' },
            ]}
            onChange={(v) => set('fpsCap', Number(v))}
          />
        </Row>
        <Row label="显示帧率" hint="在画面左下角显示">
          <Toggle on={settings.showFps} onChange={(v) => set('showFps', v)} />
        </Row>
        <Row label="环境音乐" hint="轻快的合成小调，随音量淡入">
          <Toggle on={settings.musicOn} onChange={(v) => set('musicOn', v)} />
        </Row>
        <Row label="音量" hint="0–100">
          <Slider
            value={settings.musicVolume}
            min={0}
            max={100}
            onChange={(v) => set('musicVolume', v)}
            display={`${settings.musicVolume}`}
          />
        </Row>
        <Row label="重置世界" hint="换一个种子重新生成，迷雾与地图一起清空">
          <button className="btn-reset ctl" onClick={() => setConfirmReset(true)}>
            重置
          </button>
        </Row>
      </div>

      {confirmReset &&
        // on the document body, not inside the page: the page's blur makes it the
        // containing block for fixed children, so an overlay inside it would only
        // ever cover part of the window
        createPortal(
          <div className="confirm-overlay" role="alertdialog" aria-label="确认重置世界">
            <div className="confirm-card">
              <h3>重置世界？</h3>
              <div className="confirm-actions">
                <button className="confirm-cancel ctl" onClick={() => setConfirmReset(false)}>
                  取消
                </button>
                <button
                  className="confirm-ok ctl"
                  onClick={() => {
                    setConfirmReset(false);
                    onResetWorld();
                  }}
                >
                  确认重置
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Page>
  );
}

/* ----------------------------------- help ----------------------------------- */

const KEY_ROWS: [string, string][] = [
  ['W A S D', '移动（相对镜头）'],
  ['鼠标', '环视，左右 360°'],
  ['滚轮', '推近 / 拉远镜头'],
  ['空格', '跳跃；在水里跃出水面'],
  ['右键 / Shift', '奔跑，消耗体力'],
  ['按住 F / X', '下潜（水里）'],
  ['点击体力条', '冲刺一小段'],
  ['E', '在迷雾边缘开拓'],
  ['M', '全屏地图'],
  ['I', '这本手册'],
  ['C', '设置'],
  ['Esc', '合上当前页面'],
];

/** A drawn island under a bank of mist: the plate on the book's first page. */
function WorldPlate() {
  return (
    <svg className="book-plate" viewBox="0 0 420 232" role="img" aria-label="雾中的群岛">
      <defs>
        <linearGradient id="hpSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#cde9f3" />
          <stop offset="0.55" stopColor="#eaf6f7" />
          <stop offset="1" stopColor="#f7f1e2" />
        </linearGradient>
        <linearGradient id="hpFar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9fc3b4" />
          <stop offset="1" stopColor="#7fa893" />
        </linearGradient>
        <linearGradient id="hpMid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8dbb8b" />
          <stop offset="1" stopColor="#5f9268" />
        </linearGradient>
        <linearGradient id="hpNear" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b7d38a" />
          <stop offset="1" stopColor="#79a55e" />
        </linearGradient>
        <linearGradient id="hpSea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9dcd8" />
          <stop offset="1" stopColor="#77bcc6" />
        </linearGradient>
        <linearGradient id="hpMist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="420" height="232" fill="url(#hpSky)" />
      {/* the sun, low and pale */}
      <circle cx="336" cy="54" r="26" fill="#fff6d8" opacity="0.9" />
      <circle cx="336" cy="54" r="40" fill="#fff6d8" opacity="0.25" />
      {/* far isles */}
      <path d="M0 150c26-26 48-30 74-22 18 6 30 20 44 22H0Z" fill="url(#hpFar)" opacity="0.75" />
      <path d="M330 148c20-18 44-22 64-14 12 5 20 10 26 14Z" fill="url(#hpFar)" opacity="0.6" />
      {/* the sea */}
      <path d="M0 158h420v74H0Z" fill="url(#hpSea)" />
      <g stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" fill="none">
        <path d="M28 196q14-6 28 0t28 0" />
        <path d="M96 210q12-5 24 0t24 0" />
        <path d="M300 200q14-6 28 0t28 0" />
        <path d="M352 216q12-5 24 0t24 0" />
      </g>
      {/* the island in the middle: two hills, a wood, a beach */}
      <path d="M74 158c10-30 30-52 62-60 26-6 54 2 74 16 18 12 34 26 40 44Z" fill="url(#hpMid)" />
      <path d="M40 158c14-16 34-26 58-28 18-1 34 4 46 12 10 6 16 10 22 16Z" fill="url(#hpNear)" />
      <path d="M238 158c8-14 20-24 38-26 20-2 38 6 50 26Z" fill="url(#hpNear)" opacity="0.92" />
      <path d="M212 158h124l-12 8H224Z" fill="#f0e4c2" />
      <path d="M232 150c14-4 30-4 44 0l-6 8h-32Z" fill="#f6edd4" />
      {/* pines on the ridge */}
      <g fill="#3f6f57">
        <path d="M132 100l10 22h-20Z" />
        <path d="M132 90l8 16h-16Z" />
        <path d="M152 108l9 20h-18Z" />
        <path d="M112 112l8 18h-16Z" />
      </g>
      <g fill="#4c7d5f" opacity="0.9">
        <path d="M180 116l8 18h-16Z" />
        <path d="M168 122l7 15h-14Z" />
      </g>
      {/* a slime on the beach, small and unmistakable */}
      <ellipse cx="268" cy="152" rx="11" ry="3" fill="#3c6f74" opacity="0.25" />
      <path d="M258 152c0-8 4-13 10-13s10 5 10 13Z" fill="#63d3de" />
      <path d="M258 152c0-8 4-13 10-13s10 5 10 13Z" fill="#ffffff" opacity="0.25" />
      <circle cx="265" cy="145" r="1.8" fill="#1d5d68" />
      <circle cx="272" cy="145" r="1.8" fill="#1d5d68" />
      {/* the mist, gathering at the edges of the known world */}
      <path d="M0 112c40-14 66 4 96-8 28-11 52-10 74 2 20 10 40 8 58-4 22-14 48-10 68 4 18 12 40 10 60-4 18-12 42-10 64 2v52H0Z" fill="url(#hpMist)" opacity="0.75" />
      <path d="M0 30c34 8 52-6 82-2 26 3 44 12 70 8 24-3 40-12 64-8 26 5 40 16 66 12 22-3 38-14 62-10 26 4 44 14 76 8v26c-30 6-48-4-74-8-26-3-42 8-64 10-28 3-44-8-68-12-22-4-38 6-62 8-26 2-44-8-68-10-28-2-46 8-74 2Z" fill="#ffffff" opacity="0.6" />
      {/* a compass rose in the corner, drawn thin */}
      <g transform="translate(40 48)" stroke="#6b8f96" strokeWidth="1.1" fill="none" opacity="0.65">
        <circle r="13" />
        <path d="M0 -17V17M-17 0H17" />
        <path d="M0 -17 4 -4 0 0 -4 -4Z" fill="#6b8f96" stroke="none" />
      </g>
    </svg>
  );
}

/**
 * Help (I): a bound book, four pages. A sheet turns over the spine in 3D, so the
 * close mark lives ON the page and turns away with it; the next page brings its own.
 */
export function HelpPanel({ onClose }: { onClose: () => void }) {
  const [flipped, setFlipped] = useState(0);
  const [turn, setTurn] = useState<{ sheet: number; back: boolean } | null>(null);
  const sheets = 2;
  const flip = (dir: 1 | -1) => {
    setFlipped((f) => {
      const next = Math.max(0, Math.min(sheets, f + dir));
      if (next !== f) {
        setTurn({ sheet: dir === 1 ? f : next, back: dir === -1 });
        window.setTimeout(() => setTurn(null), 940);
      }
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') flip(-1);
      else if (e.code === 'KeyD' || e.code === 'ArrowRight') flip(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pageNo = (n: number) => <div className="folio">{n}</div>;
  const cross = (
    <button className="book-cross ctl" onClick={onClose} aria-label="关闭帮助">
      <IconClose size={20} />
    </button>
  );

  const sheetDefs = [
    {
      front: (
        <>
          {pageNo(1)}
          <div className="book-kicker">世界</div>
          <h3 className="book-h">被浓雾围住的群岛</h3>
          <p className="book-lead">雾之外不是空无一物——每一片迷雾下，都躺着一座还没被记录的岛。</p>
          <WorldPlate />
          <p className="book-p tight">你在一片浮岛上醒来。大地一直在那里，气候从北往南慢慢变冷，森林会先稀疏成草原，再渐渐变成荒漠；雾只是挡住了视线。走到雾的边缘，把愿望交给迷雾，被藏起的那一角就会升起，与你脚下的岸连成一片。</p>
          {cross}
        </>
      ),
      back: (
        <>
          {pageNo(2)}
          <div className="book-kicker">操作</div>
          <h3 className="book-h">怎么走，怎么看</h3>
          <p className="book-lead">键鼠与触屏共用同一套操作。</p>
          <div className="book-keys">
            {KEY_ROWS.map(([k, v]) => (
              <div className="book-key-row" key={k}>
                <span className="book-key">{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </>
      ),
    },
    {
      front: (
        <>
          {pageNo(3)}
          <div className="book-kicker">基础玩法</div>
          <h3 className="book-h">开拓迷雾</h3>
          <p className="book-p">站到还没有开拓的格子边上（边境 10 BU 以内），让镜头朝着它：那一格会在海面上显出白色线框，并浮出「E 开拓迷雾」。按 E，许下愿望，或者留空让迷雾自己决定。</p>
          <p className="book-p">确认之后，迷雾会读出四周的地形、名字与植被，设计出这块地：地貌、地势、种什么。一时说不清的地方，它会请 Blender 在后台现造几个模型。地面从雾里升起，草木从你这一侧一波一波长出来。</p>
          <p className="book-p">这一片地如果比一格大（一道山脊、一圈环礁），AI 会自己说明需要几格，周围的格子会沿用同一份设定一起升起，不会被格子边切断。</p>
          <div className="book-note">
            <b>生成中</b>
            <span>画面下方是进度与「取消」。取消会连同服务端正在思考的模型和后台的 Blender 一起停下。</span>
          </div>
          {cross}
        </>
      ),
      back: (
        <>
          {pageNo(4)}
          <div className="book-kicker">基础玩法</div>
          <h3 className="book-h">大地、体力与水面</h3>
          <p className="book-p">按 M 打开全屏地图：拖动平移，滚轮缩放。地图最多只能挪到已探索范围的两倍，再远就是还没见过的雾。蓝色箭头永远停在你真实的位置；走近的雾会散开，海岸线跟着显出来。</p>
          <p className="book-p">奔跑消耗体力，体力见底会回到步行，停下就能缓过来；点一下体力条可以冲刺一小段。水比陆地慢，却走得远：踩进深水会浮起来，按住 F 或 X 下潜，空格从水面跃出。在水下，体力条就是你的那口气。</p>
          <p className="book-p">树干与巨石是实心的，贴着走能绕开；石拱的两只脚也是，门洞可以从中间穿过去。</p>
          <div className="book-note">
            <b>存档</b>
            <span>开拓过的区域会连同新造的模型一起存在这台机器上，刷新页面原样回来。想换一座岛，在设置里重置世界。</span>
          </div>
          {cross}
        </>
      ),
    },
  ];

  return (
    <div className="book-overlay" role="dialog" aria-label="帮助">
      <div className="book">
        <div className="book-board left">
          <div className="board-inner">
            <span className="board-kicker">旅人手册</span>
            <h2 className="board-title">迷雾群岛</h2>
            <div className="board-rule" />
            <p className="board-sub">风与雾的形状 · 第一版</p>
            <svg className="board-emblem" viewBox="0 0 120 120" aria-hidden>
              <circle cx="60" cy="60" r="42" fill="none" stroke="#c3b394" strokeWidth="1.2" />
              <circle cx="60" cy="60" r="33" fill="none" stroke="#d8cbb0" strokeWidth="0.7" />
              <path d="M60 18 70 52 104 60 70 68 60 102 50 68 16 60 50 52Z" fill="#f4ecd9" stroke="#b9a887" strokeWidth="1.1" />
              <circle cx="60" cy="60" r="4.5" fill="#b9a887" />
            </svg>
            <span className="board-hint">← → 翻页</span>
          </div>
        </div>
        <div className="book-board right">
          <div className="board-inner back-cover">
            <span className="board-kicker">已经翻到最后一页</span>
            <div className="board-rule" />
            <span className="board-hint">← 往回翻</span>
            {cross}
          </div>
        </div>

        {sheetDefs.map((sheet, i) => {
          const isFlipped = i < flipped;
          const z = turn?.sheet === i ? 300 : isFlipped ? 10 + i : 100 - i;
          const turning = turn?.sheet === i;
          return (
            <div
              key={i}
              className={`sheet ${isFlipped ? 'flipped' : ''} ${turning ? (turn!.back ? 'turning back' : 'turning') : ''}`}
              style={{ zIndex: z }}
            >
              <div className="sheet-face front">{sheet.front}</div>
              <div className="sheet-face back">{sheet.back}</div>
            </div>
          );
        })}

        {flipped > 0 && (
          <button className="book-arrow left ctl" onClick={() => flip(-1)} aria-label="上一页">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 5 8 12l6.5 7" />
            </svg>
          </button>
        )}
        {flipped < sheets && (
          <button className="book-arrow right ctl" onClick={() => flip(1)} aria-label="下一页">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 5 16 12l-6.5 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- generate --------------------------------- */

const STAGE_LABEL: Record<string, string> = {
  request: '提交愿望',
  queue: '排队中',
  ai: 'AI 构思中',
  blender: 'Blender 建模中',
  export: '导出资源',
  models: '载入新模型',
  terrain: '地形升起',
  reveal: '浓雾散开',
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

/**
 * Region generation (E): a small wish dialog over the blurred world. One line says
 * what an empty wish does; when no model is configured a second line says so,
 * because the local recipe can only follow keywords.
 */
export function GeneratePanel({
  onGenerate,
  onClose,
  aiReady,
  aiChecked,
}: {
  onGenerate: (wish: string) => void;
  onClose: () => void;
  /** a model endpoint is configured on the local server */
  aiReady: boolean;
  /** the server has answered at least once, so `aiReady` means something */
  aiChecked: boolean;
}) {
  const [wish, setWish] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    onGenerate(wish.trim());
    onClose();
  };

  return (
    <div className="wish-overlay" role="dialog" aria-label="开拓迷雾">
      <div className="wish-dialog">
        <h2 className="wish-title">许下你的愿望</h2>
        <p className="wish-sub">留空则让迷雾自动生成</p>
        {aiChecked && !aiReady && <p className="wish-sub">当前未配置ai模型，可能生成效果差</p>}

        <input
          ref={inputRef}
          className="wish-input ctl"
          placeholder="例如：一片会发光的蘑菇沼泽……"
          value={wish}
          onChange={(e) => setWish(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
          maxLength={40}
        />

        <div className="wish-actions">
          <button className="wish-dismiss ctl" onClick={onClose} aria-label="取消">
            取消
          </button>
          <button className="wish-submit ctl" onClick={submit}>
            确认开拓
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- models ---------------------------------- */

type Line = { text: string; kind: 'ok' | 'err' | 'info' } | null;

/** Windows paths read the same with either slash and in any case. */
const normPath = (p: string) => p.split('/').join(String.fromCharCode(92)).toLowerCase();

/** The server remembers the last connection test; show it as one line. */
const probeLine = (ai: StatusInfo['ai']): Line =>
  ai.probe
    ? ai.probe.ok
      ? { text: `上次测试：${ai.model} · ${ai.probe.latency_ms}ms`, kind: 'ok' }
      : { text: `上次测试失败：${ai.probe.error ?? '无响应'}`, kind: 'err' }
    : null;

/**
 * 模型与 AI: the one endpoint that designs new regions — its address, the model
 * name and a key that is stored on the local server, never in the browser — plus
 * whether Blender may be called for new models, where Blender is, and what the
 * prefab library contains.
 */
export function ModelSettingsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [form, setForm] = useState({ base_url: '', model: '', key: '' });
  const [busy, setBusy] = useState(false);
  const [testLine, setTestLine] = useState<Line>(null);
  const [blenderPath, setBlenderPath] = useState('');
  const [blenderLine, setBlenderLine] = useState<Line>(null);
  /** the player is typing in the form or the Blender path: a status refresh must not overwrite it */
  const formDirty = useRef(false);
  const pathDirty = useRef(false);

  const ai = status?.ai;

  const applyStatus = useCallback((s: StatusInfo, syncForm: boolean) => {
    setStatus(s);
    if (!pathDirty.current) setBlenderPath(s.blender?.path ?? '');
    setBlenderLine(
      s.blender?.available
        ? { text: `已找到 Blender ${s.blender.version}`, kind: 'ok' }
        : { text: '未找到 Blender：开拓时 AI 只能使用现有模型', kind: 'err' },
    );
    // after a save the form shows what was saved; otherwise only while nobody is typing in it
    if (syncForm || !formDirty.current) {
      formDirty.current = false;
      setForm({ base_url: s.ai.base_url, model: s.ai.model, key: '' });
    }
    setTestLine(probeLine(s.ai));
  }, []);

  const load = useCallback(async () => {
    try {
      applyStatus(await aiApi.status(), false);
      setOffline(null);
    } catch (e) {
      setOffline(e instanceof Error ? e.message : String(e));
    }
  }, [applyStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const put = useCallback(
    async (patch: AiConfigPatch, syncForm = false) => {
      try {
        applyStatus(await aiApi.saveConfig(patch), syncForm);
        return true;
      } catch (e) {
        setTestLine({ text: `保存失败：${e instanceof Error ? e.message : String(e)}`, kind: 'err' });
        return false;
      }
    },
    [applyStatus],
  );

  const edit = (v: Partial<typeof form>) => {
    formDirty.current = true;
    setForm((f) => ({ ...f, ...v }));
  };

  const save = () =>
    put(
      {
        base_url: form.base_url.trim(),
        model: form.model.trim(),
        // an empty field keeps the stored key
        ...(form.key.trim() ? { key: form.key.trim() } : {}),
      },
      true,
    );

  const test = async () => {
    setBusy(true);
    setTestLine({ text: '正在连接…', kind: 'info' });
    try {
      // test what is in the form, not what was saved earlier
      if (!(await save())) return;
      const r = await aiApi.test();
      setTestLine({ text: r.ok ? `${r.model} · ${r.latency_ms}ms` : `失败：${r.message}`, kind: r.ok ? 'ok' : 'err' });
      await load();
    } catch (e) {
      setTestLine({ text: `失败：${e instanceof Error ? e.message : String(e)}`, kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const detectBlender = async () => {
    setBusy(true);
    pathDirty.current = false;
    setBlenderLine({ text: '正在检测…', kind: 'info' });
    try {
      const asked = blenderPath.trim();
      const b = await aiApi.setBlender(asked);
      setBlenderPath(b.path);
      // the server falls back to a Blender it finds by itself: say so instead of
      // quietly showing a path the player never typed
      const fellBack = !!asked && !!b.path && normPath(asked) !== normPath(b.path);
      setBlenderLine(
        !b.available
          ? { text: '没有找到可用的 blender.exe', kind: 'err' }
          : fellBack
            ? { text: `这个路径不可用，已改用自动找到的 Blender ${b.version}`, kind: 'err' }
            : { text: `已找到 Blender ${b.version}`, kind: 'ok' },
      );
      // sync the rest of the page from this answer; load() would recompute the
      // line and drop the note about the path that was not used
      setStatus((prev) => (prev ? { ...prev, blender: b } : prev));
    } catch (e) {
      setBlenderLine({ text: `检测失败：${e instanceof Error ? e.message : String(e)}`, kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="模型与 AI" sub="MODELS" className="page-settings page-models" onClose={onClose}>
      {offline && (
        <div className="model-offline">
          连不上本地服务（{offline}）。请用 <code>npm run dev</code> 启动游戏——它会同时启动 AI 与 Blender 所需的本地服务端；没有服务端时开拓功能不可用。
        </div>
      )}

      <div className="set-list single">
        <Row label="接口地址" hint="OpenAI 兼容接口的 Base URL">
          <TextInput value={form.base_url} onChange={(v) => edit({ base_url: v })} placeholder="https://…/v1" ariaLabel="接口地址" width={410} />
        </Row>
        <Row label="模型名称" hint="这家服务商下的模型 ID">
          <TextInput
            value={form.model}
            onChange={(v) => edit({ model: v })}
            placeholder="例如 glm-4.6 / gpt-4o-mini / deepseek-chat"
            ariaLabel="模型名称"
            width={320}
          />
        </Row>
        <Row label="API Key" hint={ai?.has_key ? `已保存 ····${ai.key_hint}，留空不变` : '只保存在本机服务端'}>
          <div className="model-inline">
            <TextInput value={form.key} onChange={(v) => edit({ key: v })} type="password" placeholder="粘贴你的 Key" ariaLabel="API Key" width={320} />
            {/* an empty field means "keep the stored key", so forgetting it needs its own button */}
            {ai?.has_key && (
              <GhostButton
                onClick={() => {
                  formDirty.current = false;
                  setForm((f) => ({ ...f, key: '' }));
                  void put({ key: null });
                }}
                disabled={busy}
              >
                清除
              </GhostButton>
            )}
          </div>
        </Row>
        <Row label="保存与测试" hint="测试会先保存，再发一条最短请求">
          <div className="model-inline">
            <GhostButton onClick={() => void save()} disabled={busy}>
              保存
            </GhostButton>
            <GhostButton onClick={() => void test()} disabled={busy} primary>
              测试连接
            </GhostButton>
          </div>
        </Row>
        <div className="set-row set-row-status">
          <StatusLine text={testLine?.text ?? null} kind={testLine?.kind ?? 'info'} />
        </div>
        <Row label="开拓时使用 AI" hint="关闭则一律使用本地配方">
          <Toggle on={!!ai?.enabled} onChange={() => void put({ enabled: !ai?.enabled })} />
        </Row>
        <Row label="允许调用 Blender" hint="AI 需要库里没有的模型时由 Blender 后台建模">
          <Toggle on={!!status?.allow_blender} onChange={() => void put({ allow_blender: !(status?.allow_blender ?? false) })} />
        </Row>

        <div className="model-section">Blender</div>
        <Row label="Blender 路径" hint="留空则自动查找 blender.exe">
          <div className="model-inline">
            <TextInput
              value={blenderPath}
              onChange={(v) => {
                pathDirty.current = true;
                setBlenderPath(v);
              }}
              placeholder="自动检测"
              ariaLabel="Blender 路径"
              width={320}
            />
            <GhostButton onClick={() => void detectBlender()} disabled={busy}>
              {blenderPath.trim() ? '使用此路径' : '自动检测'}
            </GhostButton>
          </div>
        </Row>
        <div className="set-row set-row-status">
          <StatusLine text={blenderLine?.text ?? null} kind={blenderLine?.kind ?? 'info'} />
        </div>

        <div className="model-section">预制模型库</div>
        <Row label="Blender 预制模型" hint="源文件 world/prefabs.blend">
          <span className="model-fact">{status ? `${status.catalog} 个模型` : offline ? '—' : '读取中…'}</span>
        </Row>
        <Row label="出生岛地形" hint="由 world/terrain.blend 导出">
          <span className="model-fact">terrain.blend → birth.glb</span>
        </Row>
      </div>
    </Page>
  );
}
