module.exports = {
  testEnvironment: 'node',

  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
        },
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },

  // Resolve *.js imports to the actual *.ts source files so TypeScript
  // path-based imports (e.g. '../config/env.js') work under Jest/ts-jest.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  moduleFileExtensions: ['ts', 'js', 'json'],

  testMatch: [
    '**/src/tests/**/*.test.ts',
    '**/src/tests/**/*.test.js',
  ],
}
