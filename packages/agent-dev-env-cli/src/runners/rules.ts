// runners/rules.ts — the agent-rules step: render the bundled
// assets/rules/agent-rules.md (macOS) or agent-rules-linux.md (Ubuntu)
// with the run's actual paths, prepend the host's global opencode
// AGENTS.md (when present) and stream the merged document into the
// guest's agent (`rules --probe` / `rules --force`), keeping the shell's
// probe/confirm/overwrite semantics (see run-macos-sandbox.sh
// §"agent rules").
//
// The probe only inspects the guest and reports the pending action; the
// write happens only after the user confirmed. The SSH agent section is
// dropped from the render when no agent bridge is actually up, so the
// rules never claim a bridge that is not running.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropSectionFrom, render } from '../lib/template.js';

/** The SSH section heading in the rules files (shared by both assets). */
const SSH_RULES_HEADING = '## SSH agent bridge';

/** The host's global opencode instructions path (prepended over the
 *  sandbox rules when present). */
function hostAgentRulesPath(home: string): string {
  return join(home, '.config', 'opencode', 'AGENTS.md');
}

/** Path of a bundled rules asset.
 *
 * @param name - The asset file name (agent-rules.md / agent-rules-linux.md).
 * @returns The absolute path in dist/assets/rules.
 */
function agentRulesPath(name: string): string {
  return fileURLToPath(new URL(`../assets/rules/${name}`, import.meta.url));
}

/** Loads a bundled rules document (missing file → warn, no content).
 *
 * @param name - The asset file name (default agent-rules.md).
 * @returns The raw rules text; empty when the asset is missing.
 */
export function loadAgentRules(name = 'agent-rules.md'): string {
  try {
    return readFileSync(agentRulesPath(name), 'utf8');
  } catch {
    return '';
  }
}

/** Renders the rules document for this run.
 *
 * @param content - The raw rules text.
 * @param substitutions - {{HOST_WORK_DIR}} / {{GUEST_MOUNT}} (and
 *   {{NAT_GATEWAY}} for the linux asset) values.
 * @param includeSsh - Whether the SSH agent bridge section stays.
 * @returns The rendered document.
 */
export function renderAgentRules(
  content: string,
  substitutions: Record<string, string>,
  includeSsh: boolean,
): string {
  const rendered = render(content, substitutions);
  return includeSsh ? rendered : dropSectionFrom(rendered, SSH_RULES_HEADING);
}

/** Loads the host's global opencode AGENTS.md.
 *
 * @param home - The host home directory (defaults to os.homedir()).
 * @returns The file text; empty when it does not exist.
 */
export function loadHostGlobalAgents(home: string = homedir()): string {
  try {
    return readFileSync(hostAgentRulesPath(home), 'utf8');
  } catch {
    return '';
  }
}

/** Merges the host's global instructions with the rendered sandbox
 *  rules: the host document first, then the sandbox rules behind a
 *  separator. No host content → the sandbox rules alone.
 *
 * @param hostRules - The host's global AGENTS.md text (may be empty).
 * @param sandboxRules - The rendered sandbox rules.
 * @returns The merged document.
 */
export function mergeAgentRules(hostRules: string, sandboxRules: string): string {
  const host = hostRules.trim();
  if (!host) return sandboxRules;
  return `${host}\n\n---\n\n${sandboxRules}`;
}
