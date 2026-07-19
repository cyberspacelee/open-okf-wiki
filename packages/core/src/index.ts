export { probeLocalGit } from "./git.js";
export {
  assertAbsolutePath,
  assertNoSymlinkComponents,
  resolveExistingDir,
} from "./paths.js";
export {
  countMarkdownFiles,
  publishStagingToPublication,
  type PublishStagingInput,
  type PublishStagingResult,
} from "./publish.js";
export {
  listPublishedWikiPages,
  readPublishedWikiPage,
  extractTitleFromFrontmatter,
  resolvePublishedWikiPath,
  toPublishedWikiPosixRelative,
  PublishedWikiError,
  PUBLISHED_WIKI_MAX_PAGES,
  PUBLISHED_WIKI_MAX_FILE_BYTES,
  type PublishedWikiPage,
  type PublishedWikiErrorCode,
} from "./published-wiki.js";
export {
  validateWikiTree,
  hasNonEmptyTitleFrontmatter,
  WIKI_VALIDATE_MAX_FILES,
  WIKI_VALIDATE_MAX_FILE_BYTES,
  type ValidateWikiResult,
} from "./validate-wiki.js";
export {
  WORKSPACE_DIR_NAME,
  WORKSPACE_FILE_NAME,
  APP_STATE_FILE_NAME,
  DEFAULT_MODEL_ID,
  workspaceConfigPath,
  workspaceMetaDir,
  defaultAppStatePath,
  isPathInside,
  createWorkspace,
  loadWorkspace,
  saveWorkspace,
  addSource,
  removeSource,
  registerWorkspaceInAppIndex,
  removeWorkspaceFromAppIndex,
  listRecentWorkspaces,
  listWorkspaces,
  listWorkspaceSummaries,
  loadWorkspaceById,
  deleteWorkspaceMeta,
  slugFromPath,
  uniqueSourceId,
  type CreateWorkspaceOptions,
  type AddSourceInput,
  type AddSourceOptions,
  type WorkspaceSummary,
} from "./workspace-store.js";
