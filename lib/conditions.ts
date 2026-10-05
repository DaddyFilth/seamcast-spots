export type SpotsQuery = {
  lat: number
  lon: number
  species?: string
  time?: string // ISO string or "now"
}

export type Environment = {
  sources: string[]
  pressureHpa: number | null
  pressureTrend3hHpa: number | null
  cloudCoverPct: number | null
  humidityPct: number | null
  precipitationProbabilityPct: number | null
  windGustMph: number | null
  waterSurfaceTempProxyF: number | null
  sunrise: string | null
  sunset: string | null
  moonPhase: string
  moonIlluminationPct: number
  measuredWaterTempF: number | null
  streamflowCfs: number | null
  gageHeightFt: number | null
  observations: { source: string; station: string; distanceKm: number; observedAt: string | null }[]
  tides: {
    station: string
    distanceKm: number
    events: { time: string; type: 'high' | 'low'; heightFt: number }[]
  } | null
}

export type WeatherConditions = {
  source: 'api.weather.gov' | 'open-meteo.com'
  issuedAt: string
  temperatureF: number | null
  windSpeedMph: number | null
  windDirection: string | null
  shortForecast: string | null
  isDaytime: boolean | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export async function fetchWeatherGov(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/geo+json',
        'User-Agent': 'Fishfinder-Pro/1.0 (https://fishfinder-pro.online)',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new ApiError('Unable to reach the weather service', 502)
  }

  if (!response.ok) {
    throw new ApiError(`Weather service returned status ${response.status}`, 502)
  }

  try {
    return await response.json()
  } catch {
    throw new ApiError('Weather service returned an invalid response', 502)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function fetchWeatherGovPointForecast(
  lat: number,
  lon: number,
  requestedTime?: string
) {
  const pointsJson = await fetchWeatherGov(
    `https://api.weather.gov/points/${lat},${lon}`
  )
  const pointProperties =
    isRecord(pointsJson) && isRecord(pointsJson.properties)
      ? pointsJson.properties
      : null
  const forecastUrl = pointProperties?.forecast
  if (!forecastUrl) {
    throw new ApiError('Weather service response missing forecast URL', 502)
  }

  let parsedForecastUrl: URL
  try {
    parsedForecastUrl = new URL(forecastUrl as string)
  } catch {
    throw new ApiError('Weather service returned an invalid forecast URL', 502)
  }
  if (
    typeof forecastUrl !== 'string' ||
    parsedForecastUrl.origin !== 'https://api.weather.gov' ||
    parsedForecastUrl.username ||
    parsedForecastUrl.password
  ) {
    throw new ApiError('Weather service returned an invalid forecast URL', 502)
  }

  const forecastData = await fetchWeatherGov(forecastUrl)
  const forecastProperties =
    isRecord(forecastData) && isRecord(forecastData.properties)
      ? forecastData.properties
      : null
  const periods = forecastProperties?.periods
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new ApiError('Weather service response missing forecast periods', 502)
  }

  const forecastPeriods: unknown[] = periods
  const targetTime =
    requestedTime && requestedTime !== 'now' ? Date.parse(requestedTime) : Date.now()
  const period = forecastPeriods.find(item => {
    if (!isRecord(item)) return false
    const candidate = item
    return (
      typeof candidate.startTime === 'string' &&
      typeof candidate.endTime === 'string' &&
      Date.parse(candidate.startTime) <= targetTime &&
      targetTime < Date.parse(candidate.endTime)
    )
  }) as Record<string, unknown> | undefined

  if (!period) {
    if (requestedTime && requestedTime !== 'now') {
      throw new ApiError('Requested time is outside the available forecast', 422)
    }
    throw new ApiError('Weather service returned no current forecast period', 502)
  }

  const forecastUpdated =
    [forecastProperties?.updated, forecastProperties?.generatedAt].find(
      value => typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ) as string | undefined

  return {
    issuedAt: forecastUpdated ?? period.startTime as string,
    temperatureF: typeof period.temperature === 'number' ? period.temperature : null,
    windSpeedText: typeof period.windSpeed === 'string' ? period.windSpeed : null,
    windDirection: typeof period.windDirection === 'string' ? period.windDirection : null,
    shortForecast: typeof period.shortForecast === 'string' ? period.shortForecast : null,
    isDaytime: typeof period.isDaytime === 'boolean' ? period.isDaytime : null,
  }
}

export function parseWindSpeedMph(windSpeedText: string | null): number | null {
  if (!windSpeedText) return null
  const match = windSpeedText.match(/(\d+)\s*(?:to\s*(\d+))?\s*mph/i)
  if (!match) return null
  const low = Number(match[1])
  const high = match[2] ? Number(match[2]) : low
  if (Number.isNaN(low) || Number.isNaN(high)) return null
  return (low + high) / 2
}

export function moonPhase(date: Date): { phase: string; illuminationPct: number } {
  const synodic = 29.530588853
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14)
  const age = (((date.getTime() - knownNewMoon) / 86_400_000) % synodic + synodic) % synodic
  const fraction = age / synodic
  const names = [
    'new moon', 'waxing crescent', 'first quarter', 'waxing gibbous',
    'full moon', 'waning gibbous', 'last quarter', 'waning crescent',
  ]
  return {
    phase: names[Math.round(fraction * 8) % 8],
    illuminationPct: Math.round(((1 - Math.cos(2 * Math.PI * fraction)) / 2) * 100),
  }
}

