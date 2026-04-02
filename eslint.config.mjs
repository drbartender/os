import security from "eslint-plugin-security";

export default [
  {
    ignores: ["node_modules/", "client/"],
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
];
