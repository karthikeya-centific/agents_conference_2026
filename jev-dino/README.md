# Jev plays Dino 🦖

Chrome's T-Rex runner, played live by **Jev** — TypeSafe AI's *System One* decision model — or by any LLM on
OpenRouter, with a collapsible panel that shows every model call and answer in real time.

![Jev playing the dino game with the live Model I/O panel open (offline mock mode)](docs/screenshot.png)

Several times a second the game turns its state into text, asks one typed question
(*"which key should be pressed right now?"*), presses the key the model picks, and asks again.
Nothing is remembered between calls. Jev answers in roughly 100–300 ms without generating a single token of text;
an LLM needs one to several seconds and usually dies on the first cactus. That contrast is the demo.

---

## Quick start (two minutes)

1. Install **Node.js 20 or newer** from https://nodejs.org. Nothing else to install: no `npm install`, no build.
2. Open `config.mjs` (next to `server.mjs`) and paste your keys:

   ```js
   export const KEYS = {
     TYPESAFE_API_KEY: 'PASTE_TYPESAFE_KEY_HERE',    // Jev — https://console.typesafe.ai
     OPENROUTER_API_KEY: 'PASTE_OPENROUTER_KEY_HERE',  // optional — https://openrouter.ai/keys
   };
   ```

3. Start the server from the folder that contains `server.mjs`, then open the page:

   ```bash
   node server.mjs        # → http://localhost:8787
   ```

4. Pick a player, set the speed, press **Start**. The **Show Model I/O** button (top right) opens the live panel
   with every call and answer.

* **No keys yet?** `node server.mjs --mock` runs the whole thing against an offline imitation of both APIs.
* **Before a demo:** press **Test call** on the Jev card. It makes one real request and shows the latency.
* Players whose key is missing are greyed out and say which line of `config.mjs` to fill. Environment variables
  with the same names work as a fallback.

The keys are only ever read by `server.mjs`; the browser talks to the local server, which adds the
`Authorization` header. This is also *required*: `api.typesafe.ai` rejects browser origins (CORS).

---

## What is Jev? (2-minute primer)

