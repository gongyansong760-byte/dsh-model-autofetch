/**
 * Local verification for dsh-model-autofetch's host half.
 *
 * Run: node test/host.test.mjs
 *
 * Covers the listing parser against the three reply shapes a compatible gateway
 * returns, and the discovery client against a real endpoint without a key (the
 * expected answer there is a 401 report, not a crash or an empty list).
 */
import assert from 'node:assert/strict'
import { __internals } from '../index.js'

const { discover, readListing, listingUrl, candidateOf } = __internals

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

check('openai data[] shape', () => {
  const models = readListing({
    object: 'list',
    data: [
      { id: 'alpha', object: 'model' },
      { id: 'beta', name: 'Beta Pro', context_window: 200000, max_completion_tokens: 8192 },
      { id: 'alpha' },
      { bogus: true },
    ],
  })
  assert.deepEqual(models, [
    { id: 'alpha' },
    { id: 'beta', name: 'Beta Pro', contextWindow: 200000, maxTokens: 8192 },
  ])
})

check('enriched models object shape', () => {
  const models = readListing({
    models: {
      gamma: { display_name: 'Gamma', limits: { context_window: 128000, max_output_tokens: 4096 } },
      delta: { id: 'delta', architecture: { input_modalities: ['text', 'image', 'audio'] } },
    },
  })
  assert.deepEqual(models, [
    { id: 'gamma', name: 'Gamma', contextWindow: 128000, maxTokens: 4096 },
    { id: 'delta', inputModalities: ['text', 'image'] },
  ])
})

check('anthropic-ish entries keep only known modalities', () => {
  const candidate = candidateOf({ id: 'x', input_modalities: ['vision', 'TEXT'] })
  assert.deepEqual(candidate, { id: 'x', inputModalities: ['text'] })
})

check('a name equal to the id is dropped', () => {
  assert.deepEqual(candidateOf({ id: 'same', name: 'same' }), { id: 'same' })
})

check('listing url strips trailing slashes only', () => {
  assert.equal(listingUrl('https://relay.example/v1/'), 'https://relay.example/v1/models')
  assert.equal(listingUrl('https://relay.example/openai/v1'), 'https://relay.example/openai/v1/models')
})

check('rejects a non-http endpoint before any request', async () => {
  const answer = await discover({ baseURL: 'ftp://relay.example/v1' }, undefined)
  assert.equal(answer.ok, false)
  assert.match(answer.message, /HTTP/)
})

const live = await discover({ baseURL: 'https://www.acctoken.com/v1', auth: 'bearer' }, undefined)
check('live endpoint without a key reports 401 instead of failing silently', () => {
  assert.equal(live.ok, false)
  assert.match(live.message, /401/)
})

const liveKeyed = await discover({ baseURL: 'https://maas.qianwenaiapi.com/compatible-mode/v1', auth: 'bearer' }, undefined)
check('second live endpoint also reports its status', () => {
  assert.equal(liveKeyed.ok, false)
  assert.match(liveKeyed.message, /401/)
})

// Transport faults are retried once: a local proxy restart shows up as a
// one-off `fetch failed` and used to end a perfectly good listing attempt.
{
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const answer = await discover({ baseURL: 'https://relay.example/v1', auth: 'bearer' }, undefined)
  globalThis.fetch = original
  check('retries one transport fault and then succeeds', () => {
    assert.equal(calls, 2)
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.models, [{ id: 'a' }, { id: 'b' }])
  })
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')