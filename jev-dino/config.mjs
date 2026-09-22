// ============================================================================
//  Jev plays Dino — configuration
//
//  API keys are hardcoded here on purpose (demo setup). They are read only by
//  server.mjs and are never sent to the browser: the page talks to this local
//  server, which adds the Authorization header when it forwards each call.
//
//  If a value below is left as a PASTE_... placeholder, the server falls back
//  to the environment variable with the same name (TYPESAFE_API_KEY,
//  OPENROUTER_API_KEY). If neither is set, that provider is shown as
//  "key missing" on the start screen and cannot be selected.
// ============================================================================

export const KEYS = {
  // TypeSafe AI key (Jev). Create one at https://console.typesafe.ai
  TYPESAFE_API_KEY: 'apikey_28100c957e04a934e35818456bf00d33fd1_29938d280de36249237572a1461a8af465ece92e14291ecc1f43763d74a8fdb0',

  // OpenRouter key. Create one at https://openrouter.ai/keys
  // Needed for the "any LLM" comparison and for calling Jev through OpenRouter.
  OPENROUTER_API_KEY: 'PASTE_OPENROUTER_KEY_HERE',
};

export const SETTINGS = {
  // Local port for the demo server (open http://localhost:8787).
  port: 8787,

  // Upstream APIs. Leave as-is unless you are pointing the game at a proxy.
  typesafeBaseUrl: 'https://api.typesafe.ai',
  openrouterBaseUrl: 'https://openrouter.ai',

  // Model names.
  jevModel: 'jev-latest',                    // TypeSafe direct  -> POST /v1/systemone
  openrouterJevModel: 'typesafe/jev-1.13',   // via OpenRouter   -> POST /api/alpha/decisions
  openrouterChatModel: 'openai/gpt-4o-mini', // any LLM          -> POST /api/v1/chat/completions

  // Shown in the LLM picker before (or instead of) the live OpenRouter model list.
  suggestedChatModels: [
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    'openai/gpt-4.1',
    'google/gemini-2.5-flash-lite',
    'google/gemini-2.5-flash',
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-4.5',
    'meta-llama/llama-3.3-70b-instruct',
    'qwen/qwen3-32b',
    'deepseek/deepseek-chat-v3.1',
  ],

  // Published Jev pricing, used for the running cost estimate in the panel
  // ($0.042 per million input tokens, output free).
  jevUsdPerMillionInputTokens: 0.042,

  // Laya — open-weights System One model (Convai Innovations, Apache 2.0), runs locally, no key.
  // Two ways, tried in this order:
  //   1. in-process, via the Node/ONNX runtime:   npm install @receptron/laya   (in this folder;
  //      ~1.7 GB of weights download from Hugging Face on first load, cached in ~/.cache/receptron-laya)
  //   2. an HTTP server on this machine speaking Jev's wire format, e.g.
  //      pip install laya && python dev/laya_server.py        (default http://127.0.0.1:8000)
  laya: {
    inProcess: true,                    // use @receptron/laya when it is installed
    autoload: false,                    // load the in-process model at server start (else on first use / "Load model")
    onnxSubfolder: null,                // checkpoint variant inside receptron/laya-onnx, e.g. 'multilingual'
    threads: null,                      // onnxruntime intraOpNumThreads (null = runtime default)
    baseUrl: 'http://127.0.0.1:8000',   // fallback: local Laya HTTP server
    model: 'laya',                      // model name sent to an HTTP server
  },
};
