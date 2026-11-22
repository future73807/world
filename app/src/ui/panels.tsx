import { useEffect, useRef, useState } from 'react';
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
}: {
  settings: EngineSettings;
  onChange: (s: EngineSettings) => void;
  onClose: () => void;
  onResetWorld: () => void;
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

      {confirmReset && (
        <div className="confirm-overlay" role="alertdialog" aria-label="确认重置世界">
          <div className="confirm-card">
            <h3>重置世界？</h3>
            <p>会用新的种子重新生成整座岛，你走过的迷雾和地图都会清空。</p>
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
        </div>
      )}
    </Page>
  );
}

/* ----------------------------------- help ----------------------------------- */

const KEY_ROWS: [string, string][] = [
  ['W A S D', '移动'],
  ['鼠标移动', '环视（左右 360°）'],
  ['滚轮', '缩放跟随距离'],
  ['空格', '跳跃'],
  ['右键 / Shift', '奔跑（消耗体力）'],
  ['点击体力条', '冲刺一小段距离'],
  ['E', '在迷雾边缘开拓新区域'],
  ['M', '全屏地图'],
  ['I', '帮助'],
  ['C', '设置'],
  ['Esc', '关闭当前页面'],
];

/** Corner flourish: the reference spreads carry fine ruled corners. */
function CornerOrnaments() {
  return (
    <>
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
    </>
  );
}

/**
 * Help (I): a real bound book — two cream vellum pages, a ribbon marker at the
 * spine, ruled corner ornaments and a small drop-cap heading rule, following the
 * reference spreads. Sheets physically turn over the spine in 3D. The close mark
 * is a permanent control on the book itself.
 */
