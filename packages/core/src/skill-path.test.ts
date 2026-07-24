import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  ensureHomeProducerSkill,
  resolvePackageSkillPath,
  resolveSkillSource,
  resolveWikiSkillPaths,
} from "./skill-path.js";

const prevHome = process.env.HOME;
const prevAppHome = process.env.OKF_WIKI_HOME;

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
  if (prevAppHome === undefined) {
    delete process.env.OKF_WIKI_HOME;
  } else {
    process.env.OKF_WIKI_HOME = prevAppHome;
  }
});

async function isolateAppState(): Promise<string> {
  const appHome = await mkdtemp(path.join(tmpdir(), "okf-app-state-"));
  process.env.OKF_WIKI_HOME = appHome;
  return appHome;
}

test("resolvePackageSkillPath finds @okf-wiki/skill package assets", async () => {
  const pkg = await resolvePackageSkillPath();
  const { access } = await import("node:fs/promises");
  await access(path.join(pkg, "SKILL.md"));
  assert.equal(path.basename(pkg), "skill");
});

test("ensureHomeProducerSkill skips package resolve when home skill exists", async () => {
  const appHome = await isolateAppState();
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  await setLoadHomeSkills(true, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-existing-home-"));
  process.env.HOME = fakeHome;
  const skillDir = path.join(fakeHome, ".agents", "skills", "repository-wiki-producer");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: repository-wiki-producer\ndescription: existing\n---\n# Existing\n",
  );

  const result = await ensureHomeProducerSkill();
  assert.equal(result.seeded, false);
  assert.equal(result.path, path.resolve(skillDir));
});

test("resolveSkillSource prefers explicit skillPath", async () => {
  await isolateAppState();
  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-home-"));
  process.env.HOME = fakeHome;

  const fork = await mkdtemp(path.join(tmpdir(), "okf-fork-"));
  await writeFile(
    path.join(fork, "SKILL.md"),
    "---\nname: fork-skill\ndescription: fork\n---\n# Fork\n",
  );

  const resolved = await resolveSkillSource({ skillPath: fork });
  assert.equal(resolved.kind, "fork");
  assert.equal(resolved.path, path.resolve(fork));
});

test("resolveSkillSource prefers workspace .agents/skills over home", async () => {
  const appHome = await isolateAppState();
  // Enable home skills via app.json
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  await setLoadHomeSkills(true, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-user-home-"));
  process.env.HOME = fakeHome;

  const workspace = await mkdtemp(path.join(tmpdir(), "okf-ws-"));
  const projectSkill = path.join(workspace, ".agents", "skills", "repository-wiki-producer");
  await mkdir(projectSkill, { recursive: true });
  await writeFile(
    path.join(projectSkill, "SKILL.md"),
    "---\nname: repository-wiki-producer\ndescription: project\n---\n# Project\n",
  );

  const resolved = await resolveSkillSource({ workspaceRoot: workspace });
  assert.equal(resolved.kind, "fork");
  assert.equal(resolved.path, path.resolve(projectSkill));
});

test("resolveSkillSource uses ~/.agents/skills when enabled and seeds from package", async () => {
  const appHome = await isolateAppState();
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  await setLoadHomeSkills(true, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-seed-home-"));
  process.env.HOME = fakeHome;

  const resolved = await resolveSkillSource({});
  assert.equal(resolved.kind, "home");
  assert.ok(resolved.path.includes(path.join(".agents", "skills")));
  assert.ok(resolved.path.startsWith(path.resolve(fakeHome)));
  const { access } = await import("node:fs/promises");
  await access(path.join(resolved.path, "SKILL.md"));

  const again = await ensureHomeProducerSkill();
  assert.equal(again.seeded, false);
  assert.equal(again.path, resolved.path);
});

test("resolveSkillSource uses package when home skills disabled in Settings", async () => {
  const appHome = await isolateAppState();
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  await setLoadHomeSkills(false, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-home-off-"));
  process.env.HOME = fakeHome;

  const resolved = await resolveSkillSource({});
  assert.equal(resolved.kind, "package");
  const pkg = await resolvePackageSkillPath();
  assert.equal(resolved.path, pkg);
});

test("resolveSkillSource honors loadHomeSkills override", async () => {
  const appHome = await isolateAppState();
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  // Settings say home is on, but caller overrides to package.
  await setLoadHomeSkills(true, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-home-override-"));
  process.env.HOME = fakeHome;

  const resolved = await resolveSkillSource({ loadHomeSkills: false });
  assert.equal(resolved.kind, "package");
  const pkg = await resolvePackageSkillPath();
  assert.equal(resolved.path, pkg);
});

test("resolveWikiSkillPaths prefers workspace skills root and skips nested producer", async () => {
  const appHome = await isolateAppState();
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  await setLoadHomeSkills(false, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-wiki-paths-home-"));
  process.env.HOME = fakeHome;

  const workspace = await mkdtemp(path.join(tmpdir(), "okf-wiki-paths-ws-"));
  const projectSkill = path.join(workspace, ".agents", "skills", "repository-wiki-producer");
  await mkdir(projectSkill, { recursive: true });
  await writeFile(
    path.join(projectSkill, "SKILL.md"),
    "---\nname: repository-wiki-producer\ndescription: project\n---\n# Project\n",
  );

  const paths = await resolveWikiSkillPaths({ workspaceRoot: workspace });
  assert.deepEqual(paths, [path.resolve(workspace, ".agents", "skills")]);
});

test("resolveWikiSkillPaths adds package producer when outside skills roots", async () => {
  const appHome = await isolateAppState();
  const { setLoadHomeSkills } = await import("./workspace-store.js");
  await setLoadHomeSkills(false, path.join(appHome, "app.json"));

  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-wiki-paths-pkg-"));
  process.env.HOME = fakeHome;

  const paths = await resolveWikiSkillPaths({});
  const pkg = await resolvePackageSkillPath();
  assert.deepEqual(paths, [path.resolve(pkg)]);
});

test("resolveWikiSkillPaths explicit skillPath outside roots is listed once", async () => {
  await isolateAppState();
  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-wiki-paths-fork-"));
  process.env.HOME = fakeHome;

  const fork = await mkdtemp(path.join(tmpdir(), "okf-fork-skill-"));
  await writeFile(
    path.join(fork, "SKILL.md"),
    "---\nname: fork-skill\ndescription: fork\n---\n# Fork\n",
  );

  const paths = await resolveWikiSkillPaths({ skillPath: fork, loadHomeSkills: false });
  assert.deepEqual(paths, [path.resolve(fork)]);
});
