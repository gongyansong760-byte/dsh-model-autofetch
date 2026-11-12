# dsh-model-autofetch · 模型列表一键拉取

[English](README.en.md) · 简体中文

在「设置 → 模型」的每个提供商卡片里加一个 **拉取模型** 按钮：点一下，直接向这个提供商自己的接口地址要模型列表，把新模型合并进配置。不用再手抄模型 id。

## 它解决的三件事

1. **内置「获取可用模型」会答错。** 那条路径优先返回适配器内置的模型目录：把一个叫 `openai` 的路由指向中转站，拿到的是 OpenAI 官方模型表，你填的 API 地址被忽略。本插件按**地址**去问，不问名字。
2. **deepseek 卡片根本没有拉取按钮。** `llm-deepseek` 用的是另一套编辑器，没有发现入口。本插件给它补上。
3. **老按钮在「自定义设置」折叠区里，还是个小文字链。** 本插件是一张卡片级的按钮，点完直接写入，没有二次确认弹窗。

## 行为

- 请求 `{API 地址}/models`，用这个提供商**已经存好的**密钥；密钥不出宿主进程，浏览器只收到模型列表。
- 认证头先按家族默认（pi-ai：`Authorization: Bearer`；deepseek：`x-api-key`），401/403 时自动换另一种再试一次。
- 20 秒超时、4MB 响应上限；端点返回的不是 JSON、或一个模型都没列，都按失败处理并给出原因。
- **合并追加，绝不覆盖**：已有条目逐字节保留（你手调的 `reasoningEfforts`、`contextWindow` 都不动），只补端点上有、配置里没有的 id，顺序按端点返回顺序。
- 没有新模型时**不写配置**，只提示「已是最新」。
- 失败时只留一行红字，写明哪个地址、什么状态；点重试才清掉。配置一个字节都不改。
- 卸载插件后，已经写入的模型照旧留在你的配置里。

## 写入字段

只写端点真的公布的字段，两个家族字段名不同：

| 端点字段 | pi-ai | deepseek |
| --- | --- | --- |
| `id` | `id` | `id` |
| 显示名 | `name` | `name` |
| 上下文窗口 | `contextWindow` | `contextWindow` |
| 输出上限 | `maxTokens` | `maxTokens` |
| 输入模态 | `input` | `inputModalities` |

`id` 是两边唯一必填项，其余字段端点没给就不写。

## 支持的回应形状

`{ data: [...] }`（OpenAI 标准）、`{ models: [...] }`、`{ models: { id: {...} } }`（富信息字典）。字段别名也认：`context_window` / `context_length` / `limits.context_window`、`max_completion_tokens` / `max_output_tokens`、`architecture.input_modalities` 等。

## 安装

已装进 `desktop` profile。要在别的 profile 装：

```powershell
dsh plugin add "E:\dsh插件\dsh-model-autofetch"
```

装完刷新页面（Ctrl+R）。按钮出现在每个提供商卡片底部。

## 自带验证

```powershell
node test\host.test.mjs
node test\client.test.mjs
```

`host.test.mjs` 用三种真实回应形状喂解析器，并拿两个真实端点验证「无密钥时报告 401 而不是静默失败」。`client.test.mjs` 用桩 React 与桩 Cordis 上下文加载真实的 `client.js`，验证：两个卡片键都注册、按钮文案、点击时读到的 describe、发出去的请求体、以及最后写进去的合并数组（老条目是同一个对象、不是重建的副本）。

## 文件

```
package.json            dsh.client / dsh.bundle 声明
cordis.patch.yml        bundle 补丁：插入宿主半
index.js                宿主半：POST /api/dsh-model-autofetch/discover
client.js               客户端半：卡片按钮 + 合并写入
locale/{zh,en}.json     插件清单文案
test/                   本地验证
```

## 边界

- 只读不猜：端点说什么信什么，不内置模型知识库。
- 不碰内置包：所有改动都在本插件与你的 settings 值里。
- 密钥只走宿主：`credentials.resolve(apiKeyEnv)` 在宿主进程内完成，路由只回模型列表。