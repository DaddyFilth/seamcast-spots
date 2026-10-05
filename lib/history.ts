import {
  ApiError,
  getJson,
  haversineKm,
  isRecord,
  moonPhase,
  nearestNoaaStation,
  numberAt,
  snapshotConditions,
  type Environment,
  type SpotsQuery,
  type WeatherConditions,
} from '@/lib/conditions'

export type Season = 'winter' | 'spring' | 'summer' | 'fall'
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night'

export type NormalizedConditions = {
  pressureTrendHpa: number | null
  airTempF: number | null
  waterTempF: number | null
  windMph: number | null
  cloudCoverPct: number | null
  moonIlluminationPct: number | null
  season: Season
  timeOfDay: TimeOfDay | null
}

export type PastOuting = {
  distanceKm: number
  caught: boolean
  species: string | null
  bait: string | null
  depthFt: number | null
  conditions: NormalizedConditions
}

export type HistoricalBasis = {
  available: boolean
  matchedCases: number
  dataQuality: 'none' | 'thin' | 'moderate' | 'solid'
  searchRadiusKm: number | null
  catchRate: number | null
  species: { species: string; share: number; catches: number }[]
  baits: { bait: string; successRate: number; trips: number }[]
  medianDepthFt: number | null
  note: string
}

const HOUR_MS = 3_600_000
const SEASONS: Season[] = ['winter', 'spring', 'summer', 'fall']
const TIMES_OF_DAY: TimeOfDay[] = ['dawn', 'day', 'dusk', 'night']

export function seasonFor(date: Date, lat: number): Season {
  const m = date.getUTCMonth()
  const north: Season = m >= 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'fall'
  if (lat >= 0) return north
  return { winter: 'summer', spring: 'fall', summer: 'winter', fall: 'spring' }[north] as Season
}

function timeOfDayFor(when: Date, env: Environment): TimeOfDay | null {
  const sr = env.sunrise ? Date.parse(env.sunrise) : NaN
  const ss = env.sunset ? Date.parse(env.sunset) : NaN
  if (!Number.isFinite(sr) || !Number.isFinite(ss)) return null
  const t = when.getTime()
  // sunrise/sunset are for the UTC date of the request; shift by whole days to the same cycle
  const dayShift = Math.round((t - sr) / (24 * HOUR_MS)) * 24 * HOUR_MS
  const rise = sr + dayShift
  const set = ss + dayShift
  if (Math.abs(t - rise) <= 1.5 * HOUR_MS) return 'dawn'
  if (Math.abs(t - set) <= 1.5 * HOUR_MS) return 'dusk'
  const between = rise < set ? t > rise && t < set : t > rise || t < set
  return between ? 'day' : 'night'
}

export function normalizeConditions(
  conditions: WeatherConditions,
  env: Environment,
  when: Date,
  lat: number
): NormalizedConditions {
  return {
    pressureTrendHpa: env.pressureTrend3hHpa,
    airTempF: conditions.temperatureF,
    waterTempF: env.measuredWaterTempF,
    windMph: conditions.windSpeedMph,
    cloudCoverPct: env.cloudCoverPct,
    moonIlluminationPct: env.moonIlluminationPct,
    season: seasonFor(when, lat),
    timeOfDay: timeOfDayFor(when, env),
  }
}

