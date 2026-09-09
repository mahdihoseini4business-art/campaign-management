/**
 * Edge invoke error helper unit tests (no network).
 * Run: node scripts/test-edge-error.mjs
 */
import { readFunctionsInvokeError, functionsErrorStatus } from '../src/edge-error.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

{
  const msg = await readFunctionsInvokeError(null, 'fallback')
  assert(msg === 'fallback', 'null error')
}

{
  const msg = await readFunctionsInvokeError({ message: 'network down' }, 'x')
  assert(msg === 'network down', 'message fallback')
}

{
  const error = {
    message: 'Edge Function returned a non-2xx status code',
    context: {
      status: 403,
      json: async () => ({ success: false, error: 'دسترسی مجاز نیست' })
    }
  }
  const msg = await readFunctionsInvokeError(error, 'x')
  assert(msg === 'دسترسی مجاز نیست', 'body error')
  assert(functionsErrorStatus(error) === 403, 'status 403')
}

{
  const error = {
    message: 'boom',
    context: {
      status: 400,
      json: async () => { throw new Error('not json') }
    }
  }
  const msg = await readFunctionsInvokeError(error, 'x')
  assert(msg === 'boom', 'json fail uses message')
}

console.log('test-edge-error: ok')
