# The pet assistant

The desktop pet doubles as a quota assistant. It opens from the pet panel in
the island or the dashboard, answers questions about quota, resets, cost and
its own needs, and can run the same interactions as its buttons.

There are two layers:

1. **Built-in answers** run entirely in the app. They always work, need no
   download, no account and no network, and are the fallback whenever anything
   else fails.
2. **An optional local model** (Ollama, LM Studio or llama.cpp) can rephrase
   and extend those answers for free-form questions. It is off until the user
   connects it, and it is never required.

## Using the assistant without a model

Open **Dashboard -> Plugins -> Desktop pet** and scroll to **Pet assistant**.
The same panel is in the island. Type a question or tap a suggestion chip.
Answers are computed from the current snapshot, the pet's state and the
settings on this device.

| Ask about | English examples | Chinese examples | What it answers |
|---|---|---|---|
| Quota | “How is my quota?” “Claude usage” | “额度怎么样？” “Claude 还剩多少？” | Used percentage for every active window, with reset times |
| Resets | “When does it reset?” “Next reset” | “什么时候重置？” | The soonest reset across providers, and the current provider's windows |
| Busiest window | “What is the busiest?” | “哪个最忙？” | The window with the highest used percentage |
| Forecast | “Will I run out?” | “会用完吗？” | Only windows the app forecasts to run out before their reset |
| Credits | “Do I have credits?” | “还有余额吗？” | Credit balance or unlimited status, when the provider reports it |
| Budget | “How is my budget?” | “预算怎么样？” | The monthly estimate against `monthlyBudgetUsd` |
| Pet | “How are you?” “Are you hungry?” | “你怎么样？” “饿了吗？” | Level, needs, mood and one fitting suggestion |
| Summary | “Summarise” | “总结一下” | Quota, pet state, pause and focus mode in one reply |
| Advice | “What should I do?” | “有什么建议？” | A critical window first, then a forecast, pause state or the pet |
| Actions | “Feed yourself”, “let's play”, “good night” | “吃点东西吧” “玩一下” “休息一下” | Feeds, plays with or rests the pet, with the same cooldowns as the buttons |
| Help | “What can you do?” | “你能做什么？” | The available commands and whether a model is connected |

Provider names and extra-account labels narrow an answer: “Codex weekly
reset”, “Claude@work quota” and “额度重置” all work. A bare provider name after
a question keeps the previous question (“and Codex?”). Every answer carries up
to three follow-up chips, so the conversation can continue without typing.

Built-in answers are deterministic: the same data produces the same answer,
and the assistant never invents a percentage or a reset time. If a provider has
no data, the reply says so instead of showing zero. If the snapshot is stale,
the reply says how old it is.

Chat history lives in the component only. Closing the panel or restarting the
app clears it; nothing is written to the database or sent anywhere.

## Connecting a local model

The model is optional. Without one, the panel still answers everything in the
table above.

