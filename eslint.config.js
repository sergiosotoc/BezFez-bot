import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      sourceType: "module",   // 👈 aquí el cambio
      globals: globals.node,  // 👈 usa entorno Node, no browser
    },
  },
]);
