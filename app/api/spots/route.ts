import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic' // always compute at request time

type SpotsQuery = {
  lat: number
  lon: number
  species?: string
  time?: string // ISO string or "now"
}

type BiteScore = {
  score: number // 0-100
  level: 'poor' | 'fair' | 'good' | 'excellent'
  reasons: string[]
}

type SpeciesPrediction = {
  species: string
  probability: number // 0-1
  notes: string[]
}

type BaitRecommendation = {
  baitType: string
  confidence: number // 0-1
  conditionsMatch: string[]
}

type MicroSpot = {
  id: string
  label: string
  lat: number
  lon: number
  biteScore: BiteScore
  bestSpecies: SpeciesPrediction[]
  bestBaits: BaitRecommendation[]
}

type SpotsResponse = {
  query: SpotsQuery
  conditions: {
    source: 'api.weather.gov'
    issuedAt: string
    temperatureF: number | null
    windSpeedMph: number | null
    windDirection: string | null
    shortForecast: string | null
    isDaytime: boolean | null
  }
  overallBite: BiteScore
  speciesLikely: SpeciesPrediction[]
  recommendedBaits: BaitRecommendation[]
  microSpots: MicroSpot[]
}

function parseQuery(req: NextRequest): SpotsQuery {
  const sp = req.nextUrl.searchParams
  const lat = Number(sp.get('lat'))
  const lon = Number(sp.get('lon'))
  const species = sp.get('species') || undefined
  const time = sp.get('time') || undefined

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error('lat and lon are required and must be numbers')
  }

  return { lat, lon, species, time }
}

async function fetchWeatherGovPointForecast(lat: number, lon: number) {
  const pointsRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
    headers: {
      'Accept': 'application/geo+json',
      'User-Agent': 'seamcast/1.0 (spots api; contact: your-email@example.com)',
    },
  })

  if (!pointsRes.ok) {
    throw new Error(`weather.gov points error: ${pointsRes.status}`)
  }

  const pointsJson = await pointsRes.json()
  const forecastUrl = pointsJson.properties?.forecast as string | undefined
  if (!forecastUrl) {
    throw new Error('weather.gov points response missing forecast URL')
  }

  const forecastRes = await fetch(forecastUrl, {
    headers: {
      'Accept': 'application/geo+json',
      'User-Agent': 'seamcast/1.0 (spots api; contact: your-email@example.com)',
    },
  })

  if (!forecastRes.ok) {
    throw new Error(`weather.gov forecast error: ${forecastRes.status}`)
  }

  const forecastJson = await forecastRes.json()
  const periods = forecastJson.properties?.periods as any[] | undefined
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error('weather.gov forecast response missing periods')
  }

  const p = periods[0]
  return {
    issuedAt: p.startTime as string,
    temperatureF: typeof p.temperature === 'number' ? p.temperature : null,
    windSpeedText: typeof p.windSpeed === 'string' ? p.windSpeed : null,
    windDirection: typeof p.windDirection === 'string' ? p.windDirection : null,
    shortForecast: typeof p.shortForecast === 'string' ? p.shortForecast : null,
    isDaytime: typeof p.isDaytime === 'boolean' ? p.isDaytime : null,
  }
}

function parseWindSpeedMph(windSpeedText: string | null): number | null {
  if (!windSpeedText) return null
  const match = windSpeedText.match(/(d+)s*(?:tos*(d+))?s*mph/i)
  if (!match) return null
  const low = Number(match[1])
  const high = match[2] ? Number(match[2]) : low
  if (Number.isNaN(low) || Number.isNaN(high)) return null
  return (low + high) / 2
}

