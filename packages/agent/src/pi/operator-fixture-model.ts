/** Pi-native deterministic model used by offline Operator Session smoke tests. */

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type OperatorFixtureModel = {
  model: Model<any>;
  modelRuntime: ModelRuntime;
  /** Queue a real model-selected wiki_produce call followed by the final reply. */
  queueWikiProduceTurn(notes: string): void;
  /** Queue a normal assistant reply when a Workspace has no runnable Snapshot Set. */
  queueAssistantTurn(text?: string): void;
};

/**
 * Build an isolated Pi faux provider; it uses the same AgentSession loop as a
 * live provider and never writes SessionManager entries itself.
 */
export async function createOperatorFixtureModel(): Promise<OperatorFixtureModel> {
  const faux = fauxProvider({ provider: "okf-fixture" });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("okf-fixture", "fixture", {
    allowNetwork: false,
  });

  return {
    model: faux.getModel(),
    modelRuntime,
    queueWikiProduceTurn(notes) {
      faux.appendResponses([
        fauxAssistantMessage([fauxToolCall("wiki_produce", { notes })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Wiki published."),
      ]);
    },
    queueAssistantTurn(text = "Fixture mode: prompt completed through Pi AgentSession.") {
      faux.appendResponses([fauxAssistantMessage(text)]);
    },
  };
}
