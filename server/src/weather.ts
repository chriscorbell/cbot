import type { WeatherCard } from './types.js';

/**
 * Forecasts from Open-Meteo (open-meteo.com): free, no key, no account. Only the place name the bot
 * asked for and its coordinates are sent.
 */
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'dispatch' } });
  if (!res.ok) throw new Error(`weather service: HTTP ${res.status}`);
  return res.json();
}

/** "Louisville, KY" → the best match for "Louisville", preferring one whose region or country matches the rest. */
async function geocode(query: string) {
  const [name, ...rest] = query.split(',').map((s) => s.trim()).filter(Boolean);
  if (!name) return null;
  const r = await getJson(`${GEO}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
  const hits: any[] = r.results ?? [];
  if (!hits.length) return null;
  const hint = rest.join(' ').toLowerCase();
  const score = (h: any) => {
    if (!hint) return 0;
    const fields = [h.admin1, h.admin2, h.country, h.country_code].filter(Boolean).map((x: string) => x.toLowerCase());
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
  const f = await getJson(`${FORECAST}?${params}`);
  const cur = f.current;
  // Local "now" in the place's zone, as Open-Meteo writes times ("2026-11-15T14:00").
  const nowLocal: string = cur.time;
  const hourIdx = Math.max(0, (f.hourly.time as string[]).findIndex((t) => t >= nowLocal.slice(0, 13)));
  const hourly: WeatherCard['hourly'] = [];
  const events: { time: string; event: 'sunrise' | 'sunset' }[] = [];
  (f.daily.sunrise as string[]).forEach((t) => events.push({ time: t, event: 'sunrise' }));
  (f.daily.sunset as string[]).forEach((t) => events.push({ time: t, event: 'sunset' }));
  for (let i = hourIdx; i < Math.min(hourIdx + 24, f.hourly.time.length); i++) {
    const time: string = f.hourly.time[i];
    hourly.push({ time, temp: f.hourly.temperature_2m[i], code: f.hourly.weather_code[i], isDay: !!f.hourly.is_day[i] });
    const next: string | undefined = f.hourly.time[i + 1];
    for (const e of events) if (e.time > time && next && e.time < next) hourly.push({ time: e.time, temp: f.hourly.temperature_2m[i], code: 0, isDay: e.event === 'sunrise', event: e.event });
  }
  const daily: WeatherCard['daily'] = (f.daily.time as string[]).map((date, i) => ({
    date, high: f.daily.temperature_2m_max[i], low: f.daily.temperature_2m_min[i], code: f.daily.weather_code[i], precip: f.daily.precipitation_probability_max[i] ?? 0,
  }));
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
