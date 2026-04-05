import js from "@eslint/js"
import tseslint from "typescript-eslint"
import importX, { createNodeResolver } from "eslint-plugin-import-x"

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  importX.flatConfigs.recommended,
  {
    settings: {
      "import-x/resolver-next": [createNodeResolver()],
    },
    rules: {
      // Flag imports not listed in package.json
      "import-x/no-extraneous-dependencies": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-this-alias": "off",
      "import-x/no-unresolved": "off",
      "import-x/named": "off",
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js"],
  },
)
