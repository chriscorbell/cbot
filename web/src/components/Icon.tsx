import type { CSSProperties } from 'react';
import {
  ArrowDown, ArrowUp, AudioLines, AudioWaveform, Check, ChevronDown, ChevronRight, Circle, Clock, Ellipsis, Eye, File,
  Hash, LayoutGrid, LogIn, Maximize2, Mic, Minimize2, Monitor, MousePointer2, PanelLeft, PanelRight, Paperclip, Pencil,
  Plus, RotateCw, Save, Search, Share, Square, Star, X, type LucideIcon,
} from 'lucide-react';

export type IconName =
  | 'apps' | 'arrow_down' | 'check' | 'chev_down' | 'chev_right' | 'clock' | 'close'
  | 'composer_plus' | 'edit' | 'file' | 'mic' | 'paperclip' | 'plus' | 'record' | 'save'
  | 'search' | 'share' | 'sidebar' | 'sidebar_right' | 'slack' | 'star' | 'voice_a' | 'voice_b'
  | 'arrow_up' | 'stop' | 'more' | 'monitor' | 'refresh'
  | 'eye' | 'pointer' | 'expand' | 'shrink' | 'login';

const MAP: Record<IconName, LucideIcon> = {
  apps: LayoutGrid, arrow_down: ArrowDown, check: Check, chev_down: ChevronDown, chev_right: ChevronRight,
  clock: Clock, close: X, composer_plus: Plus, edit: Pencil, file: File, mic: Mic, paperclip: Paperclip, plus: Plus,
  record: Circle, save: Save, search: Search, share: Share, sidebar: PanelLeft, sidebar_right: PanelRight, slack: Hash, star: Star,
  voice_a: AudioLines, voice_b: AudioWaveform, arrow_up: ArrowUp, stop: Square, more: Ellipsis, monitor: Monitor, refresh: RotateCw,
  eye: Eye, pointer: MousePointer2, expand: Maximize2, shrink: Minimize2, login: LogIn,
};

/** Glyphs filled rather than stroked: they read as solid controls. */
const FILLED = new Set<IconName>(['stop', 'star']);

interface Props { name: IconName; size?: number; opacity?: number; className?: string; style?: CSSProperties; color?: string; strokeWidth?: number }

/** Lucide glyph in currentColor. Stroke scales down a touch at small sizes so 14px icons don't look heavy. */
export function Icon({ name, size = 16, opacity, className, style, color, strokeWidth }: Props) {
  const C = MAP[name];
  const filled = FILLED.has(name);
  return (
    <C
      className={className}
      size={size}
      strokeWidth={strokeWidth ?? (size <= 14 ? 2 : 1.75)}
      aria-hidden
      fill={filled ? 'currentColor' : 'none'}
      style={{ opacity, color, flexShrink: 0, ...style }}
    />
  );
}
