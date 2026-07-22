import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createModelProfile,
  defaultProviderPath,
  deleteModelProfile,
  hasProviderCredentials,
  loadProviderConfig,
  maskSecret,
  migrateProviderConfigV1,
  resolveProviderRuntime,
  saveProviderConfig,
  setDefaultModelProfile,
  toProviderPublic,
  updateModelProfile,
} from "./provider-store.js";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "okf-provider-"));
}

test("maskSecret never returns full key", () => {
  assert.equal(maskSecret(""), null);
  assert.equal(maskSecret("short"), "••••••••");
  const masked = maskSecret("sk-proj-abcdefghijklmnop");
  assert.ok(masked);
  assert.notEqual(masked, "sk-proj-abcdefghijklmnop");
  assert.match(masked!, /…/);
});

test("migrate v1 single endpoint into one model profile", () => {
  const migrated = migrateProviderConfigV1({
    version: 1,
    baseUrl: "https://gateway.example/v1",
    apiKey: "sk-secret",
    apiShape: "responses",
    defaultModelId: "openai/corp",
  });
  assert.ok(migrated);
  assert.equal(migrated!.version, 2);
  assert.equal(migrated!.models.length, 1);
  assert.equal(migrated!.models[0]!.modelId, "openai/corp");
  assert.equal(migrated!.models[0]!.apiShape, "responses");
  assert.equal(migrated!.defaultModelProfileId, "default");
});

test("load migrates v1 file on disk", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      baseUrl: "https://old/v1",
      apiKey: "old-key-value",
      apiShape: "completions",
      defaultModelId: "openai/legacy",
    }),
    "utf8",
  );
  const loaded = await loadProviderConfig(file);
  assert.equal(loaded.version, 2);
  assert.equal(loaded.models[0]!.baseUrl, "https://old/v1");
  assert.equal(loaded.models[0]!.apiKey, "old-key-value");
});

test("create update delete model profiles", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");

  const created = await createModelProfile(
    {
      name: "Corp GPT",
      modelId: "openai/gpt-4o",
      baseUrl: "https://gw/v1",
      apiKey: "sk-one-secret-key",
      apiShape: "completions",
    },
    file,
  );
  assert.equal(created.config.models.length, 1);
  assert.equal(created.profile.name, "Corp GPT");
  assert.equal(created.config.defaultModelProfileId, created.profile.id);

  const second = await createModelProfile(
    {
      name: "Local",
      modelId: "openai/local",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiShape: "responses",
    },
    file,
  );
  assert.equal(second.config.models.length, 2);

  const updated = await updateModelProfile(
    created.profile.id,
    {
      name: "Corp GPT 4",
      modelId: "openai/gpt-4o",
      baseUrl: "https://gw/v1",
      apiShape: "completions",
      // omit apiKey → keep
    },
    file,
  );
  assert.equal(updated.profile.name, "Corp GPT 4");
  assert.equal(updated.profile.apiKey, "sk-one-secret-key");

  await setDefaultModelProfile(second.profile.id, file);
  let loaded = await loadProviderConfig(file);
  assert.equal(loaded.defaultModelProfileId, second.profile.id);

  loaded = await deleteModelProfile(created.profile.id, file);
  assert.equal(loaded.models.length, 1);
  assert.equal(loaded.models[0]!.id, second.profile.id);
});

test("toProviderPublic never includes raw apiKey", async () => {
  const publicView = toProviderPublic(
    {
      version: 2,
      models: [
        {
          id: "a",
          name: "A",
          modelId: "openai/a",
          baseUrl: "https://gw/v1",
          apiKey: "sk-proj-secretsecret",
          apiShape: "completions",
        },
      ],
      defaultModelProfileId: "a",
    },
    {},
  );
  assert.equal(publicView.models[0]!.apiKeySet, true);
  assert.doesNotMatch(JSON.stringify(publicView), /sk-proj-secretsecret/);
});

test("resolveProviderRuntime prefers profileId", () => {
  const config = {
    version: 2 as const,
    defaultModelProfileId: "a",
    models: [
      {
        id: "a",
        name: "A",
        modelId: "openai/a",
        baseUrl: "https://a/v1",
        apiKey: "key-a-value",
        apiShape: "completions" as const,
      },
      {
        id: "b",
        name: "B",
        modelId: "openai/b",
        baseUrl: "https://b/v1",
        apiKey: "key-b-value",
        apiShape: "responses" as const,
      },
    ],
  };
  const runtime = resolveProviderRuntime(config, { profileId: "b" });
  assert.equal(runtime.baseUrl, "https://b/v1");
  assert.equal(runtime.apiKey, "key-b-value");
  assert.equal(runtime.apiShape, "responses");
  assert.equal(runtime.modelId, "openai/b");
  assert.equal(runtime.maxContextTokens, undefined);
});

