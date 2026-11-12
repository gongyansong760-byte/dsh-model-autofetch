/**
 * dsh-model-autofetch — client half.
 *
 * Adds one 「拉取模型」button to every provider card in the Models settings page.
 * Pressing it asks the provider's own endpoint (through this plugin's host
 * route, so the stored credential never reaches the browser) what it serves, and
 * merges the ids the route does not list yet into the provider's `models`.
 *
 * Merge, never replace: an existing row keeps every field the user tuned by hand
 * (`reasoningEfforts`, `contextWindow`, …). Existing order is untouched and new
 * ids are appended in endpoint order.
 *
 * Plain JavaScript on purpose: the module loader factory must not depend on a
 * build step or on npm packages beyond React, which the host provides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-autofetch',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** Locale namespace this module owns. */
    const NS = 'model-autofetch'

    /** The host route that interrogates one endpoint. */
    const DISCOVER_PATH = '/api/dsh-model-autofetch/discover'

    /**
     * Per settings namespace: how the endpoint authenticates and which model
     * field carries the input modalities (the two families disagree on the name).
     */
    const FAMILIES = {
      'llm-pi-ai': { auth: 'bearer', field: 'input' },
      'llm-deepseek': { auth: 'x-api-key', field: 'inputModalities' },
    }

    /** Slot keys: the owner dispatches its provider cards by settings namespace. */
    const SLOT = 'settings.models.provider-card'

    const zh = {
      fetch: '拉取模型',
      fetching: '拉取中…',
      needBaseUrl: '这个提供商还没有 API 地址，先在自定义设置里填上',
      unavailable: '读不到模型设置，请刷新页面后重试',
      upToDate: '已是最新，没有新模型',
      added: '已添加 {n} 个模型',
      failed: '拉取失败：{message}',
    }
    const en = {
      fetch: 'Fetch models',
      fetching: 'Fetching…',
      needBaseUrl: 'This provider has no API address yet — set one under custom settings',
      unavailable: 'The model settings are unreadable; reload the page and retry',
      upToDate: 'Already up to date',
      added: 'Added {n} models',
      failed: 'Fetch failed: {message}',
    }

    const styles = {
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '12px 0 0' },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        padding: '3px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      busy: { opacity: 0.6, cursor: 'default' },
      error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      info: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      icon: { display: 'block', flex: 'none' },
    }

    /** Read a nested value by a string-key or array-index path. */
    function getPath(value, path) {
      let current = value
      for (const key of path) {
        if (Array.isArray(current)) {
          current = current[Number(key)]
          continue
        }
        if (typeof current !== 'object' || current === null) return undefined
        current = current[key]
      }
      return current
    }

    /** One settings `models` entry, carrying only what the endpoint disclosed. */
    function toEntry(candidate, field) {
      const entry = { id: candidate.id }
      if (typeof candidate.name === 'string' && candidate.name.length > 0) entry.name = candidate.name
      if (Number.isInteger(candidate.contextWindow) && candidate.contextWindow > 0) entry.contextWindow = candidate.contextWindow
      if (Number.isInteger(candidate.maxTokens) && candidate.maxTokens > 0) entry.maxTokens = candidate.maxTokens
      if (Array.isArray(candidate.inputModalities) && candidate.inputModalities.length > 0) entry[field] = [...candidate.inputModalities]
      return entry
    }

    /**
 * Reach the Remote facade's settings namespace.
 *
 * The facade is a Service of its own: `remote.settings` in the inject list does
 * not make `ctx.remote` readable, and a bare property access throws
 * "cannot get property remote without inject". `ctx.get` is the unguarded
 * accessor, so ask it first and only fall back to the declared property.
 *
 * @param ctx - client context this module applied with.
 * @returns the settings namespace facade, or `undefined` when unreachable.
 */
function remoteSettingsOf(ctx) {
  try {
    const facade = ctx.get?.('remote')
    if (facade?.settings !== undefined) return facade.settings
  } catch {
    /* an unreadable service is not a failure yet — try the declared property */
  }
  try {
    return ctx.remote?.settings
  } catch {
    return undefined
  }
}

