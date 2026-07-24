import { z } from "zod";

/**
 * Where the active Producer Skill was resolved from.
 * - `fork`: project `{root}/.agents/skills/<name>` (or explicit skillPath)
 * - `home`: user `~/.agents/skills/<name>` (when loadHomeSkills is on in Settings)
 * - `package`: package-embedded `@okf-wiki/skill` assets
 */
export const SkillSourceKindSchema = z.enum(["fork", "home", "package"]);

export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>;

/**
 * Operator-facing skill resolution snapshot for Settings / run freeze.
 * Secrets never appear here.
 */
export const SkillInfoSchema = z.object({
  /** Absolute path to the skill directory containing SKILL.md. */
  path: z.string().min(1),
  kind: SkillSourceKindSchema,
  /** Stable content digest of the skill tree (hex sha256). */
  digest: z.string().regex(/^[a-f0-9]{64}$/, "digest must be sha256 hex"),
  /** Frontmatter name from SKILL.md when parseable. */
  name: z.string().min(1).optional(),
  /** Frontmatter description when parseable. */
  description: z.string().optional(),
  /** Relative paths under the skill root (files only). */
  files: z.array(z.string().min(1)).default([]),
});

export type SkillInfo = z.infer<typeof SkillInfoSchema>;

/** One skill file entry for the fork editor (outbound API DTO). */
export type SkillFileEntry = {
  /** Skill-relative POSIX path. */
  path: string;
  kind: "file" | "directory";
};

/** Skill file body for the fork editor (outbound API DTO). */
export type SkillFileContent = {
  path: string;
  content: string;
  /** Bytes of content (UTF-8). */
  bytes: number;
};
