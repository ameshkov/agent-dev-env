// commands/register.test.ts — the lifecycle command surface: the
// `build --help` and `deploy --help` output must explain which images
// are available.

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerLifecycleCommands } from './register.js';

describe('registerLifecycleCommands', () => {
  function buildProgram(): Command {
    const program = new Command();
    registerLifecycleCommands(program);
    return program;
  }

  /** Captures the `--help` output of a registered lifecycle command.
   *
   * @param commandName - The command to get help for.
   * @returns The help text as written by outputHelp().
   */
  function commandHelp(commandName: string): string {
    const command = buildProgram().commands.find((c) => c.name() === commandName);
    expect(command).toBeDefined();
    // `addHelpText` text is written by outputHelp() (what `--help` runs),
    // not by helpInformation(), so capture the written output.
    let out = '';
    command?.configureOutput({
      writeOut: (str: string) => {
        out += str;
      },
      writeErr: () => {},
    });
    command?.outputHelp();
    return out;
  }

  it('lists the available images in the build help text', () => {
    const help = commandHelp('build');
    expect(help).toContain('Available images:');
    expect(help).toContain('sandbox-macos-tahoe (macos)');
  });

  it('explains that building with no image builds all images', () => {
    const help = commandHelp('build');
    expect(help).toContain('no image = build all available images');
  });

  it('lists the available images in the deploy help text', () => {
    const help = commandHelp('deploy');
    expect(help).toContain('Available images:');
    expect(help).toContain('sandbox-macos-tahoe (macos)');
  });

  it('explains that deploying with no image deploys all images', () => {
    const help = commandHelp('deploy');
    expect(help).toContain('no image = deploy all available images');
  });
});
