import { z } from 'zod';
import type { WeatherCard } from './types.js';

/**
 * Forecasts from Open-Meteo (open-meteo.com): free, no key, no account. Only the place name the bot
 * asked for and its coordinates are sent. Its answers are checked against the shapes below; one that
 * doesn't fit fails the tool call with a message instead of drawing a broken card.
 */
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

const Place = z.object({
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  country_code: z.string().optional(),
  country: z.string().optional(),
  admin1: z.string().optional(),
  admin2: z.string().optional(),
});
type Place = z.infer<typeof Place>;
/** No `results` when nothing matched. */
const Places = z.object({ results: z.array(Place).optional() });

// Open-Meteo leaves a value null where it has none (precipitation chances far ahead, mostly).
const values = z.array(z.number().nullable());
const Forecast = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    is_day: z.number(),
  }),
  hourly: z.object({ time: z.array(z.string()), temperature_2m: values, weather_code: values, is_day: values }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: values,
    temperature_2m_max: values,
    temperature_2m_min: values,
    precipitation_probability_max: values,
    sunrise: z.array(z.string()),
    sunset: z.array(z.string()),
  }),
});

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'dispatch' } });
  if (!res.ok) throw new Error(`weather service: HTTP ${res.status}`);
  const body = schema.safeParse(await res.json());
  if (!body.success) {
    console.warn(`[weather] ${url.split('?')[0]} answered in a shape this doesn't read: ${z.prettifyError(body.error).replace(/\s+/g, ' ')}`);
    throw new Error('weather service: an answer Dispatch couldn’t read');
  }
  return body.data;
}

/** "Louisville, KY" → the best match for "Louisville", preferring one whose region or country matches the rest. */
async function geocode(query: string): Promise<Place | null> {
  const [name, ...rest] = query.split(',').map((s) => s.trim()).filter(Boolean);
  if (!name) return null;
  const hits = (await getJson(`${GEO}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`, Places)).results ?? [];
  if (!hits.length) return null;
  const hint = rest.join(' ').toLowerCase();
  const score = (h: Place) => {
    if (!hint) return 0;
    const fields = [h.admin1, h.admin2, h.country, h.country_code].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    return fields.some((f) => f === hint || hint.includes(f) || f.startsWith(hint)) ? 1 : 0;
  };
  // Open-Meteo already sorts by population; a match on the region or country wins over that.
  return hits.reduce((best, h) => (score(h) > score(best) ? h : best), hits[0]);
}

export async function fetchWeather(query: string): Promise<WeatherCard | null> {
  const place = await geocode(query);
  if (!place) return null;
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    hourly: 'temperature_2m,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    timezone: 'auto',
    forecast_days: '10',
  });
  const f = await getJson(`${FORECAST}?${params}`, Forecast);
  const cur = f.current;
  const h = f.hourly;
  // Local "now" in the place's zone, as Open-Meteo writes times ("2026-11-15T14:00").
  const nowLocal = cur.time;
  const hourIdx = Math.max(0, h.time.findIndex((t) => t >= nowLocal.slice(0, 13)));
  const hourly: WeatherCard['hourly'] = [];
  const events: { time: string; event: 'sunrise' | 'sunset' }[] = [];
  f.daily.sunrise.forEach((t) => events.push({ time: t, event: 'sunrise' }));
  f.daily.sunset.forEach((t) => events.push({ time: t, event: 'sunset' }));
  for (let i = hourIdx; i < Math.min(hourIdx + 24, h.time.length); i++) {
    const time = h.time[i];
    const temp = h.temperature_2m[i];
    const code = h.weather_code[i];
    // An hour Open-Meteo has no reading for is left out.
    if (temp == null || code == null) continue;
    hourly.push({ time, temp, code, isDay: !!h.is_day[i] });
    const next: string | undefined = h.time[i + 1];
    for (const e of events) if (e.time > time && next && e.time < next) hourly.push({ time: e.time, temp, code: 0, isDay: e.event === 'sunrise', event: e.event });
  }
  const d = f.daily;
  const daily: WeatherCard['daily'] = d.time.flatMap((date, i) => {
    const high = d.temperature_2m_max[i];
    const low = d.temperature_2m_min[i];
    const code = d.weather_code[i];
    return high == null || low == null || code == null ? [] : [{ date, high, low, code, precip: d.precipitation_probability_max[i] ?? 0 }];
  });
  return {
    type: 'card', card: 'weather', status: 'shown',
    place: place.name, country: place.country_code, timezone: f.timezone, fetchedAt: Date.now(),
    current: {
      temp: cur.temperature_2m, feelsLike: cur.apparent_temperature, code: cur.weather_code, isDay: !!cur.is_day,
      humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m, high: daily[0]?.high ?? cur.temperature_2m, low: daily[0]?.low ?? cur.temperature_2m,
    },
    hourly: hourly.slice(0, 26),
    daily,
  };
}