function computeBiteScore(
  temperatureF: number | null,
  windSpeedMph: number | null,
  shortForecast: string | null,
  isDaytime: boolean | null
): BiteScore {
  let score = 50
  const reasons: string[] = []

  if (temperatureF != null) {
    if (temperatureF >= 60 && temperatureF <= 80) {
      score += 15
      reasons.push('Ideal warm-water temperature range')
    } else if (temperatureF < 45 || temperatureF > 85) {
      score -= 15
      reasons.push('Suboptimal temperature for active feeding')
    } else {
      reasons.push('Neutral temperature band')
    }
  } else {
    reasons.push('No temperature data; neutral baseline')
  }

  if (windSpeedMph != null) {
    if (windSpeedMph >= 5 && windSpeedMph <= 15) {
      score += 10
      reasons.push('Moderate wind increases oxygenation and pushes bait to banks/points')
    } else if (windSpeedMph > 20) {
      score -= 10
      reasons.push('Very strong wind can reduce fishability despite active fish')
    } else if (windSpeedMph < 3) {
      score -= 5
      reasons.push('Flat calm often yields tougher bites in clear water')
    }
  } else {
    reasons.push('No wind data; neutral wind assumption')
  }

  const text = (shortForecast || '').toLowerCase()
  if (text.includes('cloudy') || text.includes('mostly cloudy') || text.includes('partly cloudy')) {
    score += 10
    reasons.push('Cloud cover extends feeding windows and lets fish roam shallower')
  }
  if (text.includes('rain') || text.includes('showers') || text.includes('storms')) {
    score += 5
    reasons.push('Precipitation/front conditions can trigger feeding activity before and during the system')
  }
  if (text.includes('sunny') || text.includes('clear')) {
    score -= 5
    reasons.push('Bright, clear conditions often push fish deeper or tight to cover')
  }

  if (isDaytime != null) {
    if (!isDaytime) {
      reasons.push('Nighttime conditions; some species feed heavily after dark')
    } else {
      reasons.push('Daytime conditions; focus on low-light windows')
    }
  }

  if (score < 0) score = 0
  if (score > 100) score = 100

  let level: BiteScore['level'] = 'fair'
  if (score <= 30) level = 'poor'
  else if (score <= 55) level = 'fair'
  else if (score <= 75) level = 'good'
  else level = 'excellent'

  return { score, level, reasons }
}

function predictSpecies(
  query: SpotsQuery,
  bite: BiteScore,
  temperatureF: number | null,
  shortForecast: string | null
): SpeciesPrediction[] {
  const base: SpeciesPrediction[] = [
    {
      species: 'Largemouth Bass',
      probability: 0.5,
      notes: ['Common warm-water predator', 'Often responds strongly to changing weather fronts'],
    },
    {
      species: 'Crappie',
      probability: 0.3,
      notes: ['Schooling panfish; sensitive to light and temperature changes'],
    },
    {
      species: 'Channel Catfish',
      probability: 0.2,
      notes: ['Opportunistic feeder; can bite through a wide range of conditions'],
    },
  ]

  if (query.species) {
    const target = base.find(
      s => s.species.toLowerCase().includes(query.species!.toLowerCase())
    )
    if (target) {
      target.probability = Math.min(0.9, target.probability + 0.25)
      target.notes.push('User-selected target species boosted')
    }
  }

  base.forEach(s => {
    let delta = 0
    if (bite.level === 'excellent') delta += 0.1
    if (bite.level === 'poor') delta -= 0.1

    if (temperatureF != null) {
      if (s.species === 'Crappie' && temperatureF >= 50 && temperatureF <= 70) {
        delta += 0.05
        s.notes.push('Temperature favorable for crappie activity')
      }
      if (s.species === 'Largemouth Bass' && temperatureF >= 60 && temperatureF <= 80) {
        delta += 0.05
        s.notes.push('Temperature favorable for warm-water bass activity')
      }
    }

    s.probability = Math.max(0.05, Math.min(0.95, s.probability + delta))
  })

  const sum = base.reduce((acc, s) => acc + s.probability, 0)
  if (sum > 0) {
    base.forEach(s => {
      s.probability = s.probability / sum
    })
  }

  return base
}

