import security from "eslint-plugin-security";
import reactHooks from "./client/node_modules/eslint-plugin-react-hooks/index.js";

export default [
  {
    ignores: ["node_modules/", "client/node_modules/", "client/build/"],
  },
  {
    files: ["server/**/*.js"],
    plugins: {
      security,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      // Security rules
      ...security.configs.recommended.rules,

      // Dangerous patterns
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Code quality
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_|^next$|^req$|^res$" }],
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["error", "always"],
      "no-throw-literal": "error",
      "no-return-await": "warn",
      "require-await": "warn",

      // Console (allow warn/error for server logging)
      "no-console": ["warn", { allow: ["warn", "error", "log"] }],
    },
  },
  {
    files: ["client/src/**/*.{js,jsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          // Catch regressions to the pre-shim-removal pattern. After the migration,
          // axios errors are { message, code, fieldErrors, status } — no `response`.
          // Files that use raw axios (not our `api` instance) need an inline
          // `// eslint-disable-next-line no-restricted-syntax` comment to opt out.
          selector: "MemberExpression[property.name='response'][object.type='Identifier']",
          message: "Reads from `err.response` are forbidden in client code — the api.js interceptor now exposes { message, code, fieldErrors, status } directly. Use `err.message` / `err.fieldErrors` / `err.status`. If using raw axios, add an inline eslint-disable-next-line comment.",
        },
      ],
    },
  },
];
