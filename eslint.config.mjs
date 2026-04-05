import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      ".claude/**",
      ".githooks/**",
      "assets/*.png",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-empty": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "preserve-caught-error": "off",
    },
  },
];
