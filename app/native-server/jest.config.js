module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/scripts/**/*'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  // tsconfig.json uses module: NodeNext + ESM-style .js import specifiers
  // (e.g. `import './foo.js'`). jest-resolve runs in CommonJS, so it looks
  // for the literal '.js' file and fails because this repo never emits a
  // `dist/` (no build artifact). Rewrite .js -> .ts at resolution time.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // ts-jest 29.x with NodeNext module kind: pin to CommonJS at test time
  // (otherwise jest tries to load source as ESM and fails). isolatedModules
  // in tsconfig.json silences the hybrid-module warning.
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: false,
        tsconfig: { module: 'CommonJS', moduleResolution: 'Node' },
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
};
