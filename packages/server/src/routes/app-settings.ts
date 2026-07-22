/**
 * Machine-local app settings (`~/.okf-wiki/app.json`), including home skills switch.
 * Toggle is Settings page only — no environment override.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readAppState,
  resolveLoadHomeSkills,
  setLoadHomeSkills,
  skillLayoutPaths,
} from "@okf-wiki/core";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";

export type AppSettingsPublic = {
  loadHomeSkills: boolean;
  /** Value stored in app.json when present. */
  loadHomeSkillsStored: boolean | null;
  homeSkillsDir: string;
  homeProducerSkill: string;
  /** Relative project skills root (`.agents/skills`). */
  workspaceSkillsRelative: string;
};

async function buildPublic(): Promise<AppSettingsPublic> {
  const state = await readAppState();
  const layout = skillLayoutPaths();
  return {
    loadHomeSkills: resolveLoadHomeSkills(state),
    loadHomeSkillsStored:
      typeof state.loadHomeSkills === "boolean" ? state.loadHomeSkills : null,
    homeSkillsDir: layout.homeSkillsDir,
    homeProducerSkill: layout.homeProducerSkill,
    workspaceSkillsRelative: layout.workspaceSkillsRelative,
  };
}

/** GET /api/app-settings */
export async function handleGetAppSettings(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    sendJson(res, 200, { settings: await buildPublic() });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/** PATCH /api/app-settings */
export async function handlePatchAppSettings(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as { loadHomeSkills?: unknown };
  if (body.loadHomeSkills === undefined) {
    sendError(res, 400, "provide loadHomeSkills (boolean)");
    return;
  }
  if (typeof body.loadHomeSkills !== "boolean") {
    sendError(res, 400, "loadHomeSkills must be a boolean");
    return;
  }
  try {
    await setLoadHomeSkills(body.loadHomeSkills);
    sendJson(res, 200, { settings: await buildPublic() });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}