1. Install and start a local OpenAI-compatible server:
   - [Ollama](https://ollama.com) — `ollama serve`
   - [LM Studio](https://lmstudio.ai) — start its local server
   - [llama.cpp](https://github.com/ggml-org/llama.cpp) — `llama-server`
2. Pull or load a model. With Ollama:

   ```sh
   ollama pull qwen3:1.7b
   ```

3. In **Pet assistant -> Model settings**, choose **Check local servers**.
   Islita probes the usual loopback ports:
   `127.0.0.1:11434` (Ollama), `127.0.0.1:1234` (LM Studio) and
   `127.0.0.1:8080` (llama.cpp).
4. Pick a server, pick a model, and turn on **Use this model for chat**.

The assistant then shows answers labelled **Local · model**. If the model is
slow, rejects the request or returns nothing, the panel immediately shows the
built-in answer instead and names the problem. Turning the switch off restores
the built-in replies; the selection is remembered in this device's plugin
storage (`island.plugin.pet.ai`), not in `settings.json`.

A non-default port can be entered under **Other loopback endpoint**, for
example `http://127.0.0.1:8081/v1`. The address must point at `localhost`,
`127.0.0.1` or `[::1]`; a remote host is rejected. Credentials, query strings
and fragments are not accepted.

Local models are available in the desktop app only. The browser preview shows
the assistant with built-in answers and says that a model needs the desktop
app.

## Which model to use

The assistant sends a small JSON context (quota windows and pet needs) and
asks for at most 120 words. It does not need a large model.

| Model (Q4_K_M) | Approx. VRAM | Verdict |
|---|---|---|
| Qwen3 0.6B | 0.7–1.0 GB | The practical floor at a 2K context; short and sometimes clumsy |
| Qwen3 1.7B | 1.5–1.9 GB | Recommended: a good balance of size, speed and phrasing |
| Qwen3 4B | 3.5–4 GB | Better prose; more than most people need for this task |
| 0.3B-class | below 0.5 GB | Not recommended: too weak to be useful |

A 24 GB GPU can run any of these easily. On a smaller GPU, 1.7B is the best
default; 0.6B is usable if memory is tight. CPU-only machines can still run
0.6B or 1.7B, but the first reply may take several seconds.

Qwen3 thinks before answering. Islita adds `/no_think` to the request for
Qwen3 models and allows extra completion tokens for the remaining reasoning,
so a short answer is still produced. If a thinking model returns an empty
message, the built-in answer is shown instead.

## What is sent, and what is not

The request contains:

- the user's question (trimmed to 500 characters);
- a JSON context (at most 12,000 characters) with active provider names,
  window labels, used percentages, reset/forecast times, credits, pet needs,
  pause/focus state and thresholds;
- the app's own deterministic answer as a reference, when one exists, so the
  model rephrases correct facts instead of recalculating them.

It does **not** contain account e-mails, session-log text, prompt or response
text from Claude Code/Codex, sprite data, file paths, credentials, API keys or
settings unrelated to the answer. Extra-account labels (for example
“Claude · Work”) are included so the model can tell two accounts apart; they
are chosen by the user and are never e-mail addresses from the credentials.

The backend is deliberately narrow:

- literal loopback hosts only — no DNS names that merely resolve to loopback;
- `http` or `https`, no credentials, query or fragment;
- no redirects and no retries;
- no `Authorization` header and no API key;
- 1.5 s probe timeout, 90 s chat timeout, capped request and response sizes;
- response bodies are never logged, and errors are stable codes such as
  `LOCAL_AI_UNREACHABLE`, `LOCAL_AI_REJECTED`, `LOCAL_AI_EMPTY`.

The system prompt tells the model that the context is untrusted data and that
it must not follow instructions found inside it. The reference answer and
context are generated by the app; the question is the only user-controlled
part of the request.

## Built-in-only commands

Actions, greetings, thanks and help bypass the model even when one is
connected. This keeps “feed yourself” instantaneous and deterministic, and
prevents a model from inventing an action that the pet does not have. Follow-up
suggestions after a built-in answer run the same path.

## Troubleshooting

| Symptom | Meaning and fix |
|---|---|
| `No server found` | Start Ollama/LM Studio/llama.cpp, then press **Check local servers** |
| `Running, but no model is installed` | Pull or load a model (`ollama pull qwen3:1.7b`) and check again |
| `Not an OpenAI-compatible endpoint` | The base URL is not an OpenAI API; use the server's `/v1` address |
| `Server refused the request` | The server answered with an error; check its console for the model name |
| `Local models need the desktop app` | The browser preview has no Tauri backend; open the installed app |
| Empty or irrelevant local answer | The built-in answer is shown as a fallback; try a smaller model or a clearer question |
| The model is slow | The first request loads the model into memory; later turns are faster |

The built-in answers are also the answer to “the model is not installed and I
do not want one”. That is the default state, not a degraded one.

## For developers

| Piece | Location |
|---|---|
| Intent parsing, answer text, context builder | `src/lib/pet/assistant.ts` |
| Persisted model choice and loopback validation | `src/lib/pet/local-ai.ts` |
| Chat UI, suggestions and fallback | `src/lib/plugins/panels/PetPanel.svelte` |
| Tauri commands `local_ai_status`, `local_ai_probe`, `pet_ai_chat` | `src-tauri/src/local_ai.rs` |
| Unit tests | `tests/pet-assistant.unit.ts` |
| Browser E2E | `tests/pet-assistant.e2e.ts` |

`answerPetQuestion()` is pure and takes a context with an optional `now`, which
makes every intent testable without a DOM or a network. `buildAssistantContext()`
is the only place that decides what a model may see; add fields there
deliberately, never by serialising a whole snapshot.

The live test is opt-in because it needs a real server:

```sh
cd src-tauri
cargo test live_ollama -- --ignored --nocapture
```