// Real observed conditions for a past outing: Open-Meteo archive/past-forecast data plus the
// nearest measured water temperature (USGS, then NOAA) around the outing time.
async function fetchPastWaterTempF(query: SpotsQuery, when: Date) {
  const from = new Date(when.getTime() - HOUR_MS).toISOString()
  const to = new Date(when.getTime() + HOUR_MS).toISOString()
  try {
    const d = 0.3
    const bbox = [query.lon - d, query.lat - d, query.lon + d, query.lat + d].map(n => n.toFixed(4)).join(',')
    const data = await getJson(
      `https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=00010&siteStatus=all&startDT=${from}&endDT=${to}&bBox=${bbox}`
    )
    const series = isRecord(data) && isRecord(data.value) && Array.isArray(data.value.timeSeries) ? data.value.timeSeries : []
    let best: { km: number; value: number } | null = null
    for (const ts of series) {
      if (!isRecord(ts) || !isRecord(ts.sourceInfo) || !isRecord(ts.sourceInfo.geoLocation)) continue
      const geo = ts.sourceInfo.geoLocation.geogLocation as { latitude?: number; longitude?: number } | undefined
      const values = (ts.values as { value?: { value?: string; dateTime?: string }[] }[] | undefined)?.[0]?.value ?? []
      let near: { v: number; dt: number } | null = null
      for (const row of values) {
        const v = Number(row.value)
        const dt = Math.abs(Date.parse(String(row.dateTime)) - when.getTime())
        if (Number.isFinite(v) && v > -50 && Number.isFinite(dt) && (!near || dt < near.dt)) near = { v, dt }
      }
      if (!near || !geo) continue
      const km = haversineKm(query.lat, query.lon, Number(geo.latitude), Number(geo.longitude))
      if (Number.isFinite(km) && (!best || km < best.km)) best = { km, value: Math.round((near.v * 9) / 5 + 32) }
    }
    if (best) return best.value
  } catch {
    // fall through to NOAA
  }
  try {
    const st = await nearestNoaaStation('watertemp', query)
    if (!st) return null
    const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '')
    const params = new URLSearchParams({
      format: 'json', units: 'english', time_zone: 'gmt', product: 'water_temperature',
      station: st.id, begin_date: fmt(new Date(when.getTime() - HOUR_MS)), end_date: fmt(new Date(when.getTime() + HOUR_MS)),
    })
    const data = await getJson('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?' + params)
    const rows = isRecord(data) && Array.isArray(data.data) ? (data.data as { t?: string; v?: string }[]) : []
    let near: { v: number; dt: number } | null = null
    for (const row of rows) {
      const v = Number(row.v)
      const dt = Math.abs(Date.parse(String(row.t).replace(' ', 'T') + ':00Z') - when.getTime())
      if (row.v !== '' && Number.isFinite(v) && Number.isFinite(dt) && (!near || dt < near.dt)) near = { v, dt }
    }
    return near?.v ?? null
  } catch {
    return null
  }
}

