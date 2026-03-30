/**
 * IBKR Flex Query API client
 * ==========================
 * Two-step async protocol:
 *   1. SendRequest  → returns ReferenceCode + GetStatement URL
 *   2. GetStatement → poll until XML is ready (Status=Processing while generating)
 *
 * IBKR docs: https://www.interactivebrokers.com/en/software/am/am/reports/flex_queries_ref.htm
 */

const IBKR_BASE      = 'https://ndcdyn.interactivebrokers.com/Universal/servlet'
const POLL_INTERVAL  = 5_000   // ms between polls
const MAX_POLLS      = 12      // 12 × 5s = 60s timeout

/** Extracts content of a single XML tag (non-greedy, first match). */
function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m ? m[1].trim() : null
}

/** Step 1: Initiate the Flex Query request, returns reference code + poll URL. */
async function sendRequest(
  token: string,
  queryId: string,
): Promise<{ referenceCode: string; url: string }> {
  const url = `${IBKR_BASE}/FlexStatementService.SendRequest?t=${token}&q=${queryId}&v=3`
  const res = await fetch(url, { cache: 'no-store' })

  if (!res.ok) {
    throw new Error(`IBKR SendRequest HTTP ${res.status}`)
  }

  const xml    = await res.text()
  const status = extractTag(xml, 'Status')

  if (status !== 'Success') {
    const code = extractTag(xml, 'ErrorCode')
    const msg  = extractTag(xml, 'ErrorMessage')
    throw new Error(`IBKR SendRequest failed (${code}): ${msg}`)
  }

  const referenceCode = extractTag(xml, 'ReferenceCode')
  const getUrl        = extractTag(xml, 'Url')

  if (!referenceCode || !getUrl) {
    throw new Error('IBKR SendRequest: missing ReferenceCode or Url in response')
  }

  return { referenceCode, url: getUrl }
}

/** Step 2: Poll GetStatement until the XML statement is ready. */
async function pollStatement(
  getUrl: string,
  token: string,
  referenceCode: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL))
    }

    const url = `${getUrl}?t=${token}&q=${referenceCode}&v=3`
    const res = await fetch(url, { cache: 'no-store' })

    if (!res.ok) {
      throw new Error(`IBKR GetStatement HTTP ${res.status}`)
    }

    const xml = await res.text()

    // IBKR returns an operation message while still generating the statement
    if (xml.includes('<FlexStatementOperationMessage>')) {
      const status = extractTag(xml, 'Status')
      if (status === 'Processing') {
        continue
      }
      const code = extractTag(xml, 'ErrorCode')
      const msg  = extractTag(xml, 'ErrorMessage')
      throw new Error(`IBKR GetStatement error (${code}): ${msg}`)
    }

    // IBKR returns a FlexStatementResponse on errors (e.g. rate limit 1018)
    if (xml.includes('<FlexStatementResponse')) {
      const status = extractTag(xml, 'Status')
      if (status !== 'Success') {
        const code = extractTag(xml, 'ErrorCode')
        const msg  = extractTag(xml, 'ErrorMessage')
        // 1019 = "Statement generation in progress" → retry like Processing
        if (code === '1019') continue
        throw new Error(`IBKR error (${code}): ${msg}`)
      }
    }

    // Actual statement XML received
    return xml
  }

  throw new Error(
    `IBKR Flex Query timeout after ${(MAX_POLLS * POLL_INTERVAL) / 1000}s`,
  )
}

/**
 * Fetches a single IBKR Flex Query by ID and returns the raw XML string.
 * Handles the full SendRequest → polling → GetStatement flow.
 */
export async function fetchFlexQuery(token: string, queryId: string): Promise<string> {
  const { referenceCode, url } = await sendRequest(token, queryId)
  return pollStatement(url, token, referenceCode)
}
