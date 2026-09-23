// ESLint flat config for the repo's JavaScript: the vanilla-JS frontend
// (frontend/app/*.js modules, frontend/app.js, the node-run *.test.mjs suites)
// and the node-side tooling under scripts/.
//
// Run from the repo root:
//   npx eslint .                   # lint (must report zero problems)
//   npx eslint . --fix             # apply the autofixes
//
// The rule selection is explicit on purpose: a flat config starts from *no*
// rules, so `js.configs.recommended` (the standard correctness set: no-undef,
// no-unused-vars, no-redeclare, no-dupe-keys, no-cond-assign, …) plus the extra
// rules below is the whole bar. There is no `.eslintignore`; the ignore list is
// the `ignores` block here.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // frontend/vendor/ is a third-party AG Grid Community build we do not own;
    // node_modules is npm's own tree (lint tooling only, never served); the
    // Python venv ships .js inside site-packages that has nothing to do with us.
    ignores: [
      "frontend/vendor/**",
      "node_modules/**",
      "**/*.min.js",
      "**/.venv/**",
      "**/site-packages/**",
    ],
  },

  js.configs.recommended,

  {
    files: ["frontend/**/*.js", "frontend/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Vendored AG Grid Community attaches itself to the window.
        agGrid: "readonly",
      },
    },
    rules: {
      // Correctness additions on top of `recommended`.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      // `console` is the SPA's only diagnostic channel; leave it allowed.
      "no-console": "off",
      // `catch (_) {}` is the SPA's deliberate "ignore this failure" idiom
      // (focus(), grid.redraw(), clipboard writes). This documented option
      // keeps every *other* empty block an error; when the rule was turned on,
      // all 46 no-empty findings in the tree were catch clauses.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // A leading underscore marks a binding that is intentionally unused (the
      // same convention the Python half uses). Anything else is a finding.
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    // The *.test.mjs suites are run by node, not the browser.
    files: ["frontend/**/*.test.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // Repo tooling that runs under node: the Playwright UI smoke and this
    // config file itself.
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];
