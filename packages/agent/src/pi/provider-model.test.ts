import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  okfProviderId,
  piApiFromShape,
  resolvePiModelFromProvider,
  resolveWorkspacePiModel,
  servedModelIdFromProfile,
} from "./provider-model.js";

describe("provider-model bridge", () => {
  it("maps apiShape to pi Api strings", () => {
    assert.equal(piApiFromShape("completions"), "openai-completions");
    assert.equal(piApiFromShape("responses"), "openai-responses");
  });

  it("strips provider/ prefix for served model id", () => {
    assert.equal(servedModelIdFromProfile("openai/gpt-4o"), "gpt-4o");
    assert.equal(servedModelIdFromProfile("qwen2.5-72b"), "qwen2.5-72b");
    assert.equal(servedModelIdFromProfile("  openai/a/b  "), "a/b");
  });

  it("builds stable okf provider ids", () => {
    assert.equal(okfProviderId("corp-gpt"), "okf-corp-gpt");
    assert.equal(okfProviderId(undefined), "okf-default");
    assert.equal(okfProviderId("Weird Name!!"), "okf-weird-name");
  });

  it("registers an openai-compatible model on an isolated runtime", async () => {
    const resolved = await resolvePiModelFromProvider({
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test-key",
      apiShape: "completions",
      modelId: "openai/corp-model",
      profileId: "corp",
      profileName: "Corp",
      maxContextTokens: 64_000,
    });

    assert.equal(resolved.providerKind, "openai-compatible");
    assert.equal(resolved.providerId, "okf-corp");
    assert.equal(resolved.servedModelId, "corp-model");
    assert.equal(resolved.model.id, "corp-model");
    assert.equal(resolved.model.provider, "okf-corp");
    assert.equal(resolved.model.api, "openai-completions");
    assert.equal(resolved.model.baseUrl, "https://gateway.example/v1");
    assert.equal(resolved.model.contextWindow, 64_000);

    const viaRuntime = resolved.modelRuntime.getModel("okf-corp", "corp-model");
    assert.ok(viaRuntime);
    assert.equal(viaRuntime!.id, "corp-model");
  });

  it("uses responses api when apiShape is responses", async () => {
    const resolved = await resolvePiModelFromProvider({
      baseUrl: "https://gw/v1",
      apiKey: "k",
      apiShape: "responses",
      modelId: "gpt-5-mini",
      profileId: "r1",
    });
    assert.equal(resolved.model.api, "openai-responses");
  });

  it("rejects missing credentials", async () => {
    await assert.rejects(
      () =>
        resolvePiModelFromProvider({
          baseUrl: "",
          apiKey: "local",
          apiShape: "completions",
          modelId: "openai/x",
        }),
      /No provider credentials/,
    );
  });

  it("rejects missing model id", async () => {
    await assert.rejects(
      () =>
        resolvePiModelFromProvider({
          baseUrl: "https://gw/v1",
          apiKey: "k",
          apiShape: "completions",
          modelId: "  ",
        }),
      /No model selected/,
    );
  });

  it("resolveWorkspacePiModel loads catalog and selects profile", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "okf-pi-provider-"));
    const file = path.join(home, "provider.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        defaultModelProfileId: "p1",
        providers: [
          {
            id: "prov-a",
            name: "A",
            kind: "openai-compatible",
            baseUrl: "https://a.example/v1",
            apiKey: "sk-aaa",
            apiShape: "completions",
            headers: { "User-Agent": "node" },
            models: [
              {
                id: "p1",
                name: "Primary",
                modelId: "openai/served-a",
              },
            ],
          },
          {
            id: "prov-b",
            name: "B",
            kind: "openai-compatible",
            baseUrl: "https://b.example/v1",
            apiKey: "sk-bbb",
            apiShape: "responses",
            models: [
              {
                id: "p2",
                name: "Secondary",
                modelId: "openai/served-b",
                maxContextTokens: 32_000,
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const selected = await resolveWorkspacePiModel({
      profileId: "p2",
      providerPath: file,
      env: {},
    });
    assert.equal(selected.servedModelId, "served-b");
    assert.equal(selected.model.api, "openai-responses");
    assert.equal(selected.model.baseUrl, "https://b.example/v1");
    assert.equal(selected.model.contextWindow, 32_000);
    // Third-party gateways reject role "developer"; product forces system.
    const compat = selected.model.compat as
      | { supportsDeveloperRole?: boolean }
      | undefined;
    assert.equal(compat?.supportsDeveloperRole, false);

    const defaulted = await resolveWorkspacePiModel({
      providerPath: file,
      env: {},
    });
    assert.equal(defaulted.servedModelId, "served-a");
    assert.equal(defaulted.providerId, "okf-p1");
    assert.equal(defaulted.model.headers?.["User-Agent"], "node");
  });
});