function recommendBaits(
  species: SpeciesPrediction[],
  bite: BiteScore,
  shortForecast: string | null,
  windSpeedMph: number | null
): BaitRecommendation[] {
  const text = (shortForecast || '').toLowerCase()

  const recs: BaitRecommendation[] = []

  const biteAggressive = bite.level === 'good' || bite.level === 'excellent'
  const windy = windSpeedMph != null && windSpeedMph >= 5
  const hasCloud = text.includes('cloudy') || text.includes('rain') || text.includes('showers') || text.includes('storms')

  species.forEach(sp => {
    if (sp.species === 'Largemouth Bass') {
      if (biteAggressive && (hasCloud || windy)) {
        recs.push({
          baitType: 'Moving baits (spinnerbaits, crankbaits, swimbaits) on wind-blown banks and points',
          confidence: 0.9,
          conditionsMatch: [
            'Aggressive bite score',
            'Wind/cloud conditions favor reaction strikes',
          ],
        })
      } else {
        recs.push({
          baitType: 'Finesse plastics and jigs around cover (docks, timber, rock)',
          confidence: 0.8,
          conditionsMatch: [
            'More neutral/negative bite score',
            'Clear or calm conditions favor slower presentations',
          ],
        })
      }
    }

    if (sp.species === 'Crappie') {
      recs.push({
        baitType: 'Small jigs or minnows vertically fished around brush piles and standing timber',
        confidence: 0.8,
        conditionsMatch: [
          'Crappie respond well to vertical presentations',
          'Brush and timber concentrate schools',
        ],
      })
    }

    if (sp.species === 'Channel Catfish') {
      recs.push({
        baitType: 'Prepared stink baits or cut bait on bottom near channels or wind-blown banks',
        confidence: 0.75,
        conditionsMatch: [
          'Catfish feed by scent; wind-blown banks concentrate food',
        ],
      })
    }
  })

  const byType = new Map<string, BaitRecommendation>()
  for (const r of recs) {
    const existing = byType.get(r.baitType)
    if (!existing || r.confidence > existing.confidence) {
      byType.set(r.baitType, r)
    }
  }

  return Array.from(byType.values()).sort((a, b) => b.confidence - a.confidence)
}

function buildMicroSpots(
  query: SpotsQuery,
  bite: BiteScore,
  species: SpeciesPrediction[],
  baits: BaitRecommendation[]
): MicroSpot[] {
  const baseLat = query.lat
  const baseLon = query.lon

  const offsets = [
    { id: 'north-wind-bank', dLat: 0.001, dLon: 0 },
    { id: 'point-east', dLat: 0, dLon: 0.001 },
    { id: 'creek-channel-south', dLat: -0.001, dLon: 0 },
  ]

  return offsets.map((o, idx) => ({
    id: o.id,
    label:
      idx === 0
        ? 'Wind-blown bank'
        : idx === 1
        ? 'Main lake point'
        : 'Creek channel edge',
    lat: baseLat + o.dLat,
    lon: baseLon + o.dLon,
    biteScore: bite,
    bestSpecies: species,
    bestBaits: baits,
  }))
}

export async function GET(req: NextRequest) {
  try {
    const query = parseQuery(req)

    const wx = await fetchWeatherGovPointForecast(query.lat, query.lon)

    const windSpeedMph = parseWindSpeedMph(wx.windSpeedText)
    const bite = computeBiteScore(
      wx.temperatureF,
      windSpeedMph,
      wx.shortForecast,
      wx.isDaytime
    )

    const speciesLikely = predictSpecies(
      query,
      bite,
      wx.temperatureF,
      wx.shortForecast
    )

    const recommendedBaits = recommendBaits(
      speciesLikely,
      bite,
      wx.shortForecast,
      windSpeedMph
    )

    const microSpots = buildMicroSpots(
      query,
      bite,
      speciesLikely,
      recommendedBaits
    )

    const response: SpotsResponse = {
      query,
      conditions: {
        source: 'api.weather.gov',
        issuedAt: wx.issuedAt,
        temperatureF: wx.temperatureF,
        windSpeedMph,
        windDirection: wx.windDirection,
        shortForecast: wx.shortForecast,
        isDaytime: wx.isDaytime,
      },
      overallBite: bite,
      speciesLikely,
      recommendedBaits,
      microSpots,
    }

    return NextResponse.json(response, { status: 200 })
  } catch (err: any) {
    console.error('spots api error', err)
    return NextResponse.json(
      {
        error: 'Spots API error',
        message: err?.message ?? 'Unknown error',
      },
      { status: 400 }
    )
  }
}
