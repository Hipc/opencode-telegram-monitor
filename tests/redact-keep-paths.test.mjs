// tests/redact-keep-paths.test.mjs
//
// keep-paths 脱敏变体单测（docs/modules/sessions-relay.md §13.12.1/§13.12.3，
// REDACT-001~003）：
//   REDACT-001 绝对路径（含 45+ 字符长路径）原样保留，不出现
//             <external-path> / <project> / [REDACTED_VALUE]
//   REDACT-002 botToken 与 sk-xxx 类密钥仍被 [REDACTED]（密钥链与 safeText 一致）
//   REDACT-003 limit 截断加 `...` 尾，与 safeText 行为一致
//
// 纯函数测试：直接 import src/format/redact.ts（TS，behavior.test.mjs 先例），
// 无文件写入、无需 HOME 隔离。
// 运行：bun tests/redact-keep-paths.test.mjs

const redactURL = new URL("../src/format/redact.ts", import.meta.url);
const { safeText, safeTextKeepPaths } = await import(redactURL.href);

let failures = 0;
let total = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function runCase(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

// 假配置（绝不真发；仅作为脱敏上下文）。
const botToken = "123456789:TESTTOKEN_DO_NOT_USE_abcdefg";
const ctx = { root: "/home/user/project", botToken };
const FORBIDDEN = ["<external-path>", "<project>", "[REDACTED_VALUE]"];

// REDACT-001: keep-paths 放开路径类脱敏——绝对路径与 45+ 字符长路径原样保留。
await runCase("REDACT-001 keep-paths preserves absolute & long paths", () => {
  const shortPath = "/a/b/c.ts";
  const longPath =
    "/home/user/work/projects/some/very-long-directory-name-here.ts";
  assert(
    longPath.length >= 45,
    `longPath must be >=45 chars for the test, got ${longPath.length}`,
  );

  const shortOut = safeTextKeepPaths(shortPath, 300, ctx);
  assert(
    shortOut === shortPath,
    `expected ${shortPath} preserved, got ${JSON.stringify(shortOut)}`,
  );
  const longOut = safeTextKeepPaths(longPath, 300, ctx);
  assert(
    longOut === longPath,
    `expected ${longPath} preserved, got ${JSON.stringify(longOut)}`,
  );
  for (const marker of FORBIDDEN) {
    assert(
      !shortOut.includes(marker),
      `short path must not contain ${marker}`,
    );
    assert(
      !longOut.includes(marker),
      `long path must not contain ${marker}`,
    );
  }

  // 对照组：safeText 仍做路径脱敏——证明差异只存在于路径类规则。
  const st = safeText(shortPath, 300, ctx);
  assert(
    st.includes("<external-path>"),
    `safeText must still redact paths, got ${JSON.stringify(st)}`,
  );
});

// REDACT-002: keep-paths 保留全部密钥/token 脱敏——botToken 与 sk-xxx 仍被 [REDACTED]。
await runCase("REDACT-002 keep-paths still redacts botToken & sk keys", () => {
  const tokenInput = `access granted with token ${botToken} for this repo`;
  const tk = safeTextKeepPaths(tokenInput, 300, ctx);
  assert(
    tk.includes("[REDACTED]"),
    `expected botToken redacted, got ${JSON.stringify(tk)}`,
  );
  assert(
    !tk.includes(botToken),
    `botToken must not leak, got ${JSON.stringify(tk)}`,
  );
  assert(
    tk === safeText(tokenInput, 300, ctx),
    "botToken redaction must match safeText",
  );

  const skInput = "use sk-ant-api03-abcdefghijklmnop as the credential";
  const sk = safeTextKeepPaths(skInput, 300, ctx);
  assert(
    sk.includes("[REDACTED]"),
    `expected sk key redacted, got ${JSON.stringify(sk)}`,
  );
  assert(
    !sk.includes("sk-ant-api03"),
    `sk key must not leak, got ${JSON.stringify(sk)}`,
  );
  assert(
    sk === safeText(skInput, 300, ctx),
    "sk redaction must match safeText",
  );
});

// REDACT-003: keep-paths limit 截断——超长输入 `slice + "..."`，与 safeText 一致；
// 限内输入原样返回。
await runCase("REDACT-003 keep-paths limit truncation matches safeText", () => {
  const longInput =
    "permission granted for tool bash with pattern read the project file ".repeat(
      3,
    );
  const out = safeTextKeepPaths(longInput, 40, ctx);
  assert(
    out.length === 40,
    `expected length 40, got ${out.length}: ${JSON.stringify(out)}`,
  );
  assert(
    out.endsWith("..."),
    `expected '...' suffix, got ${JSON.stringify(out)}`,
  );
  assert(
    out === safeText(longInput, 40, ctx),
    "keep-paths truncation must match safeText",
  );
  const folded = longInput.replace(/\s+/g, " ").trim();
  assert(
    out.slice(0, 37) === folded.slice(0, 37),
    "truncated prefix must be the whitespace-folded prefix",
  );

  const shortOut = safeTextKeepPaths("short value", 100, ctx);
  assert(
    shortOut === "short value",
    `within-limit input must be unchanged, got ${JSON.stringify(shortOut)}`,
  );
});

const passed = total - failures;
console.log(`\n${passed}/${total} cases passed`);
process.exit(failures === 0 ? 0 : 1);
