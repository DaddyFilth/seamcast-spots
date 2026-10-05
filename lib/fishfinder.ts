// Link to the Fishfinder Pro Supabase project (DaddyFilth/Fishfinder-pro), which has its own auth
// users. This app never reads Fishfinder's data tables; it only verifies Fishfinder sessions so that
// Fishfinder Pro users can log outings here. Server-side only.

function clean(value: string | undefined): string | null {
  const v = value?.trim()
  return v ? v : null
}

export function getFishfinderConfig(): { url: string; anonKey: string } | null {
  const rawUrl = clean(process.env.FISHFINDER_SUPABASE_URL)
  const anonKey = clean(process.env.FISHFINDER_SUPABASE_ANON_KEY)
  if (!rawUrl || !anonKey) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null
    return { url: parsed.origin, anonKey }
  } catch {
    return null
  }
}

// Returns the Fishfinder Pro user id for a valid access token, otherwise null.
export async function verifyFishfinderToken(token: string): Promise<string | null> {
  const config = getFishfinderConfig()
  if (!config) return null
  try {
    const res = await fetch(config.url + '/auth/v1/user', {
      headers: { apikey: config.anonKey, Authorization: 'Bearer ' + token },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const user: unknown = await res.json()
    const id = typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : null
    return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null
  } catch {
    return null
  }
}