async function snapshotPast(query: SpotsQuery, when: Date) {
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const ageDays = (Date.now() - when.getTime()) / (24 * HOUR_MS)
  const base = ageDays > 7 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast'
  const params = new URLSearchParams({
    latitude: String(query.lat),
    longitude: String(query.lon),
    hourly: 'temperature_2m,wind_speed_10m,wind_gusts_10m,pressure_msl,cloud_cover,relative_humidity_2m',
    daily: 'sunrise,sunset',
    wind_speed_unit: 'mph',
    temperature_unit: 'fahrenheit',
    timezone: 'UTC',
    start_date: day(new Date(when.getTime() - 24 * HOUR_MS)),
    end_date: day(when),
  })
  const data = await getJson(base + '?' + params, 12_000)
  if (!isRecord(data) || !isRecord(data.hourly) || !Array.isArray(data.hourly.time)) {
    throw new ApiError('Historical weather data is unavailable for that time', 502)
  }
  let idx = -1
  let bestDiff = Infinity
  data.hourly.time.forEach((t, i) => {
    const diff = Math.abs(Date.parse(String(t) + 'Z') - when.getTime())
    if (diff < bestDiff) { bestDiff = diff; idx = i }
  })
  if (idx < 0 || bestDiff > 2 * HOUR_MS) throw new ApiError('Historical weather data is unavailable for that time', 502)
  const h = data.hourly
  const pressure = numberAt(h.pressure_msl, idx)
  const earlier = numberAt(h.pressure_msl, idx - 3)
  const moon = moonPhase(when)
  const di = isRecord(data.daily) && Array.isArray(data.daily.time) ? data.daily.time.indexOf(day(when)) : -1
  const sr = di >= 0 ? (data.daily as { sunrise?: unknown[] }).sunrise?.[di] : null
  const ss = di >= 0 ? (data.daily as { sunset?: unknown[] }).sunset?.[di] : null
  const waterTemp = await fetchPastWaterTempF(query, when)

  const conditions: WeatherConditions = {
    source: 'open-meteo.com',
    issuedAt: when.toISOString(),
    temperatureF: numberAt(h.temperature_2m, idx),
    windSpeedMph: numberAt(h.wind_speed_10m, idx),
    windDirection: null,
    shortForecast: null,
    isDaytime: null,
  }
  const environment: Environment = {
    sources: ['open-meteo.com (historical)', 'astronomy (computed)'].concat(waterTemp !== null ? ['USGS/NOAA (historical)'] : []),
    pressureHpa: pressure,
    pressureTrend3hHpa: pressure !== null && earlier !== null ? Math.round((pressure - earlier) * 10) / 10 : null,
    cloudCoverPct: numberAt(h.cloud_cover, idx),
    humidityPct: numberAt(h.relative_humidity_2m, idx),
    precipitationProbabilityPct: null,
    windGustMph: numberAt(h.wind_gusts_10m, idx),
    waterSurfaceTempProxyF: null,
    sunrise: typeof sr === 'string' ? sr + 'Z' : null,
    sunset: typeof ss === 'string' ? ss + 'Z' : null,
    moonPhase: moon.phase,
    moonIlluminationPct: moon.illuminationPct,
    measuredWaterTempF: waterTemp,
    streamflowCfs: null,
    gageHeightFt: null,
    observations: [],
    tides: null,
  }
  return { conditions, environment }
}

// Conditions snapshot to store with a logged outing. Past outings use archived observations.
export async function snapshotForLog(query: SpotsQuery, when: Date) {
  if (Date.now() - when.getTime() > 2 * HOUR_MS) return snapshotPast(query, when)
  return snapshotConditions({ ...query, time: when.toISOString() })
}

type Row = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

// Anonymized consenting outings near the point (via the match_outings RPC). Null when Supabase is not configured.
export async function fetchOutings(query: SpotsQuery, radiusKm = 200): Promise<PastOuting[] | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/rpc/match_outings', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_lat: query.lat, p_lon: query.lon, p_radius_km: radiusKm, p_limit: 1000 }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const rows: unknown = await res.json()
    if (!Array.isArray(rows)) return null
    return rows.filter((r): r is Row => isRecord(r) && SEASONS.includes(r.season as Season)).map((r: Row) => ({
      distanceKm: num(r.distance_km) ?? 0,
      caught: r.caught === true,
      species: typeof r.species === 'string' ? r.species : null,
      bait: typeof r.bait === 'string' ? r.bait : null,
      depthFt: num(r.depth_ft),
      conditions: {
        pressureTrendHpa: num(r.pressure_trend_hpa),
        airTempF: num(r.air_temp_f),
        waterTempF: num(r.water_temp_f),
        windMph: num(r.wind_mph),
        cloudCoverPct: num(r.cloud_cover_pct),
        moonIlluminationPct: num(r.moon_illumination_pct),
        season: r.season as Season,
        timeOfDay: TIMES_OF_DAY.includes(r.time_of_day as TimeOfDay) ? (r.time_of_day as TimeOfDay) : null,
      },
    }))
  } catch {
    return null
  }
}

const NUMERIC_SCALES: [keyof NormalizedConditions, number][] = [
  ['pressureTrendHpa', 3],
  ['airTempF', 15],
  ['waterTempF', 8],
  ['windMph', 10],
  ['cloudCoverPct', 40],
  ['moonIlluminationPct', 50],
]

