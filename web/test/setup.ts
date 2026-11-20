// Runs before every web test file (vitest.config.ts). Tests run in Node without a DOM; configStore
// applies the theme to the document when it loads, so it gets the little of one it touches.
Object.assign(globalThis, { document: { documentElement: { dataset: {}, style: {} }, visibilityState: 'hidden' } });
