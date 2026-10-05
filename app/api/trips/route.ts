import { NextRequest, NextResponse } from 'next/server'
import { ApiError, isRecord } from '@/lib/conditions'
import { normalizeConditions, snapshotForLog } from '@/lib/history'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function optionalText(body: Record<string, unknown>, key: string): string | null {
  const v = body[key]
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.trim().length > 100) throw new ApiError(`${key} must be a string of at most 100 characters`, 400)
  return v.trim() || null
}

function optionalNumber(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ApiError(`${key} must be a number from ${min} to ${max}`, 400)
  return v
}

// POST /api/trips: log an outing (caught fish or not) with the real conditions at that time.
// Requires the signed-in user's Supabase access token; row-level security enforces ownership.
export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!supabaseUrl || !anonKey) throw new ApiError('Supabase is not configured', 500)

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
    if (!token) throw new ApiError('Authorization bearer token required', 401)

    const userRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!userRes.ok) throw new ApiError('Invalid or expired token', 401)
    const user: unknown = await userRes.json()
    if (!isRecord(user) || typeof user.id !== 'string') throw new ApiError('Invalid or expired token', 401)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Request body must be JSON', 400)
    }
    if (!isRecord(body)) throw new ApiError('Request body must be a JSON object', 400)

    const lat = optionalNumber(body, 'lat', -90, 90)
    const lon = optionalNumber(body, 'lon', -180, 180)
    if (lat === null || lon === null) throw new ApiError('lat and lon are required', 400)
    if (typeof body.startedAt !== 'string' || Number.isNaN(Date.parse(body.startedAt))) {
      throw new ApiError('startedAt must be an ISO date-time', 400)
    }
    const startedAt = new Date(body.startedAt)
    if (startedAt.getTime() > Date.now() + 5 * 60_000) throw new ApiError('startedAt cannot be in the future', 400)
    const durationHours = optionalNumber(body, 'durationHours', 0.01, 48)
    if (durationHours === null) throw new ApiError('durationHours is required', 400)
    if (typeof body.caught !== 'boolean') throw new ApiError('caught must be true or false', 400)
    if (body.shareForMatching !== undefined && typeof body.shareForMatching !== 'boolean') {
      throw new ApiError('shareForMatching must be a boolean', 400)
    }
    const fishCount = optionalNumber(body, 'fishCount', 0, 1000)
    const waterbodyId = body.waterbodyId ?? null
    if (waterbodyId !== null && (typeof waterbodyId !== 'string' || !UUID.test(waterbodyId))) {
      throw new ApiError('waterbodyId must be a UUID', 400)
    }
    const species = optionalText(body, 'species')
    const bait = optionalText(body, 'bait')
    const depthFt = optionalNumber(body, 'depthFt', 0, 1000)

    const { conditions, environment } = await snapshotForLog({ lat, lon }, startedAt)
    const n = normalizeConditions(conditions, environment, startedAt, lat)

    const insert = await fetch(supabaseUrl + '/rest/v1/trip_logs', {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_id: user.id,
        waterbody_id: waterbodyId,
        lat,
        lon,
        started_at: startedAt.toISOString(),
        duration_hours: durationHours,
        caught: body.caught,
        fish_count: fishCount,
        species,
        bait,
        depth_ft: depthFt,
        conditions: { weather: conditions, environment },
        pressure_trend_hpa: n.pressureTrendHpa,
        air_temp_f: n.airTempF,
        water_temp_f: n.waterTempF,
        wind_mph: n.windMph,
        cloud_cover_pct: n.cloudCoverPct,
        moon_illumination_pct: n.moonIlluminationPct,
        season: n.season,
        time_of_day: n.timeOfDay,
        share_for_matching: body.shareForMatching === true,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!insert.ok) throw new ApiError('Unable to save the trip', insert.status === 401 || insert.status === 403 ? insert.status : 502)
    const saved: unknown = await insert.json()
    return NextResponse.json({ trip: Array.isArray(saved) ? saved[0] : saved, normalizedConditions: n }, { status: 201 })
  } catch (err: unknown) {
    console.error('trips api error', err)
    return NextResponse.json(
      { error: 'Trips API error', message: err instanceof Error ? err.message : 'Unknown error' },
      { status: err instanceof ApiError ? err.status : 500 }
    )
  }
}
