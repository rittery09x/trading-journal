import { createServiceClient } from '@/lib/supabase/server'

export type LogLevel  = 'info' | 'warning' | 'error'
export type LogSource = 'ibkr' | 'parser' | 'supabase' | 'system'

/**
 * Writes a structured log entry to the import_logs table.
 * Never throws — logging failures are swallowed so they never break the
 * main import flow.
 */
export async function logImport(
  level: LogLevel,
  source: LogSource,
  message: string,
  details?: Record<string, unknown>,
  importRunId?: string,
): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('import_logs').insert({
      level,
      source,
      message,
      details:       details       ?? null,
      import_run_id: importRunId   ?? null,
    })
  } catch {
    // Never let a logging failure surface to the user
    console.error('[logger] Failed to write import log:', message)
  }
}
