import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun, Sunrise, Sunset } from 'lucide-react';
import type { WeatherCard as Weather } from '@shared/types';

type Unit = 'C' | 'F';

/** Places that read temperatures in Fahrenheit. */
const FAHRENHEIT = new Set(['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW']);

const toUnit = (c: number, u: Unit) => (u === 'F' ? c * 9 / 5 + 32 : c);
const deg = (c: number, u: Unit) => `${Math.round(toUnit(c, u))}°`;

/** WMO weather codes, as Open-Meteo reports them. */
function condition(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Mostly cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return code >= 80 ? 'Showers' : 'Rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Thunderstorms';
  return 'Cloudy';
}

function WeatherIcon({ code, isDay, size }: { code: number; isDay: boolean; size: number }) {
  const p = { size, strokeWidth: 1.6, 'aria-hidden': true } as const;
  let icon: ReactNode;
  let tone = 'cloud';
  if (code === 0 || code === 1) { icon = isDay ? <Sun {...p} /> : <Moon {...p} />; tone = isDay ? 'sun' : 'moon'; }
  else if (code === 2) { icon = isDay ? <CloudSun {...p} /> : <CloudMoon {...p} />; tone = isDay ? 'partly' : 'moon'; }
  else if (code === 3) icon = <Cloud {...p} />;
  else if (code === 45 || code === 48) icon = <CloudFog {...p} />;
  else if (code >= 51 && code <= 57) { icon = <CloudDrizzle {...p} />; tone = 'rain'; }
  else if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) { icon = <CloudRain {...p} />; tone = 'rain'; }
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) { icon = <CloudSnow {...p} />; tone = 'snow'; }
  else if (code >= 95) { icon = <CloudLightning {...p} />; tone = 'storm'; }
  else icon = <Cloud {...p} />;
  return <span className={`wx-icon is-${tone}`}>{icon}</span>;
}

/** "2026-11-15T06:17" → "6:17 AM", or "6 AM" on the hour. */
function hourLabel(t: string): string {
  const [h, m] = t.slice(11, 16).split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

const dayLabel = (date: string, i: number) => (i === 0 ? 'Today' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }));

/** A temperature's color on the range bars: blue when cold, through green, to orange when hot. */
function tempColor(c: number): string {
  const stops: [number, [number, number, number]][] = [
    [-10, [94, 129, 244]], [0, [90, 170, 245]], [8, [74, 205, 196]], [14, [96, 210, 120]], [20, [226, 205, 72]], [26, [242, 156, 56]], [32, [240, 100, 60]],
  ];
  if (c <= stops[0][0]) return `rgb(${stops[0][1].join(' ')})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, a] = stops[i - 1];
    const [t2, b] = stops[i];
    if (c <= t2) {
      const k = (c - t1) / (t2 - t1);
      return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * k)).join(' ')})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(' ')})`;
}

/** The hourly strip scrolls sideways; an arrow at the edge says there is more and pages it along. */
function HourStrip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', check); ro.disconnect(); };
  }, []);
  return (
    <div className={`wx-hours-wrap${more ? ' has-more' : ''}`}>
      <div className="wx-hours" ref={ref}>{children}</div>
      {more && (
        <button type="button" className="wx-hours__more" onClick={() => ref.current?.scrollBy({ left: ref.current.clientWidth * 0.8, behavior: 'smooth' })} aria-label="Later hours">
          <ChevronRight size={12} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function WeatherCard({ body }: { body: Weather }) {
  const [unit, setUnit] = useState<Unit>(() => (FAHRENHEIT.has(body.country ?? '') ? 'F' : 'C'));
  const [all, setAll] = useState(false);
  const c = body.current;
  const days = all ? body.daily : body.daily.slice(0, 5);
  const lo = Math.min(...days.map((d) => d.low));
  const hi = Math.max(...days.map((d) => d.high));
  const span = Math.max(1, hi - lo);
  const wind = unit === 'F' ? `${Math.round(c.wind * 0.621371)} mph` : `${Math.round(c.wind)} km/h`;
  const updated = new Date(body.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: body.timezone });
  return (
    <div className="card wx-card">
      <div className="wx-card__head">
        <span className="wx-card__place">{body.place}</span>
        <span className="wx-units" role="group" aria-label="Units">
          {(['F', 'C'] as Unit[]).map((u) => (
            <button key={u} type="button" className={unit === u ? 'is-on' : ''} aria-pressed={unit === u} onClick={() => setUnit(u)}>°{u}</button>
          ))}
        </span>
      </div>
      <div className="wx-now">
        <WeatherIcon code={c.code} isDay={c.isDay} size={30} />
        <span className="wx-now__temp">{deg(c.temp, unit)}</span>
        <span className="wx-now__text">
          <span className="wx-now__cond">{condition(c.code)}</span>
          <span className="wx-now__sub">Feels like {deg(c.feelsLike, unit)} · H:{deg(c.high, unit)} L:{deg(c.low, unit)}</span>
          <span className="wx-now__sub">Wind {wind} · Humidity {Math.round(c.humidity)}%</span>
        </span>
      </div>
      <div className="wx-label">Hourly forecast</div>
      <HourStrip>
        {body.hourly.map((h, i) => (
          <div key={h.time + (h.event ?? '')} className={`wx-hour${h.event ? ' is-event' : ''}`}>
            <span className="wx-hour__time">{i === 0 ? 'Now' : hourLabel(h.time)}</span>
            {h.event
              ? <span className="wx-icon is-sun">{h.event === 'sunrise' ? <Sunrise size={18} strokeWidth={1.6} aria-hidden /> : <Sunset size={18} strokeWidth={1.6} aria-hidden />}</span>
              : <WeatherIcon code={h.code} isDay={h.isDay} size={18} />}
            <span className="wx-hour__temp">{h.event ? (h.event === 'sunrise' ? 'Sunrise' : 'Sunset') : deg(h.temp, unit)}</span>
          </div>
        ))}
      </HourStrip>
      <div className="wx-label">Daily forecast</div>
      <div className="wx-days">
        {days.map((d, i) => (
          <div key={d.date} className="wx-day">
            <span className="wx-day__name">{dayLabel(d.date, i)}</span>
            <span className="wx-day__icon">
              <WeatherIcon code={d.code} isDay size={16} />
              {d.precip >= 20 && <span className="wx-day__precip">{d.precip}%</span>}
            </span>
            <span className="wx-day__lo">{deg(d.low, unit)}</span>
            <span className="wx-day__bar">
              <i style={{ left: `${((d.low - lo) / span) * 100}%`, right: `${((hi - d.high) / span) * 100}%`, background: `linear-gradient(to right, ${tempColor(d.low)}, ${tempColor(d.high)})` }} />
            </span>
            <span className="wx-day__hi">{deg(d.high, unit)}</span>
          </div>
        ))}
      </div>
      {body.daily.length > 5 && (
        <button type="button" className={`wx-more${all ? ' is-open' : ''}`} onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show less' : 'Show more'}<ChevronDown size={12} strokeWidth={2} aria-hidden />
        </button>
      )}
      <div className="wx-card__foot">
        <span>Open-Meteo</span>
        <span>Updated {updated}</span>
      </div>
    </div>
  );
}
