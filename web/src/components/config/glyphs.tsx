import type { CSSProperties } from 'react';
import { ArrowLeft, Download, FileText, Folder, Play, Settings, Sparkles, Trash2, type LucideIcon } from 'lucide-react';

const MAP = {
  trash: Trash2, download: Download, folder: Folder, doc: FileText, gear: Settings, play: Play,
  spark: Sparkles, arrow_left: ArrowLeft,
} satisfies Record<string, LucideIcon>;

export type GlyphName = keyof typeof MAP;

export function Glyph({ name, size = 16, opacity, style, className }: { name: GlyphName; size?: number; opacity?: number; style?: CSSProperties; className?: string }) {
  const C = MAP[name];
  return <C className={className} size={size} strokeWidth={size <= 14 ? 2 : 1.75} aria-hidden style={{ opacity, flexShrink: 0, ...style }} />;
}
