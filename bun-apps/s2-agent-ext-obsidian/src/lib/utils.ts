import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileP = promisify(execFile);
