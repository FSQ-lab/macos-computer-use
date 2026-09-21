import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["dist/**", "node_modules/**"] }, eslint.configs.recommended, {
  files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
  extends: [...tseslint.configs.strictTypeChecked],
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: ["vitest.config.ts"] },
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-confusing-void-expression": "off",
    "@typescript-eslint/require-await": "off",
  },
});
