import { createBrowserClient as createSupabaseSSRClient } from '@supabase/ssr'

/**
 * Browser-side Supabase client using the anon key.
 * Uses @supabase/ssr so that session tokens are stored in cookies
 * and are visible to the middleware (required for server-side auth checks).
 */
export function createBrowserClient() {
  return createSupabaseSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
