import { expect, test } from 'vitest';
import { installedVersion, reportedVersion } from '../src/chrome-updates.js';

const STATUS = `Package: curl
Status: install ok installed
Version: 8.5.0-2ubuntu10

Package: google-chrome-stable
Status: install ok installed
Priority: optional
Version: 158.0.8127.36-1
Depends: libc6

Package: zlib1g
Status: install ok installed
Version: 1:1.3.dfsg-3.1ubuntu2
`;

test("dpkg's status gives Chrome's installed version without its Debian revision", () => {
  expect(installedVersion(STATUS)).toBe('158.0.8127.36');
  expect(installedVersion(STATUS, 'zlib1g')).toBe('1.3.dfsg');
  expect(installedVersion(STATUS, 'google-chrome-beta')).toBeNull();
  // Removed, with its configuration left behind: not installed.
  expect(installedVersion('Package: google-chrome-stable\nStatus: deinstall ok config-files\nVersion: 157.0.1-1\n')).toBeNull();
});

test("a Chrome's DevTools says which version it runs", () => {
  expect(reportedVersion({ Browser: 'Chrome/156.0.8078.73', 'Protocol-Version': '1.3' })).toBe('156.0.8078.73');
  expect(reportedVersion({ Browser: 'HeadlessChrome/156.0.8078.73' })).toBe('156.0.8078.73');
  expect(reportedVersion({ Browser: 'Firefox/140' })).toBeNull();
  expect(reportedVersion('nonsense')).toBeNull();
});
