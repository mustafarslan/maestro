#!/usr/bin/env node
/**
 * Checks that every published release asset is actually built for the platform its name
 * claims — by reading the executable header, not by trusting the filename.
 *
 * The release workflow passes `bun build --compile --target=<triple>`. If that flag were
 * dropped, renamed, or silently ignored, every job would still produce a binary, every
 * upload would still succeed, and the release would carry four files named for four
 * platforms that were all built for whichever runner happened to run last. Three quarters
 * of users would download something that cannot execute, and the installer would tell them
 * their platform is unsupported — which is exactly what it would look like.
 *
 * Headers are parsed here rather than shelling out to `file`, whose output wording is not
 * a stable interface.
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/release-assets-check.mjs [owner/repo]
 */
const repo = process.argv[2] ?? "mustafarslan/maestro";
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const gh = (path, accept = "application/vnd.github+json") =>
  fetch(`https://api.github.com/${path}`, {
    headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });

/** name suffix -> what the header must say. */
const EXPECTED = {
  "darwin-arm64": { format: "Mach-O", machine: 0x0100000c },
  "darwin-x64": { format: "Mach-O", machine: 0x01000007 },
  "linux-x64": { format: "ELF", machine: 0x3e },
  "linux-arm64": { format: "ELF", machine: 0xb7 },
};

/** Returns {format, machine} from the first bytes of an executable. */
function identify(buf) {
  const be = buf.readUInt32BE(0);
  const le = buf.readUInt32LE(0);
  // Mach-O 64-bit, either byte order. cputype is the next word.
  if (le === 0xfeedfacf) return { format: "Mach-O", machine: buf.readUInt32LE(4) };
  if (be === 0xfeedfacf) return { format: "Mach-O", machine: buf.readUInt32BE(4) };
  if (buf.subarray(0, 4).toString("hex") === "7f454c46") {
    // ELF: e_machine is a 16-bit field at offset 18, endianness from byte 5.
    const little = buf[5] === 1;
    return { format: "ELF", machine: little ? buf.readUInt16LE(18) : buf.readUInt16BE(18) };
  }
  return { format: "unknown", machine: 0 };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const release = await (await gh(`repos/${repo}/releases/latest`)).json();
if (!release?.tag_name) {
  console.log(
    `\nno published release for ${repo}${token ? "" : " (private repos need GITHUB_TOKEN)"}\n`,
  );
  process.exit(2);
}
console.log(`\nrelease assets — ${repo} ${release.tag_name}\n`);

const assets = new Map((release.assets ?? []).map((a) => [a.name, a]));
for (const [suffix, want] of Object.entries(EXPECTED)) {
  const asset = assets.get(`maestro-${suffix}`);
  if (!asset) {
    check(suffix, false, "no such asset in the release — install.sh would 404 on this platform");
    continue;
  }
  const res = await gh(`repos/${repo}/releases/assets/${asset.id}`, "application/octet-stream");
  const buf = Buffer.from(await res.arrayBuffer());
  const got = identify(buf.subarray(0, 64));
  const ok = got.format === want.format && got.machine === want.machine;
  check(
    suffix,
    ok,
    ok
      ? `${got.format}, ${(buf.length / 1e6).toFixed(0)}MB`
      : `header says ${got.format}/0x${got.machine.toString(16)}, expected ${want.format}/0x${want.machine.toString(16)}`,
  );
}

console.log(
  failures
    ? `\n${failures} asset(s) wrong\n`
    : "\nevery asset matches the platform it is named for\n",
);
process.exit(failures ? 1 : 0);
