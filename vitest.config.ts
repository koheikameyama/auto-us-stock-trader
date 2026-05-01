import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30000,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // 統合テストが共有 PostgreSQL DB を直接叩くため、ファイル並列実行で
    // race して flaky になる（例: order-manager が Position を作成し、
    // daily-runner.integration の count 結果が汚染される）。ファイル間
    // 並列を無効化して直列実行に倒す。
    fileParallelism: false,
  },
});
