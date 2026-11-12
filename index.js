/**
 * dsh-model-autofetch — host half.
 *
 * The Models settings page can already ask a provider for its models, but that
 * path answers from the adapter's installed catalog first: a route named after a
 * catalog provider (for example `openai` pointed at a relay) gets the catalog
 * back instead of what the endpoint actually serves, and an adapter without a
 * discovery hook (llm-deepseek) has no such path at all.
 *
 * This module offers the missing primitive: one same-origin route that asks the
 * endpoint named by the route's own configuration, authenticated with the
 * credential this profile already stores for it, and returns the advertised
 * model ids. It writes nothing — the page decides what to adopt.
 *
 * All routes mount on the DSH host webserver's own origin and run the same guard
 * the Web UI uses (`connection.requestRejection`), so the button is exactly as
 * reachable — and exactly as protected — as the page it lives in.
 *
 * @module dsh-model-autofetch
 */

/** Plugin name used by the Cordis loader row. */
export const name = 'dsh-model-autofetch'

/** Every route this plugin owns. */
const BASE_PATH = '/api/dsh-model-autofetch'

/** Largest accepted JSON control body. */
const MAX_BODY_BYTES = 16 * 1024

/** Largest accepted listing payload, mirroring the adapter's own ceiling. */
const MAX_LIST_BYTES = 4 * 1024 * 1024

/** Endpoint budget for one listing request. */
const TIMEOUT_MS = 20_000

/** Input modalities this harness understands, in listing order. */
const MODALITIES = new Set(['text', 'image'])

/** Write a JSON response. */
function writeJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** Read a small JSON request body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Reject a request the GUI itself would reject. */
function rejected(connection, req, res) {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/** A positive integer field, or `undefined` when absent or unusable. */
function positiveInt(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
    if (typeof candidate === 'string' && /^\d+$/.test(candidate) && Number(candidate) > 0) return Number(candidate)
  }
}

/** A non-empty string field, or `undefined`. */
function nonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
}

/** Normalize one modality list to the vocabulary the settings schemas accept. */
function modalitiesOf(...candidates) {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const kept = [...new Set(candidate.map((entry) => (typeof entry === 'string' ? entry.toLowerCase() : '')).filter((entry) => MODALITIES.has(entry)))]
    if (kept.length > 0) return kept
  }
}

/**
 * Read one listing entry from any of the shapes a compatible gateway returns.
 * @param entry - one advertised model record.
 * @returns the harness-neutral candidate, or `undefined` when it names no id.
 */
function candidateOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = nonEmptyString(entry.id, entry.model, entry.slug, entry.name)
  if (id === undefined) return undefined
  const labelled = nonEmptyString(entry.display_name, entry.displayName, entry.label)
  // A plain `name` equal to the id states nothing; keep the field off instead.
  const name = labelled ?? (entry.name === id ? undefined : nonEmptyString(entry.name))
  const contextWindow = positiveInt(
    entry.context_window,
    entry.contextWindow,
    entry.context_length,
    entry.max_context_length,
    entry.max_input_tokens,
    entry.input_token_limit,
    entry.limits?.context_window,
    entry.top_provider?.context_length,
  )
  const maxTokens = positiveInt(
    entry.max_completion_tokens,
    entry.max_output_tokens,
    entry.maxTokens,
    entry.output_token_limit,
    entry.limits?.max_output_tokens,
    entry.top_provider?.max_completion_tokens,
  )
  const inputModalities = modalitiesOf(
    entry.input_modalities,
    entry.inputModalities,
    entry.architecture?.input_modalities,
    entry.capabilities?.input_modalities,
  )
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
  }
}

/**
 * Extract the model list from a listing reply.
 * @param body - parsed JSON reply.
 * @returns candidates in endpoint order, de-duplicated by id.
 */
function readListing(body) {
  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : body?.models !== null && typeof body?.models === 'object'
        ? Object.entries(body.models).map(([key, value]) =>
            value !== null && typeof value === 'object' && nonEmptyString(value.id) === undefined
              ? { id: key, ...value }
              : value,
          )
        : []
  const seen = new Set()
  const models = []
  for (const row of rows) {
    const candidate = candidateOf(row)
    if (candidate === undefined || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    models.push(candidate)
  }
  return models
}

/** The protocol's listing URL, treating the configured base as a prefix. */
function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/** Auth headers for one attempt. */
function authHeaders(auth, key) {
  const headers = { accept: 'application/json' }
  if (key === undefined) return headers
  if (auth === 'x-api-key') headers['x-api-key'] = key
  else headers.authorization = `Bearer ${key}`
  return headers
}

/** Join an endpoint and read at most {@link MAX_LIST_BYTES} of JSON. */
async function ask(url, headers) {
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) {
    await response.body?.cancel()
    return { status: response.status, ok: false }
  }
  const chunks = []
  let total = 0
  if (response.body !== null) {
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > MAX_LIST_BYTES) {
        await response.body.cancel?.()
        return { status: response.status, ok: false, oversized: true }
      }
      chunks.push(chunk)
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return { status: response.status, ok: true, body: JSON.parse(text) }
  } catch {
    return { status: response.status, ok: true, body: undefined, notJson: true }
  }
}

