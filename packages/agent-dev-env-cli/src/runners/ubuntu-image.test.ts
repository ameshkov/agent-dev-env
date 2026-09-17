import { describe, expect, it } from 'vitest';
import { ubuntuWorkingVmx } from './ubuntu-image.js';

describe('ubuntuWorkingVmx', () => {
  it('builds the working clone path under the ubuntu-vmware state root', () => {
    expect(ubuntuWorkingVmx('img', 'default-agent-dev-env')).toMatch(
      /ubuntu-vmware\/img\/working\/default-agent-dev-env\/img\.vmx$/,
    );
  });
});