export function HelpPanel({ onClose, exploredPct }: { onClose: () => void; exploredPct: number }) {
  const [flipped, setFlipped] = useState(0);
  const [turning, setTurning] = useState<number | null>(null);
  const sheets = 2;
  const flip = (dir: 1 | -1) => {
    setFlipped((f) => {
      const next = Math.max(0, Math.min(sheets, f + dir));
      if (next !== f) {
        setTurning(dir === 1 ? f : next);
        window.setTimeout(() => setTurning(null), 800);
      }
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyA') flip(-1);
      else if (e.code === 'KeyD') flip(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sheetDefs = [
    {
      front: (
        <>
          <CornerOrnaments />
          <div className="folio">i</div>
          <h3 className="book-h">操作</h3>
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
      back: (
        <>
          <CornerOrnaments />
          <div className="folio">ii</div>
          <h3 className="book-h">世界</h3>
          <p className="book-p">你在一片被浓雾包围的浮岛上醒来。雾之外并不是空无一物 —— 每一片迷雾下都藏着一座还没被记录的岛。</p>
          <p className="book-p">走到雾缘，出现「开拓迷雾」后按下 E：许下愿望，新的岛会从雾里升起，与你脚下的岸连成一片。接壤处会被填平成一条宽阔的通路，可以直接走过去。</p>
          <div className="book-figure">
            <svg className="book-figure-svg" viewBox="0 0 320 120" preserveAspectRatio="xMidYMid slice">
              <defs>
                <linearGradient id="bfIsle" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#a9d9be" />
                  <stop offset="1" stopColor="#6fb595" />
                </linearGradient>
              </defs>
              <rect width="320" height="120" fill="#eef7f9" />
              <g opacity=".5" fill="#ffffff">
                <ellipse cx="60" cy="86" rx="46" ry="16" />
                <ellipse cx="256" cy="82" rx="44" ry="15" />
              </g>
              <path d="M40 80h240l-26 20H66Z" fill="url(#bfIsle)" />
              <path d="M128 80h64l-10 12h-44Z" fill="#8ec8a8" />
              <g stroke="#5c9f85" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".7">
                <path d="M110 76v-14M160 76v-21M210 76v-12" />
              </g>
            </svg>
            <span>雾线之外，新的岛正在成形</span>
          </div>
        </>
      ),
    },
    {
      front: (
        <>
          <CornerOrnaments />
          <div className="folio">iii</div>
          <h3 className="book-h">手册</h3>
          <p className="book-p">打开全屏地图（M）：拖动平移、滚轮缩放，蓝色箭头永远停在你真实所在的位置；发白的地方是还没走过的路，走近就会散开。</p>
          <p className="book-p">地形分为中央草甸、向阳的金色灌木坡与高处偏冷的苔原。树与巨石是实心的，贴着走就能绕开。</p>
          <p className="book-p">想换一座岛，在设置里点「重置」；确认后旧地图与迷雾一起清空。</p>
          <p className="book-p">奔跑会消耗体力，体力耗尽回到步行——停下来喘口气就能恢复；点击体力条可以冲刺一小段。</p>
        </>
      ),
      back: (
        <>
          <CornerOrnaments />
          <div className="folio">iv</div>
          <h3 className="book-h">探索</h3>
          <div className="book-progress">
            <span>探索进度</span>
            <div className="book-progress-track">
              <i style={{ width: `${Math.max(3, exploredPct * 100)}%` }} />
            </div>
            <b>{Math.round(exploredPct * 100)}%</b>
          </div>
          <div className="book-tips">
            <h4>小提示</h4>
            <p>想让地图更完整，就沿着海岸线多走一段；浓雾散开的地方，就是你去过的证明。</p>
          </div>
          <svg className="book-emblem" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="40" fill="none" stroke="#b8c9d4" strokeWidth="2" />
            <path d="M60 18 70 52 104 60 70 68 60 102 50 68 16 60 50 52Z" fill="#dfeef5" stroke="#9fb8c6" strokeWidth="1.5" />
            <circle cx="60" cy="60" r="5" fill="#8fb3c4" />
          </svg>
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
            <p className="board-sub">第一版 · 记载风与雾的形状</p>
            <svg className="board-emblem" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="42" fill="none" stroke="#c3b394" strokeWidth="1.4" />
              <circle cx="60" cy="60" r="34" fill="none" stroke="#d8cbb0" strokeWidth="0.8" />
              <path d="M60 16 71 51 106 60 71 69 60 104 49 69 14 60 49 51Z" fill="#f4ecd9" stroke="#b9a887" strokeWidth="1.3" />
              <circle cx="60" cy="60" r="5.5" fill="#b9a887" />
            </svg>
          </div>
        </div>
        <div className="book-board right" />

        {/* ribbon marker hanging over the spine */}
        <div className="book-ribbon" aria-hidden>
          <span />
        </div>

        {sheetDefs.map((sheet, i) => {
          const isFlipped = i < flipped;
          const z = turning === i ? 300 : isFlipped ? 10 + i : 100 - i;
          return (
            <div
              key={i}
              className={`sheet ${isFlipped ? 'flipped' : ''} ${turning === i ? 'turning' : ''}`}
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

        {/* always present, never clipped by the page stack */}
        <button className="close-btn book-close ctl" onClick={onClose} aria-label="关闭帮助">
          <IconClose size={24} />
        </button>
      </div>
    </div>
  );
}

/* --------------------------------- generate --------------------------------- */

/**
 * Region generation (E): a small wish dialog over the blurred world. The tip
 * strip explains that an empty wish generates from the surroundings; the wish
 * itself seeds the island.
 */
export function GeneratePanel({
  onGenerate,
  onClose,
  regionCount,
}: {
  onGenerate: (name: string, random: boolean) => void;
  onClose: () => void;
  regionCount: number;
}) {
  const [wish, setWish] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    if (sending) return;
    setSending(true);
    onGenerate(wish.trim(), wish.trim().length === 0);
    onClose();
  };

  return (
    <div className="wish-overlay" role="dialog" aria-label="开拓迷雾">
      <div className="wish-dialog">
        <h2 className="wish-title">许下你的愿望</h2>
        <p className="wish-sub">迷雾会记住你说的每一个字，把它变成一座岛 · 当前 {regionCount} 个区域</p>

        <div className="wish-tip">
          <span className="wish-tip-dot" />
          输入为空将根据周围场景自动生成
        </div>

        <input
          ref={inputRef}
          className="wish-input ctl"
          placeholder="请输入你的愿望……"
          value={wish}
          onChange={(e) => setWish(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            e.stopPropagation();
          }}
          maxLength={16}
        />

        <div className="wish-actions">
          <button className="wish-dismiss ctl" onClick={onClose} aria-label="取消">
            取消
          </button>
          <button className={`wish-submit ctl ${sending ? 'sending' : ''}`} onClick={submit}>
            确认提交
          </button>
        </div>
      </div>
    </div>
  );
}