/**
 * One listing attempt, retried once on a transport error.
 *
 * The host process may route through a local proxy, and a proxy restart shows up
 * as a one-off `fetch failed` rather than a status code. A timeout is *not*
 * retried: that doubles a wait the user is already watching.
 *
 * @param url - listing URL.
 * @param headers - request headers.
 * @returns the reply, or whatever the second attempt reports.
 */
async function askOnceWithRetry(url, headers) {
  try {
    return await ask(url, headers)
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error
    await new Promise((resolve) => setTimeout(resolve, 300))
    return await ask(url, headers)
  }
}

/**
 * Interrogate one endpoint for the models it advertises.
 * @param request - `{ baseURL, apiKeyEnv, auth }` from the page.
 * @param credentials - the host's credential service, when composed.
 * @returns `{ ok: true, models }` or `{ ok: false, message }`.
 */
async function discover(request, credentials) {
  let url
  try {
    const parsed = new URL(request.baseURL)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: 'API 地址必须是 HTTP 或 HTTPS' }
    url = listingUrl(request.baseURL.trim())
  } catch {
    return { ok: false, message: 'API 地址无法解析成网址' }
  }

  let key
  if (typeof request.apiKeyEnv === 'string' && request.apiKeyEnv.length > 0 && credentials !== undefined) {
    try {
      const hit = await credentials.resolve(request.apiKeyEnv)
      key = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
    } catch {
      key = undefined
    }
  }

  const primary = request.auth === 'x-api-key' ? 'x-api-key' : 'bearer'
  const alternate = primary === 'bearer' ? 'x-api-key' : 'bearer'
  const attempts = key === undefined ? [primary] : [primary, alternate]

  let last = { status: 0 }
  for (const auth of attempts) {
    let reply
    try {
      reply = await askOnceWithRetry(url, authHeaders(auth, key))
    } catch (error) {
      const name = error?.name === 'TimeoutError' ? '请求超时' : '无法连接'
      return { ok: false, message: `${name}：${url}` }
    }
    if (reply.ok && reply.oversized === true) return { ok: false, message: '端点返回的模型列表超过 4MB' }
    if (reply.ok && reply.notJson === true) return { ok: false, message: `${url} 返回的不是 JSON` }
    if (reply.ok) {
      const models = readListing(reply.body)
      if (models.length === 0) return { ok: false, message: '端点没有列出任何模型' }
      return { ok: true, models, url }
    }
    last = reply
    if (reply.status !== 401 && reply.status !== 403) break
  }

  const hint = last.status === 401 || last.status === 403 ? '（检查该提供商的 API 密钥）' : ''
  return { ok: false, message: `${url} 返回 ${last.status || '错误'}${hint}` }
}

/**
 * Mount the plugin's route once the host webserver and its request guard are up.
 * @param ctx - host context.
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
    } catch {
      /* an unavailable logger service is not worth failing a request over */
    }
  }
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const route = {
      kind: 'exact',
      path: `${BASE_PATH}/discover`,
      handler: async (req, res) => {
        if (rejected(webCtx.connection, req, res)) return
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { ok: false, message: 'method not allowed' })
        try {
          const body = await readJson(req)
          const baseURL = typeof body.baseURL === 'string' ? body.baseURL : ''
          if (baseURL.trim().length === 0) return writeJson(res, 400, { ok: false, message: '缺少 API 地址' })
          const result = await discover(
            {
              baseURL,
              apiKeyEnv: typeof body.apiKeyEnv === 'string' ? body.apiKeyEnv : undefined,
              auth: typeof body.auth === 'string' ? body.auth : undefined,
            },
            ctx.get('credentials'),
          )
          // Answer only — never the key, only the address and outcome, so a
          // failure the page shows for four seconds stays diagnosable later.
          if (result.ok === true) log('info', `discover ok: ${result.url} → ${result.models.length} models`)
          else log('warn', `discover rejected: ${baseURL} → ${result.message}`)
          writeJson(res, 200, result)
        } catch (error) {
          log('warn', `discover failed: ${error?.message ?? error}`)
          writeJson(res, 500, { ok: false, message: String(error?.message ?? error) })
        }
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), `model-autofetch: ${route.path}`)
    log('info', `model discovery mounted on ${BASE_PATH}/discover`)
  })
}

export default apply

/** Internals exported for local verification only; not part of the plugin API. */
export const __internals = { discover, readListing, candidateOf, listingUrl }