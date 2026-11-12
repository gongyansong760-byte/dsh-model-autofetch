/**
 * Local verification for dsh-model-autofetch's client half.
 *
 * Run: node test/client.test.mjs
 *
 * Loads the real `client.js` through a stubbed module loader (no browser, no
 * React install): the factory is the artifact under test, so everything it
 * touches — React hooks, the Cordis context, the Remote calls, `fetch` — is a
 * hand-written stand-in whose calls are recorded.
 *
 * Covers: both slot keys register, the button renders, a click reads the live
 * settings describe, posts the route's own endpoint, and writes a merged array
 * (existing rows untouched, new ids appended) with the family's field name.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

/* ------------------------------------------------------------------ React stub */

let hookStates = []
let hookIndex = 0

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState(initial) {
    const at = hookIndex++
    if (!(at in hookStates)) hookStates[at] = typeof initial === 'function' ? initial() : initial
    return [
      hookStates[at],
      (next) => {
        hookStates[at] = typeof next === 'function' ? next(hookStates[at]) : next
      },
    ]
  },
  useRef(initial) {
    const at = hookIndex++
    if (!(at in hookStates)) hookStates[at] = { current: initial }
    return hookStates[at]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

/** Render a function component from scratch, returning its element tree. */
const render = (Component, props) => {
  hookStates = []
  hookIndex = 0
  return Component(props)
}

/**
 * Render one mounted instance whose hooks survive re-renders, the way React
 * keeps them for a mounted component. `update` is the re-render pass.
 */
const mountComponent = (Component, props) => {
  hookStates = []
  let element
  const pass = (nextProps) => {
    hookIndex = 0
    element = Component(nextProps)
    return element
  }
  pass(props)
  return {
    tree: () => element,
    update: (nextProps = props) => pass(nextProps),
  }
}

/** Depth-first search for elements matching a predicate. */
const findAll = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/** Concatenated text of one element tree. */
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

/* ------------------------------------------------------------------ module load */

/** Install the module loader stub for one load and return the registered factory. */
async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const window = {
    __ModuleLoader__: {
      load: (registration) => {
        loaded = registration
      },
    },
  }
  const run = new Function('window', source)
  run(window)
  assert.equal(loaded.id, 'dsh-model-autofetch', 'module id must match the package name')
  return loaded.factory((id) => {
    assert.equal(id, 'react', `unexpected module request: ${id}`)
    return React
  })
}

/** A Cordis-like client context recording every registration and Remote call. */
function makeContext(state, options = {}) {
  const settings = {
    describe: async () => state.describe(),
    mutate: async (ns, ops, revision) => {
      state.mutations.push({ ns, ops, revision })
      return { ok: true, value: {} }
    },
  }
  const ctx = {
    get: (name) => (name === 'remote' ? options.facade : undefined),
    effect: (factory) => {
      state.effects.push(factory)
      // Cordis runs the factory at once and keeps its result as the disposer.
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (ns, locale, dict) => {
        state.locales.push({ ns, locale, dict })
        return () => {}
      },
      bind: () => (key, vars) => {
        const dict = state.locales.find((entry) => entry.locale === state.locale)?.dict ?? {}
        let text = dict[key] ?? key
        for (const [name, value] of Object.entries(vars ?? {})) text = text.replace(`{${name}}`, String(value))
        return text
      },
    },
    slots: {
      inject: (name, callback) => {
        state.injected.push(name)
        return callback()
      },
      register: (options, Component) => {
        state.registrations.push({ options, Component })
        return () => {}
      },
    },
    remote: { settings },
  }
  if (options.strictRemote === true) {
    // Mirror Cordis: reading an undeclared Service throws instead of reading
    // undefined, which is exactly the failure the live page reported.
    Object.defineProperty(ctx, 'remote', {
      get() {
        throw new Error('cannot get property "remote" without inject')
      },
    })
  }
  return ctx
}

const settingsRow = (ns, value, revision = 7) => ({ ns, revision, value })

