import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const providers = ["openrouter", "openai", "anthropic"] as const;
export async function modelCatalog() {
  const directory = await mkdtemp(join(tmpdir(), "pi-catalog-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(directory, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    return providers.map((provider) => ({
      id: provider,
      models: runtime
        .getModels(provider)
        .map((model) => ({
          id: model.id,
          name: model.name,
          context_window: model.contextWindow,
        })),
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