export function numberAt(values: unknown, index: number): number | null {
  if (!Array.isArray(values)) return null
  const v = values[index]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export const MAX_OBSERVATION_AGE_MS = 6 * 3_600_000

export type Measurement = { value: number; station: string; distanceKm: number; observedAt: string | null }

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

export async function getJson(url: string, timeoutMs = 8_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Fishfinder-Pro/1.0 (https://fishfinder-pro.online)' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error('status ' + res.status)
  return res.json()
}

// Real-time USGS gauges (water temp 00010, discharge 00060, gage height 00065) within ~0.3 degrees.
// Only meaningful for current conditions, so skipped for non-"now" times more than 2h out.
export async function fetchUsgs(query: SpotsQuery) {
  const d = 0.3
  const url =
    'https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=00010,00060,00065&siteStatus=active&bBox=' +
    [query.lon - d, query.lat - d, query.lon + d, query.lat + d].map(n => n.toFixed(4)).join(',')
  const data = await getJson(url)
  const series = isRecord(data) && isRecord(data.value) ? data.value.timeSeries : null
  if (!Array.isArray(series)) return null

  const best: Record<string, Measurement | undefined> = {}
  for (const ts of series) {
    if (!isRecord(ts) || !isRecord(ts.sourceInfo) || !isRecord(ts.variable)) continue
    const code = (ts.variable.variableCode as { value?: string }[] | undefined)?.[0]?.value
    const geo = isRecord(ts.sourceInfo.geoLocation) && isRecord(ts.sourceInfo.geoLocation.geogLocation)
      ? ts.sourceInfo.geoLocation.geogLocation
      : null
    const valuesBlock = (ts.values as { value?: { value?: string; dateTime?: string }[] }[] | undefined)?.[0]?.value
    const last = valuesBlock?.[valuesBlock.length - 1]
    if (!code || !geo || !last) continue
    const v = Number(last.value)
    const noData = (ts.variable as { noDataValue?: number }).noDataValue
    if (!Number.isFinite(v) || v === noData) continue
    const observedMs = Date.parse(String(last.dateTime ?? ''))
    if (!Number.isFinite(observedMs) || Date.now() - observedMs > MAX_OBSERVATION_AGE_MS) continue
    const km = haversineKm(query.lat, query.lon, Number(geo.latitude), Number(geo.longitude))
    if (!Number.isFinite(km)) continue
    const name = String(ts.sourceInfo.siteName ?? 'unknown')
    const cur = best[code]
    if (!cur || km < cur.distanceKm) {
      best[code] = {
        value: code === '00010' ? Math.round((v * 9) / 5 + 32) : v,
        station: name,
        distanceKm: Math.round(km * 10) / 10,
        observedAt: last.dateTime ?? null,
      }
    }
  }
  return { waterTempF: best['00010'] ?? null, flowCfs: best['00060'] ?? null, gageFt: best['00065'] ?? null }
}

export type NoaaStation = { id: string; name: string; lat: number; lng: number }
export const noaaStationCache: Record<string, NoaaStation[] | undefined> = {}

export async function nearestNoaaStation(type: 'tidepredictions' | 'watertemp', query: SpotsQuery) {
  let stations = noaaStationCache[type]
  if (!stations) {
    const list = await getJson(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=' + type,
      15_000
    )
    const raw = isRecord(list) && Array.isArray(list.stations) ? list.stations : []
    stations = raw
      .filter(isRecord)
      .map(st => ({ id: String(st.id), name: String(st.name), lat: Number(st.lat), lng: Number(st.lng) }))
      .filter(st => Number.isFinite(st.lat) && Number.isFinite(st.lng))
    noaaStationCache[type] = stations
  }
  let nearest: { id: string; name: string; km: number } | null = null
  for (const st of stations) {
    const km = haversineKm(query.lat, query.lon, st.lat, st.lng)
    if (km <= 100 && (!nearest || km < nearest.km)) nearest = { id: st.id, name: st.name, km }
  }
  return nearest
}

// Nearest NOAA CO-OPS stations within 100 km: latest measured water temperature (nearest station that has a
// water temperature sensor) and today's high/low tide predictions (nearest prediction station).
export async function fetchNoaa(query: SpotsQuery, when: Date) {
  const isCurrent = Math.abs(when.getTime() - Date.now()) <= 2 * 3_600_000
  const apiBase =
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?format=json&units=english&time_zone=gmt&station='
  const day = when.toISOString().slice(0, 10).replace(/-/g, '')

  const tempTask = async (): Promise<Measurement | null> => {
    if (!isCurrent) return null
    const st = await nearestNoaaStation('watertemp', query)
    if (!st) return null
    const data = await getJson(apiBase + st.id + '&product=water_temperature&date=latest')
    const row = isRecord(data) && Array.isArray(data.data) ? (data.data[0] as { v?: string; t?: string } | undefined) : undefined
    const v = Number(row?.v)
    if (!row || row.v === '' || !Number.isFinite(v)) return null
    const observedAt = row.t ? row.t.replace(' ', 'T') + ':00Z' : null
    if (!observedAt || Date.now() - Date.parse(observedAt) > MAX_OBSERVATION_AGE_MS) return null
    return { value: v, station: st.name, distanceKm: Math.round(st.km * 10) / 10, observedAt }
  }

  const tideTask = async () => {
    const st = await nearestNoaaStation('tidepredictions', query)
    if (!st) return null
    const data = await getJson(
      apiBase + st.id + `&product=predictions&datum=MLLW&interval=hilo&begin_date=${day}&end_date=${day}`
    )
    const preds = isRecord(data) && Array.isArray(data.predictions) ? (data.predictions as { t?: string; v?: string; type?: string }[]) : []
    const events = preds
      .filter(p => p.t && Number.isFinite(Number(p.v)) && (p.type === 'H' || p.type === 'L'))
      .map(p => ({
        time: p.t!.replace(' ', 'T') + ':00Z',
        type: p.type === 'H' ? ('high' as const) : ('low' as const),
        heightFt: Number(p.v),
      }))
    return events.length ? { station: st.name, distanceKm: Math.round(st.km * 10) / 10, events } : null
  }

  const [temp, tides] = await Promise.allSettled([tempTask(), tideTask()])
  return {
    waterTempF: temp.status === 'fulfilled' ? temp.value : null,
    tides: tides.status === 'fulfilled' ? tides.value : null,
  }
}

// Best-effort supplement from Open-Meteo (public, keyless); failures yield nulls.
export async function fetchEnvironment(query: SpotsQuery): Promise<Environment> {
  const when = query.time && query.time !== 'now' ? new Date(query.time) : new Date()
  const moon = moonPhase(when)
  const env: Environment = {
    sources: ['astronomy (computed)'],
    pressureHpa: null,
    pressureTrend3hHpa: null,
    cloudCoverPct: null,
    humidityPct: null,
    precipitationProbabilityPct: null,
    windGustMph: null,
    waterSurfaceTempProxyF: null,
    sunrise: null,
    sunset: null,
    moonPhase: moon.phase,
    moonIlluminationPct: moon.illuminationPct,
    measuredWaterTempF: null,
    streamflowCfs: null,
    gageHeightFt: null,
    observations: [],
    tides: null,
  }

  const isCurrent = Math.abs(when.getTime() - Date.now()) <= 2 * 3_600_000
  const [usgs, noaa] = await Promise.all([
    (isCurrent ? fetchUsgs(query) : Promise.resolve(null)).catch(() => null),
    fetchNoaa(query, when).catch(() => null),
  ])
  if (usgs) {
    env.sources.push('waterservices.usgs.gov')
    env.measuredWaterTempF = usgs.waterTempF?.value ?? null
    env.streamflowCfs = usgs.flowCfs?.value ?? null
    env.gageHeightFt = usgs.gageFt?.value ?? null
    for (const m of [usgs.waterTempF, usgs.flowCfs, usgs.gageFt]) {
      if (m && !env.observations.some(o => o.station === m.station && o.source === 'USGS')) {
        env.observations.push({ source: 'USGS', station: m.station, distanceKm: m.distanceKm, observedAt: m.observedAt })
      }
    }
  }
  if (noaa) {
    env.sources.push('tidesandcurrents.noaa.gov')
    if (noaa.waterTempF && env.measuredWaterTempF === null) {
      env.measuredWaterTempF = noaa.waterTempF.value
      env.observations.push({ source: 'NOAA CO-OPS', station: noaa.waterTempF.station, distanceKm: noaa.waterTempF.distanceKm, observedAt: noaa.waterTempF.observedAt })
    }
    env.tides = noaa.tides
  }

  try {
    const params = new URLSearchParams({
      latitude: String(query.lat),
      longitude: String(query.lon),
      hourly:
        'pressure_msl,cloud_cover,relative_humidity_2m,precipitation_probability,wind_gusts_10m,soil_temperature_0cm',
      daily: 'sunrise,sunset',
      wind_speed_unit: 'mph',
      temperature_unit: 'fahrenheit',
      timezone: 'UTC',
      past_days: '1',
      forecast_days: '8',
    })
    const response = await fetch('https://api.open-meteo.com/v1/forecast?' + params, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return env
    const data: unknown = await response.json()
    if (!isRecord(data) || !isRecord(data.hourly)) return env

    const times = data.hourly.time
    if (!Array.isArray(times)) return env
    const target = when.getTime()
    let idx = -1
    let best = Infinity
    times.forEach((t, i) => {
      const diff = Math.abs(Date.parse(String(t) + 'Z') - target)
      if (diff < best) {
        best = diff
        idx = i
      }
    })
    if (idx < 0 || best > 3_600_000 * 3) return env

    const h = data.hourly
    const pressure = numberAt(h.pressure_msl, idx)
    const earlier = numberAt(h.pressure_msl, idx - 3)
    env.pressureHpa = pressure
    env.pressureTrend3hHpa =
      pressure !== null && earlier !== null ? Math.round((pressure - earlier) * 10) / 10 : null
    env.cloudCoverPct = numberAt(h.cloud_cover, idx)
    env.humidityPct = numberAt(h.relative_humidity_2m, idx)
    env.precipitationProbabilityPct = numberAt(h.precipitation_probability, idx)
    env.windGustMph = numberAt(h.wind_gusts_10m, idx)
    env.waterSurfaceTempProxyF = numberAt(h.soil_temperature_0cm, idx)

    if (isRecord(data.daily)) {
      const day = new Date(target).toISOString().slice(0, 10)
      const di = Array.isArray(data.daily.time) ? data.daily.time.indexOf(day) : -1
      if (di >= 0) {
        const sr = (data.daily.sunrise as unknown[])?.[di]
        const ss = (data.daily.sunset as unknown[])?.[di]
        env.sunrise = typeof sr === 'string' ? sr + 'Z' : null
        env.sunset = typeof ss === 'string' ? ss + 'Z' : null
      }
    }
    env.sources.push('open-meteo.com')
  } catch {
    // supplementary data is optional
  }
  return env
}

export async function snapshotConditions(
  query: SpotsQuery
): Promise<{ conditions: WeatherConditions; environment: Environment }> {
  const wx = await fetchWeatherGovPointForecast(query.lat, query.lon, query.time)
  const conditions: WeatherConditions = {
    source: 'api.weather.gov',
    issuedAt: wx.issuedAt,
    temperatureF: wx.temperatureF,
    windSpeedMph: parseWindSpeedMph(wx.windSpeedText),
    windDirection: wx.windDirection,
    shortForecast: wx.shortForecast,
    isDaytime: wx.isDaytime,
  }
  const environment = await fetchEnvironment(query)
  return { conditions, environment }
}