/** Load, apply, and hand back the registered card face plus recorded state. */
async function mount({
  models,
  baseURL = 'https://relay.example/v1',
  apiKeyEnv = 'RELAY_API_KEY',
  ns = 'llm-pi-ai',
  strictRemote = false,
  describeSteps = [],
  mutateResults = [],
}) {
  const exports = await loadClient()
  const value = () =>
    ns === 'llm-pi-ai' ? { providers: { relay: { baseURL, apiKeyEnv, models } } } : { baseURL, apiKeyEnv, models }
  const state = {
    effects: [],
    locales: [],
    injected: [],
    registrations: [],
    mutations: [],
    locale: 'zh',
    // Each describe consumes one scripted row when the test supplies any, so a
    // test can make the second read differ from the first (a concurrent write).
    describe: async () => ({
      ok: true,
      value: { namespaces: [describeSteps.length > 0 ? describeSteps.shift() : settingsRow(ns, value())] },
    }),
  }
  const settings = {
    describe: async () => state.describe(),
    mutate: async (namespaced, ops, revision) => {
      state.mutations.push({ ns: namespaced, ops, revision })
      return mutateResults.length > 0 ? mutateResults.shift() : { ok: true, value: {} }
    },
  }
  const ctx = makeContext(state, { strictRemote, facade: { settings } })
  exports.apply(ctx)
  return { state, registrations: state.registrations }
}

/* ---------------------------------------------------------------------- checks */

await check('retries once when the sibling card committed first (settings/conflict)', async () => {
  const mine = { providers: { relay: { baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY', models: [{ id: 'keep' }] } } }
  const theirs = {
    providers: { relay: { baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY', models: [{ id: 'keep' }, { id: 'from-other-card' }] } },
  }
  const { registrations, state } = await mount({
    models: [{ id: 'keep' }],
    describeSteps: [settingsRow('llm-pi-ai', mine, 7), settingsRow('llm-pi-ai', mine, 7), settingsRow('llm-pi-ai', theirs, 8)],
    mutateResults: [
      { ok: false, error: { code: 'settings/conflict', message: 'settings/conflict: expected revision 7' } },
      { ok: true, value: {} },
    ],
  })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, models: [{ id: 'keep' }, { id: 'fresh' }] }) })
  const props = { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } }
  const view = mountComponent(registrations[0].Component, props)
  await findAll(view.tree(), (node) => node.type === 'button')[0].props.onClick()
  assert.equal(state.mutations.length, 2, 'one rejected attempt, then one retry')
  assert.equal(state.mutations[0].revision, 7)
  assert.equal(state.mutations[1].revision, 8, 'the retry carries the revision read after the conflict')
  assert.deepEqual(
    state.mutations[1].ops[0].value,
    [{ id: 'keep' }, { id: 'from-other-card' }, { id: 'fresh' }],
    'the retry re-merges onto what the other card wrote instead of overwriting it',
  )
  assert.match(textOf(view.update()), /已添加 1 个模型/)
})

await check('a non-conflict rejection is reported, not retried', async () => {
  const { registrations, state } = await mount({
    models: [],
    mutateResults: [{ ok: false, error: { code: 'settings/readonly', message: 'settings/readonly: providers' } }],
  })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, models: [{ id: 'x' }] }) })
  const props = { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } }
  const view = mountComponent(registrations[0].Component, props)
  await findAll(view.tree(), (node) => node.type === 'button')[0].props.onClick()
  assert.equal(state.mutations.length, 1)
  assert.match(textOf(view.update()), /settings\/readonly/)
})

await check('survives a context whose remote property throws (the live failure)', async () => {
  const { registrations, state } = await mount({ models: [{ id: 'keep' }], strictRemote: true })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, models: [{ id: 'keep' }, { id: 'added' }] }) })
  const props = { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } }
  const view = mountComponent(registrations[0].Component, props)
  await findAll(view.tree(), (node) => node.type === 'button')[0].props.onClick()
  assert.equal(state.mutations.length, 1, 'the click must still reach mutate through ctx.get')
  const text = textOf(view.update())
  assert.equal(/cannot get property/.test(text), false, 'no inject error may surface')
  assert.match(text, /已添加 1 个模型/)
})

await check('declares the Remote facade, not just its settings namespace', async () => {
  const exports = await loadClient()
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote', 'remote.settings'])
})

await check('registers both provider-card keys and both locale dictionaries', async () => {
  const { state, registrations } = await mount({ models: [] })
  assert.deepEqual(
    registrations.map((entry) => entry.options.key),
    ['llm-pi-ai', 'llm-deepseek'],
  )
  assert.deepEqual(registrations.map((entry) => entry.options.name), ['settings.models.provider-card', 'settings.models.provider-card'])
  assert.deepEqual(state.injected, ['settings.models.provider-card', 'settings.models.provider-card'])
  assert.deepEqual(state.locales.map((entry) => entry.locale).sort(), ['en', 'zh'])
})