/** Small refresh glyph; inherits the button's colour. */
    function RefreshIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', style: styles.icon, 'aria-hidden': true },
        h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.7-4' }),
        h('path', { d: 'M13.5 2.5v3.2h-3.2' }),
      )
    }

    /**
     * Build the card-face component for one context.
     * @param ctx - the client plugin context (Remote + locale access).
     * @param t - bound translator for {@link NS}.
     * @returns the provider-card extension component.
     */
    function makeCardFace(ctx, t) {
      return function ProviderFetchModels(props) {
        const provider = props.provider
        const [busy, setBusy] = useState(false)
        const [notice, setNotice] = useState(null)
        const timer = useRef(null)

        useEffect(
          () => () => {
            if (timer.current !== null) clearTimeout(timer.current)
          },
          [],
        )

        const say = useCallback((kind, text, sticky) => {
          setNotice({ kind, text })
          if (timer.current !== null) clearTimeout(timer.current)
          if (!sticky) timer.current = setTimeout(() => setNotice(null), 4000)
        }, [])

        const run = useCallback(async () => {
          const settingsNs = provider?.settingsNs
          const family = settingsNs === undefined ? undefined : FAMILIES[settingsNs]
          if (family === undefined) return
          setBusy(true)
          setNotice(null)
          try {
            const settings = remoteSettingsOf(ctx)
            if (settings === undefined) throw new Error(t('unavailable'))
            const settingsPath = Array.isArray(provider.settingsPath) ? provider.settingsPath : []
            const modelsPath = [...settingsPath, 'models']

            /** One fresh namespace row; the write needs the revision that is current now. */
            const readRow = async () => {
              const described = await settings.describe()
              if (described.ok !== true) throw new Error(t('unavailable'))
              const row = described.value.namespaces.find((entry) => entry.ns === settingsNs)
              if (row === undefined) throw new Error(t('unavailable'))
              return row
            }

            const profileOf = (row) => getPath(row.value, settingsPath) ?? {}

            // The endpoint and its credential come from the configuration; the
            // listing takes seconds, so nothing about the *write* is decided here.
            const first = profileOf(await readRow())
            const configured = typeof first.baseURL === 'string' ? first.baseURL.trim() : ''
            const baseURL = configured.length > 0 ? configured : (typeof provider.defaultBaseURL === 'string' ? provider.defaultBaseURL : '')
            if (baseURL.length === 0) throw new Error(t('needBaseUrl'))
            const apiKeyEnv = typeof first.apiKeyEnv === 'string' && first.apiKeyEnv.trim().length > 0 ? first.apiKeyEnv.trim() : undefined

            const response = await fetch(DISCOVER_PATH, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ baseURL, apiKeyEnv, auth: family.auth }),
            })
            const answer = await response.json().catch(() => null)
            if (answer === null || answer.ok !== true) {
              throw new Error(answer !== null && typeof answer.message === 'string' ? answer.message : `HTTP ${response.status}`)
            }

            // Merge against the value read after the listing, and re-merge once if
            // another card (same namespace) or the user committed first. Merging a
            // stale snapshot would drop whatever they just added.
            let row = await readRow()
            for (let attempt = 0; ; attempt += 1) {
              const existing = getPath(row.value, modelsPath)
              const list = Array.isArray(existing) ? existing : []
              const known = new Set(list.filter((model) => model !== null && typeof model?.id === 'string').map((model) => model.id))
              const added = []
              for (const candidate of answer.models) {
                if (candidate === null || typeof candidate?.id !== 'string' || candidate.id.length === 0) continue
                if (known.has(candidate.id)) continue
                known.add(candidate.id)
                added.push(toEntry(candidate, family.field))
              }
              if (added.length === 0) {
                say('info', t('upToDate'))
                return
              }

              const written = await settings.mutate(settingsNs, [{ op: 'set', path: modelsPath, value: [...list, ...added] }], row.revision)
              if (written.ok === true) {
                say('info', t('added').replace('{n}', String(added.length)))
                return
              }
              const conflict =
                written.error?.code === 'settings/conflict' || /conflict/i.test(String(written.error?.message ?? ''))
              if (!conflict || attempt >= 1) throw new Error(written.error?.message ?? t('unavailable'))
              row = await readRow()
            }
          } catch (error) {
            say('error', t('failed').replace('{message}', String(error?.message ?? error)), true)
          } finally {
            setBusy(false)
          }
        }, [provider, say, t])

        if (provider === undefined || FAMILIES[provider.settingsNs] === undefined) return null

        return h(
          'div',
          { style: styles.row },
          h(
            'button',
            {
              type: 'button',
              style: busy ? { ...styles.button, ...styles.busy } : styles.button,
              disabled: busy,
              onClick: run,
            },
            h(RefreshIcon),
            busy ? t('fetching') : t('fetch'),
          ),
          notice === null ? null : h('p', { style: notice.kind === 'error' ? styles.error : styles.info, role: notice.kind === 'error' ? 'alert' : 'status' }, notice.text),
        )
      }
    }

    /**
     * Register the card face into every provider card this build can fetch for.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'model-autofetch: zh copy')
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'model-autofetch: en copy')
      const t = ctx.locale.bind(NS)
      const CardFace = makeCardFace(ctx, t)

      for (const key of Object.keys(FAMILIES)) {
        ctx.effect(
          () =>
            ctx.slots.inject(SLOT, () =>
              ctx.slots.register({ name: SLOT, key, id: `model-autofetch:${key}` }, CardFace),
            ),
          `model-autofetch: ${key} card face`,
        )
      }
    }

    // `remote` must be declared alongside `remote.settings`: the Remote facade is
    // a Service of its own, and `remote.settings` alone leaves `ctx.remote`
    // unreachable ("cannot get property remote without inject").
    return { apply, inject: ['slots', 'locale', 'remote', 'remote.settings'] }
  },
})