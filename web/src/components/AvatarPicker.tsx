import { AVATAR_SHAPES, type AvatarColor, type AvatarShape } from '@shared/types';
import { BotAvatar } from '../avatar/BotAvatar';
import { COLOR_ORDER, palette } from '../lib/colors';
import { onRovingKeyDown, rovingTab } from '../lib/roving';

const ROWS = [AVATAR_SHAPES.slice(0, 5), AVATAR_SHAPES.slice(5, 10), AVATAR_SHAPES.slice(10)];
const COLOR_ROWS = [COLOR_ORDER.slice(0, 6), COLOR_ORDER.slice(6)];

/**
 * The shape grid (rows of 5/5/3) and the color swatches (6/5) used to make or restyle a bot.
 * Pointing at a shape or a color previews it through `onPreview`; leaving clears the preview.
 */
export function AvatarPicker({ shape, color, onShape, onColor, onPreview, size = 26 }: {
  shape: AvatarShape;
  color: AvatarColor;
  onShape: (s: AvatarShape) => void;
  onColor: (c: AvatarColor) => void;
  onPreview?: (p: { shape?: AvatarShape; color?: AvatarColor } | null) => void;
  size?: number;
}) {
  const hover = (p: { shape?: AvatarShape; color?: AvatarColor }) => ({
    onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') onPreview?.(p); },
    onPointerLeave: () => onPreview?.(null),
  });
  return (
    <>
      <div className="shape-grid" role="radiogroup" aria-label="Shape" onKeyDown={onRovingKeyDown}>
        {ROWS.map((row, i) => (
          <div key={i} className="shape-grid__row">
            {row.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={shape === s} tabIndex={rovingTab(shape === s)} aria-label={s} className="shape-cell" onClick={() => onShape(s)} {...hover({ shape: s })}>
                <BotAvatar shape={s} color={color} size={size} ring={shape === s} life="lite" seed={`pick:${s}`} />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="swatches" role="radiogroup" aria-label="Color" onKeyDown={onRovingKeyDown}>
        {COLOR_ROWS.map((row, i) => (
          <div key={i} className="swatches__row">
            {row.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} tabIndex={rovingTab(color === c)} aria-label={c === 'black' ? 'ink' : c} className="swatch-cell" onClick={() => onColor(c)} {...hover({ color: c })}>
                <span className={`swatch${color === c ? ' is-selected' : ''}`} style={{ background: c === 'black' ? 'var(--avatar-ink)' : palette(c).fill }} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
