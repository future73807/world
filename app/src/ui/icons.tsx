import {
  Map,
  CircleHelp,
  Settings,
  X,
  Eye,
  Compass,
  Plus,
  Minus,
  Navigation,
  Target,
  MousePointer,
  Waves,
  ArrowUp,
  Zap,
  Crosshair,
  Volume2,
  ChevronDown,
  Check,
  TriangleAlert,
  Sun,
  Droplet,
  BookOpen,
  SlidersHorizontal,
  Sparkles,
  Route,
  Footprints,
} from 'lucide-react';

/**
 * Icon set. Every UI mark now comes from one icon library (lucide) at one stroke
 * weight, so nothing is hand-drawn and nothing has its own house style.
 *
 * Optical sizing is handled explicitly: a circle or a gear reads bigger than a
 * folded map at the same pixel box, so each glyph carries a small scale
 * correction and the HUD lays them out in a fixed-height slot. That is what makes
 * the three top-right marks the same height and sit on one centre line.
 */
type P = { size?: number; className?: string };

const hudIcon = (Icon: typeof Map, optical = 1, strokeWidth = 2) =>
  function HudGlyph({ size = 26, className }: P) {
    const s = Math.round(size * optical);
    return (
      <Icon
        size={s}
        strokeWidth={strokeWidth}
        className={className}
        absoluteStrokeWidth
        aria-hidden
      />
    );
  };

/** Map: folded chart. */
export const IconMapGlyph = hudIcon(Map, 1.06, 1.9);
/** Help: circled question mark — scaled down so its round mass matches the gear. */
export const IconHelpGlyph = hudIcon(CircleHelp, 0.98, 2);
/** Settings: gear with an open hub. */
export const IconGearGlyph = hudIcon(Settings, 1.04, 1.9);

/** The one close mark: the icon pack's X, used by every page and the book. */
export const IconClose = ({ size = 26, className }: P) => (
  <X size={size} strokeWidth={2.1} className={className} absoluteStrokeWidth aria-hidden />
);

export const IconBook = ({ size, className }: P) => (
  <BookOpen size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconSliders = ({ size, className }: P) => (
  <SlidersHorizontal size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconSparkles = ({ size, className }: P) => (
  <Sparkles size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconRoute = ({ size, className }: P) => (
  <Route size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconFootprints = ({ size, className }: P) => (
  <Footprints size={size} strokeWidth={1.8} className={className} aria-hidden />
);

export const IconMap = ({ size, className }: P) => (
  <Map size={size} strokeWidth={1.7} className={className} aria-hidden />
);
export const IconEyeGlyph = ({ size, className }: P) => (
  <Eye size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconCompassGlyph = ({ size, className }: P) => (
  <Compass size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconPlus = ({ size, className }: P) => (
  <Plus size={size} strokeWidth={2} className={className} aria-hidden />
);
export const IconMinus = ({ size, className }: P) => (
  <Minus size={size} strokeWidth={2} className={className} aria-hidden />
);
export const IconPlayer = ({ size, className }: P) => (
  <Navigation size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconTarget = ({ size, className }: P) => (
  <Target size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconPointer = ({ size, className }: P) => (
  <MousePointer size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconMist = ({ size, className }: P) => (
  <Waves size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconJump = ({ size, className }: P) => (
  <ArrowUp size={size} strokeWidth={2} className={className} aria-hidden />
);
export const IconDash = ({ size, className }: P) => (
  <Zap size={size} strokeWidth={1.9} className={className} aria-hidden />
);
export const IconInteract = ({ size, className }: P) => (
  <Crosshair size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconGear = ({ size, className }: P) => (
  <Settings size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconSound = ({ size, className }: P) => (
  <Volume2 size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconChevron = ({ size, className }: P) => (
  <ChevronDown size={size} strokeWidth={2} className={className} aria-hidden />
);
export const IconCheck = ({ size, className }: P) => (
  <Check size={size} strokeWidth={2.2} className={className} aria-hidden />
);
export const IconWarn = ({ size, className }: P) => (
  <TriangleAlert size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconSun = ({ size, className }: P) => (
  <Sun size={size} strokeWidth={1.8} className={className} aria-hidden />
);
export const IconDroplet = ({ size, className }: P) => (
  <Droplet size={size} strokeWidth={1.8} className={className} aria-hidden />
);
