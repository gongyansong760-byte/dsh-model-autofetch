# dsh-model-autofetch

English · [简体中文](README.md)

Adds a **Fetch models** button to every provider card in the Harness Web GUI's Models settings page: one click asks that provider's own endpoint for its model list and merges the new ids into the configuration.

## What it fixes

1. The built-in fetch answers from the adapter's *installed catalog* first: a route named `openai` pointed at a relay returns OpenAI's official model table and ignores your API address. This plugin asks by **address**, never by name.
2. The deepseek card has no fetch path at all; this plugin gives it one.
3. The built-in entry hides inside the custom-settings fold-out and opens a picker. This one is a card-level button that writes immediately.

## Behaviour

- Requests `{baseURL}/models` with the credential this profile already stores for that provider. The key never leaves the host process; the browser receives only the model list.
- Auth header starts with the family default (pi-ai `Authorization: Bearer`, deepseek `x-api-key`) and retries once with the other on 401/403.
- 20 s timeout, 4 MB response ceiling; a non-JSON body or an empty listing is reported as a failure with its reason.
- **Merge, never replace**: existing rows are preserved exactly (`reasoningEfforts`, `contextWindow` and hand edits survive), and only ids absent from the configuration are appended, in endpoint order.
- Nothing new means **no write at all** — just "already up to date".
- A failure leaves one red line naming the address and status; it clears on retry. The configuration is untouched.
- Uninstalling the plugin leaves every written model in place.

## Field mapping

| endpoint field | pi-ai | deepseek |
| --- | --- | --- |
| `id` | `id` | `id` |
| display name | `name` | `name` |
| context window | `contextWindow` | `contextWindow` |
| output limit | `maxTokens` | `maxTokens` |
| input modalities | `input` | `inputModalities` |

`id` is the only required field on both sides; anything the endpoint does not disclose is left out.

## Accepted reply shapes

`{ data: [...] }` (OpenAI standard), `{ models: [...] }`, and `{ models: { id: {...} } }` (enriched dictionary), with aliases such as `context_window` / `context_length` / `limits.context_window`, `max_completion_tokens` / `max_output_tokens`, `architecture.input_modalities`.

## Install

Installed in the `desktop` profile. For another profile:

```powershell
dsh plugin add "E:\dsh插件\dsh-model-autofetch"
```

Reload the page (Ctrl+R); the button appears at the bottom of each provider card.

## Verification

```powershell
node test\host.test.mjs
node test\client.test.mjs
```

The host suite feeds three real reply shapes through the parser and checks both live endpoints report 401 instead of failing silently. The client suite loads the real `client.js` against a stub React and a stub Cordis context, then asserts: both card keys register, the button label, what the click reads from `describe()`, the request body it posts, and the merged array it writes (the existing row is the same object, not a rebuilt copy).

## Boundaries

- Reads, does not guess: no built-in model knowledge.
- Touches no built-in package: all code lives in this plugin, all writes are settings values.
- Keys stay host-side: `credentials.resolve(apiKeyEnv)` runs in the host process.