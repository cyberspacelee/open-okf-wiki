import { z } from "zod";

/** Whether the active skill is the product bundle or a workspace fork. */
export const SkillSourceKindSchema = z.enum(["bundled", "fork"]);

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

/** One skill file entry for the fork editor. */
export const SkillFileEntrySchema = z.object({
  /** Skill-relative POSIX path. */
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
});

export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

export const SkillFileContentSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Bytes of content (UTF-8). */
  bytes: z.number().int().nonnegative(),
});

export type SkillFileContent = z.infer<typeof SkillFileContentSchema>;