* **Made by TypeSafe AI**, announced 15 September 2026 (founder Diogo Almeida, formerly OpenAI; $40M raised).
  Sources: [TypeSafe blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
  [API reference](https://docs.typesafe.ai/api), [DataCamp](https://www.datacamp.com/blog/system-one-models-jev),
  [MindStudio](https://www.mindstudio.ai/blog/jev-system-one-model-classification),
  [OpenRouter listing](https://openrouter.ai/typesafe/jev-1.13).
* **It does not generate text.** You send a *state* (any text or JSON) plus a map of named, typed *questions*;
  it returns one typed answer per question, all in a single parallel pass, each with calibrated probabilities.
  Three question types:

  | type | you give | you get back |
  |------|----------|--------------|
  | `choice` | labels + descriptions | the chosen label, a probability for **every** label, a confidence |
  | `score` | an ordered rubric (2–10 levels) | expected score (can fall between levels), per-level probabilities, confidence |
  | `noul` | a yes/no statement | probability that it is true (0–1) |

* **Fast and cheap:** 70–500 ms end to end, $0.042 per million input tokens, output tokens free
  (about $0.0004 per decision). 0 % structured-output errors: the answer is always one of your labels.
* **Stateless and "not very intelligent" by design.** No memory, no chain of thought, roughly 32k input tokens.
  It is a semantic classifier / router / risk gate, not a planner. Put the physics in code, ask it for the judgment.
* **One endpoint:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`.
  Official SDKs: `npm i @typesafe-ai/sdk`, `pip install typesafe-sdk`. On OpenRouter the same body goes to
  `POST https://openrouter.ai/api/alpha/decisions` (model `typesafe/jev-1.13`); it is *not* a chat-completions model.

### The exact request the game sends to Jev

```json
{
  "model": "jev-latest",
  "state": {
    "frame": 812, "score": 143,
    "speed_px_per_frame": 6, "speed_px_per_s": 360,
    "dino": { "state": "running", "x_px": 50, "height_above_ground_px": 0, "standing_height_px": 47, "ducking_height_px": 25 },
    "nearest_obstacle": {
      "kind": "cactus", "size": "large", "count": 2, "width_px": 50, "height_px": 50,
      "distance_px": 210, "arrives_in_ms": 583, "arrives_in_ms_when_answer_lands": 420,
      "jump_timing": "now"
    },
    "next_obstacle": { "kind": "pterodactyl", "flying_height": "mid (at head height of a standing dino)", "width_px": 46, "height_px": 40, "distance_px": 640, "arrives_in_ms": 1777 },
    "timing": { "your_recent_latency_ms": 163, "jump_airtime_ms": 583, "jump_apex_px": 92 }
  },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "You are the reflexes of the T-Rex ... Which input should the game press right now?",
      "criteria": { "jump": "Press the jump key now.", "duck": "Hold the duck key now ...", "run": "Press nothing: keep running." }
    },
    "danger": {
      "type": "score",
      "instructions": "How dangerous is the situation for the dino right now?",
      "criteria": ["safe: nothing is close", "caution: ...", "urgent: ...", "critical: ..."]
    }
  }
}
```

### …and what comes back

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "action": { "type": "choice", "choice": "jump", "confidence": 0.93, "probabilities": { "jump": 0.93, "duck": 0.01, "run": 0.06 } },
    "danger": { "type": "score", "score": 2.1, "confidence": 0.8, "legend": { "0": "safe: ...", "1": "...", "2": "...", "3": "..." }, "probabilities": { "0": 0.01, "1": 0.09, "2": 0.7, "3": 0.2 } }
  },
  "usage": { "input_tokens": 410, "output_tokens": 0 }
}
```

The game presses `jump`. The `danger` score drives the meter under the canvas. Both answers came from the same
single call — adding questions adds almost no latency.

For the LLM player the *same* state and rules are sent as a system + user prompt to
`POST /api/v1/chat/completions` with a strict JSON schema (`{"action","danger","reason"}`), and the reply is parsed.

---

## How the loop works

```
 every frame (60 fps)                 as fast as answers arrive (sequential, one call in flight)
 ┌──────────────┐  snapshot()  ┌────────────────────────────────────────────────────────────┐
 │  game engine │ ───────────► │  agent: physics facts → state text → POST /api/decide     │
 │  (canvas)    │ ◄─────────── │  ← parse typed answer → jump() / setDuck() / nothing        │
 └──────────────┘  press key   └───────────────┬────────────────────────────────────────────┘
                                                │ local server adds the key, forwards, times it
                                                ▼
                     TypeSafe /v1/systemone · OpenRouter /api/alpha/decisions · OpenRouter /api/v1/chat/completions
```

* **Physics stays in code.** Distances and arrival times are measured; whether a jump started *when the answer
  lands* would get through is found by simulating the real jump curve against Chromium's collision boxes, frame by
  frame, using the model's measured latency (an exponential moving average). With **timing assist** on, that
  becomes one word for the model: `jump_timing: now | too_early | too_late | not_needed`. The model still has to
  decide *what* to do with it (jump a cactus, duck a mid pterodactyl, ignore a high one). Turn it off (Advanced)
  and the model only gets the numbers plus the jump window, a much harder task for a stateless classifier — a good
  thing to show.
* **Stateless.** The full state and the rules travel with every call. Jev has no context window to fill up and
  no memory of the previous frame, which is why the state includes everything it needs.
* **Latency is part of the game.** Because every call is stateless, Jev is called on a fixed interval (100 ms by
  default) without waiting for the previous answer: with 300 ms latency, three requests are in flight and a
  decision lands every 100 ms. Each answer still describes the world as it was when its request left; the panel
  shows how old that state was when the answer landed. LLMs run one call at a time by default (Advanced → Call
  cadence changes both).

---

## Players

| player | what happens | typical latency |
|--------|--------------|-----------------|
| **Jev — TypeSafe API** | `POST api.typesafe.ai/v1/systemone`, model `jev-latest` | ~100–300 ms |
| **Jev — via OpenRouter** | same body to `openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13` | ~150–400 ms |
| **Any LLM — via OpenRouter** | chat completion with a JSON schema; pick any model id (live list is loaded) | 0.7–10 s |
| **Scripted bot** | a fixed if/else on the same state with a latency slider — shows what latency alone does | you choose |
| **You** | keyboard (Space/↑ jump, ↓ duck) — set the human reference score | — |

## Settings

* **Speed** 3–13 px/frame (Chrome starts at 6, caps at 13) and **accelerate over time**.
* **Advanced:** state as JSON or plain sentences · timing assist on/off · second question (danger score) on/off ·
  call cadence (parallel every N ms, or one at a time) · show hitboxes.
* The **Model I/O** panel (button top right) lists every call with the exact request body, the raw response,
  upstream latency, tokens, running cost, and the probability bars behind each decision. "Hide run answers"
  keeps only the interesting ones on screen; "expand latest" keeps the newest call open for the projector.

## A demo script that works

1. **You play** one round — the human reference.
2. **Scripted bot** at 150 ms, then at 1500 ms latency. Same logic, only latency changes; the second one dies.
3. **Jev** at speed 6 with the panel open. Point at: calls per second, the probabilities on every answer,
   the danger score coming from the *same* call, zero parsing errors, the running cost.
4. **An LLM** (e.g. `openai/gpt-4o-mini`, then something bigger). Point at: latency, "state was N ms old when
   the answer landed", the `reason` text it insists on writing, cost per call.
5. Back to **Jev**, Advanced → timing assist **off**, or state format **plain text**, and discuss what belongs in
   code versus in the model.

---

## Files

```
./
├─ server.mjs            static files + /api/decide, /api/models, /api/ping, /api/config (keys never leave here)
├─ config.mjs            ← PASTE KEYS HERE; model names, port, pricing
├─ dev/mock-upstream.mjs offline imitation of both APIs (node server.mjs --mock)
├─ docs/screenshot.png
└─ public/
   ├─ index.html, styles.css
   ├─ js/game.js         the runner: Chromium's physics, sprites, collision boxes; snapshot(); jumpProfile()
   ├─ js/agent.js        state builder, Jev/OpenRouter payloads, parsers, the decision loop
   ├─ js/panel.js        live Model I/O panel
   ├─ js/ui.js           start screen, HUD, keyboard, overlay
   └─ assets/            Chrome's sprite sheet (© The Chromium Authors, BSD-3-Clause)
```

## Notes

* OpenRouter's Decisions endpoint is under `/api/alpha/` and may move; the path is in `server.mjs`. If the model id
  `typesafe/jev-1.13` returns 404, use the id shown on https://openrouter.ai/typesafe (editable on the card).
* Models that reject `response_format` or `temperature` are retried automatically with a simpler request.
* Cost: Jev at ~450 input tokens per call and 10 calls/s is about $0.70 per hour of play.
* Keys in `config.mjs` are hardcoded on purpose for this demo. Keep the repository private, and don't push real
  keys to a repository you don't control.
