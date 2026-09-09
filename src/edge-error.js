/**
 * Extract Persian/server error message from supabase.functions.invoke failures.
 * Edge non-2xx usually puts JSON `{ success, error }` in the Response body.
 */
export async function readFunctionsInvokeError(error, fallback = 'خطای سرور') {
  if (!error) return fallback
  try {
    const ctx = error.context
    if (ctx && typeof ctx.json === 'function') {
      const body = await ctx.json()
      if (body && typeof body.error === 'string' && body.error.trim()) {
        return body.error.trim()
      }
      if (body && typeof body.message === 'string' && body.message.trim()) {
        return body.message.trim()
      }
    }
  } catch {
    /* body already consumed or not JSON */
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  return fallback
}

export function functionsErrorStatus(error) {
  const status = error?.context?.status ?? error?.status
  return typeof status === 'number' ? status : undefined
}
