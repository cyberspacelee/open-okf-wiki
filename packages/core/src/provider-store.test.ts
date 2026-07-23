import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createModelProfile,
  createProviderEntry,
  defaultProviderPath,
  deleteModelProfile,
  flattenModels,
  hasProviderCredentials,
  loadProviderConfig,
  maskSecret,
  migrateProviderConfigV1,
  migrateProviderConfigV2,
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

test("migrate v1 single endpoint into provider tree", () => {
  const migrated = migrateProviderConfigV1({
    version: 1,
    baseUrl: "https://gateway.example/v1",
    apiKey: "sk-secret",
    apiShape: "responses",
    defaultModelId: "openai/corp",
  });
  assert.ok(migrated);
  assert.equal(migrated!.version, 3);
  assert.equal(migrated!.providers.length, 1);
  assert.equal(migrated!.providers[0]!.models.length, 1);
  assert.equal(migrated!.providers[0]!.models[0]!.modelId, "openai/corp");
  assert.equal(migrated!.providers[0]!.apiShape, "responses");
  assert.equal(migrated!.defaultModelProfileId, "default");
});

test("migrate v2 flat models groups same endpoint", () => {
  const migrated = migrateProviderConfigV2({
    version: 2,
    defaultModelProfileId: "a",
    models: [
      {
        id: "a",
        name: "A",
        modelId: "m1",
        baseUrl: "https://gw/v1",
        apiKey: "k",
        apiShape: "completions",
      },
      {
        id: "b",
        name: "B",
        modelId: "m2",
        baseUrl: "https://gw/v1",
        apiKey: "k",
        apiShape: "completions",
      },
      {
        id: "c",
        name: "C",
        modelId: "m3",
        baseUrl: "https://other/v1",
        apiKey: "k2",
        apiShape: "responses",
      },
    ],
  });
  assert.ok(migrated);
  assert.equal(migrated!.version, 3);
  assert.equal(migrated!.providers.length, 2);
  const gw = migrated!.providers.find((p) => p.baseUrl.includes("gw"));
  assert.ok(gw);
  assert.equal(gw!.models.length, 2);
  assert.equal(flattenModels(migrated!).length, 3);
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
  assert.equal(loaded.version, 3);
  assert.equal(loaded.providers[0]!.baseUrl, "https://old/v1");
  assert.equal(loaded.providers[0]!.apiKey, "old-key-value");
});

test("load migrates v2 file and saves as v3", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      defaultModelProfileId: "default",
      models: [
        {
          id: "default",
          name: "Default",
          modelId: "grok-4.5",
          baseUrl: "https://www.fkcodex.com/v1",
          apiKey: "sk-test",
          apiShape: "responses",
        },
      ],
    }),
    "utf8",
  );
  const loaded = await loadProviderConfig(file);
  assert.equal(loaded.version, 3);
  assert.equal(flattenModels(loaded)[0]!.modelId, "grok-4.5");
  await saveProviderConfig(loaded, file);
  const again = await loadProviderConfig(file);
  assert.equal(again.version, 3);
  assert.ok(again.providers.length >= 1);
});

test("create update delete model profiles under providers", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");

  const created = await createModelProfile(
    {
      name: "Corp GPT",
      modelId: "openai/gpt-4o",
      baseUrl: "https://gw/v1",
      apiKey: "sk-one-secret-key",
      apiShape: "completions",
      headers: { "User-Agent": "node" },
    },
    file,
  );
  assert.equal(created.config.providers.length, 1);
  assert.equal(flattenModels(created.config).length, 1);
  assert.equal(created.profile.name, "Corp GPT");
  assert.equal(created.profile.headers?.["User-Agent"], "node");
  assert.equal(created.config.defaultModelProfileId, created.profile.id);

  // Second model same endpoint → same provider
  const second = await createModelProfile(
    {
      name: "Corp Mini",
      modelId: "openai/mini",
      baseUrl: "https://gw/v1",
      apiKey: "sk-one-secret-key",
      apiShape: "completions",
    },
    file,
  );
  assert.equal(second.config.providers.length, 1);
  assert.equal(flattenModels(second.config).length, 2);

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
  assert.equal(flattenModels(loaded).length, 1);
  assert.equal(flattenModels(loaded)[0]!.id, second.profile.id);
});

test("createProviderEntry then add model by providerId", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");
  const { provider } = await createProviderEntry(
    {
      name: "FK",
      baseUrl: "https://cch.example/v1",
      apiKey: "sk-x",
      apiShape: "responses",
      headers: { "User-Agent": "node" },
    },
    file,
  );
  const { profile, config } = await createModelProfile(
    {
      name: "Grok",
      modelId: "grok-4.5",
      providerId: provider.id,
      baseUrl: "",
      apiShape: "responses",
    },
    file,
  );
  assert.equal(config.providers.length, 1);
  assert.equal(profile.providerId, provider.id);
  assert.equal(profile.baseUrl, "https://cch.example/v1");
  assert.equal(profile.apiKey, "sk-x");
});

test("resolveProviderRuntime includes headers default", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");
  await createModelProfile(
    {
      name: "M",
      modelId: "m1",
      baseUrl: "https://gw/v1",
      apiKey: "k",
      apiShape: "completions",
    },
    file,
  );
  const config = await loadProviderConfig(file);
  const runtime = resolveProviderRuntime(config, {});
  assert.equal(runtime.headers?.["User-Agent"], "node");
});

test("toProviderPublic exposes providers and flat models", async () => {
  const home = await tempHome();
  const file = path.join(home, "provider.json");
  await createModelProfile(
    {
      name: "M",
      modelId: "m1",
      baseUrl: "https://gw/v1",
      apiKey: "sk-secret-long-key",
      apiShape: "completions",
      headers: { "User-Agent": "node" },
    },
    file,
  );
  const pub = toProviderPublic(await loadProviderConfig(file));
  assert.equal(pub.version, 3);
  assert.equal(pub.providers.length, 1);
  assert.equal(pub.models.length, 1);
  assert.equal(pub.models[0]!.apiKeySet, true);
  assert.ok(pub.models[0]!.apiKeyMasked);
  assert.notEqual(pub.models[0]!.apiKeyMasked, "sk-secret-long-key");
  assert.equal(pub.providers[0]!.headers?.["User-Agent"], "node");
});

test("hasProviderCredentials and defaultProviderPath", () => {
  assert.ok(defaultProviderPath().includes("provider.json"));
  assert.equal(
    hasProviderCredentials({ version: 3, providers: [] }, {}),
    false,
  );
});