// 0..1 similarity over the features known on both sides; season must match; null if too little to compare.
export function similarity(a: NormalizedConditions, b: NormalizedConditions): number | null {
  if (a.season !== b.season) return null
  let total = 0
  let n = 0
  for (const [key, scale] of NUMERIC_SCALES) {
    const x = a[key] as number | null
    const y = b[key] as number | null
    if (x === null || y === null) continue
    total += Math.min(1, Math.abs(x - y) / scale)
    n++
  }
  if (a.timeOfDay && b.timeOfDay) {
    total += a.timeOfDay === b.timeOfDay ? 0 : 1
    n++
  }
  if (n < 3) return null
  return 1 - total / n
}

const MIN_SIMILARITY = 0.6
const RADIUS_TIERS_KM = [10, 50, Infinity]
const MIN_CASES_BEFORE_WIDENING = 10
const MAX_MATCHES = 50

function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function summarizeHistory(current: NormalizedConditions, outings: PastOuting[] | null): HistoricalBasis {
  const empty = (note: string): HistoricalBasis => ({
    available: outings !== null, matchedCases: 0, dataQuality: 'none', searchRadiusKm: null,
    catchRate: null, species: [], baits: [], medianDepthFt: null, note,
  })
  if (outings === null) return empty('Outing history is not configured or could not be reached; advice uses current conditions only.')

  // widen the search area only when closer outings are too few: 10 km, 50 km, then the full fetched radius
  let chosen: { outing: PastOuting; score: number }[] = []
  let radius = 0
  for (const r of RADIUS_TIERS_KM) {
    chosen = outings
      .filter(o => o.distanceKm <= r)
      .map(o => ({ outing: o, score: similarity(current, o.conditions) }))
      .filter((m): m is { outing: PastOuting; score: number } => m.score !== null && m.score >= MIN_SIMILARITY)
    radius = r
    if (chosen.length >= MIN_CASES_BEFORE_WIDENING) break
  }
  chosen = chosen.sort((a, b) => b.score - a.score).slice(0, MAX_MATCHES)
  if (!chosen.length) return empty('No logged outings with similar conditions were found; advice uses current conditions only.')

  const cases = chosen.map(m => m.outing)
  const catches = cases.filter(c => c.caught)
  const speciesCount = new Map<string, number>()
  for (const c of catches) if (c.species) speciesCount.set(c.species.toLowerCase(), (speciesCount.get(c.species.toLowerCase()) ?? 0) + 1)
  const speciesTotal = [...speciesCount.values()].reduce((a, b) => a + b, 0)
  const baitStats = new Map<string, { trips: number; caught: number }>()
  for (const c of cases) {
    if (!c.bait) continue
    const k = c.bait.toLowerCase()
    const s = baitStats.get(k) ?? { trips: 0, caught: 0 }
    s.trips++
    if (c.caught) s.caught++
    baitStats.set(k, s)
  }
  const n = cases.length
  const dataQuality = n < 10 ? 'thin' : n < 30 ? 'moderate' : 'solid'
  return {
    available: true,
    matchedCases: n,
    dataQuality,
    searchRadiusKm: Number.isFinite(radius) ? radius : Math.ceil(Math.max(...cases.map(c => c.distanceKm))),
    catchRate: Math.round((catches.length / n) * 100) / 100,
    species: [...speciesCount.entries()]
      .map(([species, c]) => ({ species, catches: c, share: Math.round((c / speciesTotal) * 100) / 100 }))
      .sort((a, b) => b.catches - a.catches).slice(0, 5),
    baits: [...baitStats.entries()]
      .map(([bait, s]) => ({ bait, trips: s.trips, successRate: Math.round((s.caught / s.trips) * 100) / 100 }))
      .filter(b => b.trips >= 2)
      .sort((a, b) => b.successRate - a.successRate || b.trips - a.trips).slice(0, 5),
    medianDepthFt: median(catches.map(c => c.depthFt).filter((d): d is number => d !== null)),
    note:
      dataQuality === 'thin'
        ? `Only ${n} similar logged outings: treat as weak evidence.`
        : `${n} similar logged outings (catch rate counts trips with at least one fish).`,
  }
}
