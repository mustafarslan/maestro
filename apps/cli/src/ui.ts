const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const color = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

export const symbols = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function checkLine(
  status: "ok" | "warn" | "fail" | "info",
  label: string,
  detail?: string,
): string {
  const mark =
    status === "ok"
      ? color.green(symbols.ok)
      : status === "warn"
        ? color.yellow(symbols.warn)
        : status === "info"
          ? color.dim(symbols.info)
          : color.red(symbols.fail);
  return `  ${mark} ${label}${detail ? color.dim(`  ${detail}`) : ""}`;
}
