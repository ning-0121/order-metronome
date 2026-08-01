import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // 2026-07-31 事故防线:把 useMemo/useEffect 插在它依赖的 useState **之前**,
    // 构建期完全不报错(TDZ 是运行时的),线上直接白屏
    // `Cannot access 'xx' before initialization` —— 建单页整页打不开。
    // 全局设 warn(存量 8 个文件 31 处待清理);
    // 核心入口文件由 npm run lint:tdz 硬闸把关,见 package.json。
    rules: {
      '@typescript-eslint/no-use-before-define': ['warn', {
        variables: true, functions: false, typedefs: false,
        enums: false, classes: false, ignoreTypeReferences: true,
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
