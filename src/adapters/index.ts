import type { Project } from "../core/config.js";
import { GitHub } from "./github.js";
import { GitLab } from "./gitlab.js";
import type { Platform } from "./types.js";

export function createPlatform(project: Project, repo?: string): Platform {
  return project.platform === "gitlab" ? new GitLab() : new GitHub(repo);
}

export type { Platform } from "./types.js";
