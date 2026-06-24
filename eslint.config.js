import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-electron", "release", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "electron/**/*.ts"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        document: "readonly",
        process: "readonly",
        window: "readonly"
      }
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-undef": "off"
    }
  }
);
