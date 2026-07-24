/**
 * HTTP route dispatch (thin adapter over route handlers).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyCors,
  BodyTooLargeError,
  InvalidJsonError,
  matchRoute,
  sendError,
} from "./http-util.ts";
import {
  handleAgentSessionCommand,
  handleAgentSessionEvents,
  handleCreateAgentSession,
  handleDeleteAgentSession,
  handleListAgentSessions,
} from "./routes/agent-sessions.ts";
import { handleGetAppSettings, handlePatchAppSettings } from "./routes/app-settings.ts";
import { handleDoctor, handleHealth } from "./routes/health.ts";
import {
  handleCreateModel,
  handleCreateProvider,
  handleDeleteModel,
  handleDeleteProvider,
  handleGetProvider,
  handleGitProbe,
  handleSetDefaultModel,
  handleTestProvider,
  handleUpdateModel,
  handleUpdateProvider,
} from "./routes/provider.ts";
import { handleListRuns } from "./routes/runs.ts";
import { handleListWiki, handleReadWiki, matchWikiApiRoute } from "./routes/wiki.ts";
import {
  handleAddSource,
  handleCloneSource,
  handleCreateSkillFork,
  handleCreateWorkspace,
  handleDeleteSource,
  handleDeleteWorkspace,
  handleGetSkill,
  handleGetWorkspace,
  handleListSkillFiles,
  handleListWorkspaces,
  handlePatchWorkspace,
  handleProbeSources,
  handleReadSkillFile,
  handleResetSkill,
  handleUpdateSource,
  handleWriteSkillFile,
} from "./routes/workspaces.ts";
import { host, port } from "./server-config.ts";

export async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && pathname === "/api/health") {
      await handleHealth(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/doctor") {
      await handleDoctor(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/app-settings") {
      await handleGetAppSettings(req, res);
      return;
    }
    if (method === "PATCH" && pathname === "/api/app-settings") {
      await handlePatchAppSettings(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/provider") {
      await handleGetProvider(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/provider/test") {
      await handleTestProvider(req, res);
      return;
    }
    if (method === "PUT" && pathname === "/api/provider/default") {
      await handleSetDefaultModel(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/provider/providers") {
      await handleCreateProvider(req, res);
      return;
    }
    {
      const params = matchRoute(pathname, "/api/provider/providers/:id");
      if (params) {
        if (method === "PUT") {
          await handleUpdateProvider(req, res, params.id!);
          return;
        }
        if (method === "DELETE") {
          await handleDeleteProvider(req, res, params.id!);
          return;
        }
      }
    }
    if (method === "POST" && pathname === "/api/provider/models") {
      await handleCreateModel(req, res);
      return;
    }
    {
      const params = matchRoute(pathname, "/api/provider/models/:id");
      if (params) {
        if (method === "PUT") {
          await handleUpdateModel(req, res, params.id!);
          return;
        }
        if (method === "DELETE") {
          await handleDeleteModel(req, res, params.id!);
          return;
        }
      }
    }
    if (method === "POST" && pathname === "/api/git/probe") {
      await handleGitProbe(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/workspaces") {
      await handleListWorkspaces(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/workspaces") {
      await handleCreateWorkspace(req, res);
      return;
    }

    // More specific source/run routes before generic :id
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/probe");
      if (params && method === "POST") {
        await handleProbeSources(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/clone");
      if (params && method === "POST") {
        await handleCloneSource(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/:sourceId");
      if (params && method === "DELETE") {
        await handleDeleteSource(req, res, params.id!, params.sourceId!, url);
        return;
      }
      if (params && method === "PATCH") {
        await handleUpdateSource(req, res, params.id!, params.sourceId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources");
      if (params && method === "POST") {
        await handleAddSource(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/fork");
      if (params && method === "POST") {
        await handleCreateSkillFork(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/reset");
      if (params && method === "POST") {
        await handleResetSkill(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/files");
      if (params && method === "GET") {
        await handleListSkillFiles(req, res, params.id!, url);
        return;
      }
      if (params && method === "PUT") {
        await handleWriteSkillFile(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/file");
      if (params && method === "GET") {
        await handleReadSkillFile(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill");
      if (params && method === "GET") {
        await handleGetSkill(req, res, params.id!, url);
        return;
      }
    }
    // Pi agent sessions (ADR 0032) — sole conversational entry.
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/agent/sessions/:sessionId/command");
      if (params && method === "POST") {
        await handleAgentSessionCommand(req, res, params.id!, params.sessionId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/agent/sessions/:sessionId/events");
      if (params && method === "GET") {
        await handleAgentSessionEvents(req, res, params.id!, params.sessionId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/agent/sessions/:sessionId");
      if (params && method === "DELETE") {
        await handleDeleteAgentSession(req, res, params.id!, params.sessionId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/agent/sessions");
      if (params && method === "GET") {
        await handleListAgentSessions(req, res, params.id!, url);
        return;
      }
      if (params && method === "POST") {
        await handleCreateAgentSession(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/runs");
      if (params && method === "GET") {
        await handleListRuns(req, res, params.id!, url);
        return;
      }
    }
    // Published Wiki browse: list and read under publicationPath
    {
      const wikiMatch = matchWikiApiRoute(pathname);
      if (wikiMatch && method === "GET") {
        const queryPath = url.searchParams.get("path");
        if (wikiMatch.pagePath !== null) {
          await handleReadWiki(req, res, wikiMatch.id, wikiMatch.pagePath, url);
          return;
        }
        if (queryPath !== null && queryPath.trim() !== "") {
          await handleReadWiki(req, res, wikiMatch.id, queryPath, url);
          return;
        }
        await handleListWiki(req, res, wikiMatch.id, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id");
      if (params) {
        if (method === "GET") {
          await handleGetWorkspace(req, res, params.id!, url);
          return;
        }
        if (method === "PATCH") {
          await handlePatchWorkspace(req, res, params.id!, url);
          return;
        }
        if (method === "DELETE") {
          await handleDeleteWorkspace(req, res, params.id!, url);
          return;
        }
      }
    }

    sendError(res, 404, "not found");
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      sendError(res, 400, error.message);
      return;
    }
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, error.message);
      return;
    }
    process.stderr.write(
      `request error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    sendError(res, 500, "internal server error");
  }
}