test("resolveProviderRuntime surfaces maxContextTokens from profile", () => {
  const runtime = resolveProviderRuntime(
    {
      version: 2,
      models: [
        {
          id: "ctx",
          name: "Ctx",
          modelId: "openai/ctx",
          baseUrl: "https://ctx/v1",
          apiKey: "key-ctx",
          apiShape: "completions",
          maxContextTokens: 128_000,
        },
      ],
    },
    { profileId: "ctx" },
  );
  assert.equal(runtime.maxContextTokens, 128_000);
});

test("create/update model profile persists and clears maxContextTokens", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");

  const created = await createModelProfile(
    {
      name: "With Context",
      modelId: "openai/ctx-model",
      baseUrl: "https://gw/v1",
      apiKey: "sk-ctx-key",
      apiShape: "completions",
      maxContextTokens: 64_000,
    },
    file,
  );
  assert.equal(created.profile.maxContextTokens, 64_000);
  const publicView = toProviderPublic(created.config);
  assert.equal(publicView.models[0]!.maxContextTokens, 64_000);

  const updated = await updateModelProfile(
    created.profile.id,
    {
      name: "With Context",
      modelId: "openai/ctx-model",
      baseUrl: "https://gw/v1",
      apiShape: "completions",
      maxContextTokens: 128_000,
    },
    file,
  );
  assert.equal(updated.profile.maxContextTokens, 128_000);

  const cleared = await updateModelProfile(
    created.profile.id,
    {
      name: "With Context",
      modelId: "openai/ctx-model",
      baseUrl: "https://gw/v1",
      apiShape: "completions",
      maxContextTokens: null,
    },
    file,
  );
  assert.equal(cleared.profile.maxContextTokens, undefined);
  const reloaded = await loadProviderConfig(file);
  assert.equal(reloaded.models[0]!.maxContextTokens, undefined);
});

test("resolveProviderRuntime falls back to env when profile empty", () => {
  const runtime = resolveProviderRuntime(
    { version: 2, models: [] },
    {
      env: {
        OPENAI_BASE_URL: "https://env/v1/",
        OPENAI_API_KEY: "env-key",
      },
    },
  );
  assert.equal(runtime.baseUrl, "https://env/v1");
  assert.equal(runtime.apiKey, "env-key");
  assert.equal(runtime.source.baseUrl, "env");
});

test("hasProviderCredentials detects models or env", () => {
  assert.equal(
    hasProviderCredentials({ version: 2, models: [] }, {}),
    false,
  );
  assert.equal(
    hasProviderCredentials(
      {
        version: 2,
        models: [
          {
            id: "x",
            name: "X",
            modelId: "openai/x",
            baseUrl: "https://x/v1",
            apiKey: "",
            apiShape: "completions",
          },
        ],
      },
      {},
    ),
    true,
  );
  assert.equal(
    hasProviderCredentials({ version: 2, models: [] }, { OPENAI_API_KEY: "k" }),
    true,
  );
});

test("defaultProviderPath honors OKF_WIKI_HOME", () => {
  const prev = process.env.OKF_WIKI_HOME;
  process.env.OKF_WIKI_HOME = "/tmp/okf-home-test";
  try {
    assert.equal(defaultProviderPath(), path.join("/tmp/okf-home-test", "provider.json"));
  } finally {
    if (prev === undefined) {
      delete process.env.OKF_WIKI_HOME;
    } else {
      process.env.OKF_WIKI_HOME = prev;
    }
  }
});

test("saveProviderConfig round-trip multi model", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");
  await saveProviderConfig(
    {
      version: 2,
      defaultModelProfileId: "one",
      models: [
        {
          id: "one",
          name: "One",
          modelId: "openai/one",
          baseUrl: "https://one/v1",
          apiKey: "secret-one",
          apiShape: "completions",
        },
      ],
    },
    file,
  );
  const loaded = await loadProviderConfig(file);
  assert.equal(loaded.models[0]!.apiKey, "secret-one");
  assert.equal(loaded.defaultModelProfileId, "one");
});