await check('renders one button labelled 拉取模型', async () => {
  const { registrations } = await mount({ models: [] })
  const CardFace = registrations[0].Component
  const tree = render(CardFace, { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } })
  const buttons = findAll(tree, (node) => node.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props.type, 'button')
  assert.equal(textOf(buttons[0]), '拉取模型')
})

await check('renders nothing for a namespace it does not serve', async () => {
  const { registrations } = await mount({ models: [] })
  const tree = render(registrations[0].Component, { provider: { provider: 'other', settingsNs: 'llm-unknown', settingsPath: [] } })
  assert.equal(tree, null)
})

await check('pi-ai click merges new ids after the untouched existing rows', async () => {
  const existing = [{ id: 'keep-me', name: 'Keep', reasoningEfforts: { off: 'none', high: 'high' } }]
  const { registrations, state } = await mount({ models: existing })
  const posts = []
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        models: [
          { id: 'keep-me' },
          { id: 'fresh-1', name: 'Fresh One', contextWindow: 128000, maxTokens: 4096, inputModalities: ['text', 'image'] },
        ],
      }),
    }
  }
  const tree = render(registrations[0].Component, { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } })
  await findAll(tree, (node) => node.type === 'button')[0].props.onClick()
  assert.deepEqual(posts, [
    { url: '/api/dsh-model-autofetch/discover', body: { baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY', auth: 'bearer' } },
  ])
  assert.equal(state.mutations.length, 1)
  const [mutation] = state.mutations
  assert.equal(mutation.ns, 'llm-pi-ai')
  assert.equal(mutation.revision, 7)
  assert.deepEqual(mutation.ops, [
    {
      op: 'set',
      path: ['providers', 'relay', 'models'],
      value: [
        existing[0],
        { id: 'fresh-1', name: 'Fresh One', contextWindow: 128000, maxTokens: 4096, input: ['text', 'image'] },
      ],
    },
  ])
  // The existing row is the very same object, not a rebuilt copy.
  assert.equal(mutation.ops[0].value[0], existing[0])
})

await check('deepseek click writes inputModalities at the namespace root', async () => {
  const { registrations, state } = await mount({ ns: 'llm-deepseek', models: [{ id: 'deepseek-v4-flash' }] })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro', inputModalities: ['text'] }] }),
  })
  const CardFace = registrations.find((entry) => entry.options.key === 'llm-deepseek').Component
  const tree = render(CardFace, { provider: { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] } })
  await findAll(tree, (node) => node.type === 'button')[0].props.onClick()
  const [mutation] = state.mutations
  assert.equal(mutation.ns, 'llm-deepseek')
  assert.deepEqual(mutation.ops, [
    {
      op: 'set',
      path: ['models'],
      value: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro', inputModalities: ['text'] }],
    },
  ])
})

await check('nothing new means no write at all', async () => {
  const { registrations, state } = await mount({ models: [{ id: 'same' }] })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, models: [{ id: 'same' }] }) })
  const view = mountComponent(registrations[0].Component, { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } })
  await findAll(view.tree(), (node) => node.type === 'button')[0].props.onClick()
  assert.equal(state.mutations.length, 0)
  assert.match(textOf(view.update()), /已是最新/)
})

await check('a host refusal surfaces as one error line and writes nothing', async () => {
  const { registrations, state } = await mount({ models: [] })
  globalThis.fetch = async () => ({ ok: false, status: 200, json: async () => ({ ok: false, message: 'https://relay.example/v1/models 返回 401（检查该提供商的 API 密钥）' }) })
  const props = { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } }
  const view = mountComponent(registrations[0].Component, props)
  await findAll(view.tree(), (node) => node.type === 'button')[0].props.onClick()
  assert.equal(state.mutations.length, 0)
  const errors = findAll(view.update(), (node) => node.props?.role === 'alert')
  assert.equal(errors.length, 1)
  assert.match(textOf(errors[0]), /401/)
})

await check('a provider with no address explains what to fill in', async () => {
  const { registrations, state } = await mount({ models: [], baseURL: '' })
  const props = { provider: { provider: 'relay', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'relay'] } }
  const view = mountComponent(registrations[0].Component, props)
  await findAll(view.tree(), (node) => node.type === 'button')[0].props.onClick()
  assert.equal(state.mutations.length, 0)
  assert.match(textOf(view.update()), /API 地址/)
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)