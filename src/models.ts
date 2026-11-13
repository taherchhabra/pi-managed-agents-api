import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

// Service additions to the pinned Pi catalog. Keep the console, worker, and
// live harness on the same definitions without requiring a Pi SDK upgrade.
export function registerServiceModels(runtime: ModelRuntime): void {
  const id = 'deepseek/deepseek-v4.1-flash-1017';
  runtime.registerProvider('openrouter', {
    // registerProvider replaces the provider's catalog, so retain every other
    // built-in model (including image and classifier models).
    models: [
      ...runtime.getAllModels('openrouter').filter(model => model.id !== id),
      {
        id,
        name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        reasoning: true,
        input: ['text', 'image'],
        // OpenRouter /api/v1/models, verified 2026-11-14. Costs are USD / 1M
        // tokens and are estimates; routing and provider prices can change.
        // https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017
        cost: { input: 0.038, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 943_718,
        compat: {
          supportsDeveloperRole: false,
          thinkingFormat: 'openrouter',
          supportsStrictMode: true,
          sendSessionAffinityHeaders: true,
        },
      },
    ],
  });
}
