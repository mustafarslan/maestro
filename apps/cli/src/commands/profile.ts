import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { openStore } from "@maestro/core";
import {
  type Battery,
  type BatteryItem,
  bundledBattery,
  type DeveloperCognitiveProfile,
  LIKERT_ANCHORS,
  ProfileStore,
  type Responses,
  reviewFirstItems,
} from "@maestro/profile";
import { arg, has, rejectUnknownFlags, wantsHelp } from "../args.js";
import { color } from "../ui.js";

function usage(code = 1): number {
  console.log(`
${color.bold("maestro profile")} <subcommand>

  take                       answer the calibration battery, one item at a time
    --category <prefix>      only items whose id starts with it: COG, DEBT, PED, GATE, LING, HAB, BUG
    --redo                   ask again items already answered
  answer <item-id> <label>   record one answer
  import <responses.json>    record a sheet of {"<item-id>": "<label>"} answers
    --replace                discard the saved sheet first
  show [--json]              the scored profile and how much of it is observed
  list                       everyone with a profile, and which one is active
  activate                   run every review as this subject's profile
  deactivate                 run reviews without a profile again
  forget [--item <id>]       remove one answer, or the whole sheet
  review-first               the items the battery's authors shipped on judgement

  --subject <login>          whose profile (default: your OS user name)

The battery is the Developer Cognitive Profile Calibration Battery (v${bundledBattery().version}).
Answers are saved as you go, so a session can stop at any item and resume later.
A profile shapes how findings are gated and worded; it never changes what the
agents diagnose.
`);
  return code;
}

/** Arguments that are neither a flag nor a flag's value. */
function positionals(argv: string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      if (valued.includes(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

const pct = (v: number | null) => (v === null ? color.dim("  —  ") : v.toFixed(2).padStart(5));

function printProfile(subject: string, answered: number, p: DeveloperCognitiveProfile): void {
  const total = answered + p.coverage.itemsSkipped.length;
  console.log(color.bold(`\n${subject}`) + color.dim(`  battery ${p.batteryVersion}`));
  console.log(`  ${answered} of ${total} items answered\n`);

  console.log(color.bold("  core"));
  for (const [k, v] of Object.entries(p.attributes)) {
    console.log(`    ${k.padEnd(30)} ${pct(v)}  ${color.dim(`n=${p.coverage.nPerAttribute[k]}`)}`);
  }
  const labels = [
    ["framing", p.framingStrategy],
    ["kai", p.kaiClassification],
    ["regulatory focus", p.regulatoryFocusLabel],
    ["politeness tags", p.useNegativePolitenessTags ? "yes" : "no"],
  ] as const;
  console.log("");
  for (const [k, v] of labels) console.log(`    ${k.padEnd(30)} ${v ?? color.dim("unobserved")}`);

  console.log(color.bold("\n  topic weights") + color.dim("  (0.50 where unobserved)"));
  for (const [k, v] of Object.entries(p.topicWeights)) {
    const n = p.coverage.nPerTopic[k] ?? 0;
    console.log(`    ${k.padEnd(30)} ${n ? pct(v) : color.dim(pct(v))}  ${color.dim(`n=${n}`)}`);
  }
  console.log(color.bold("\n  style signals") + color.dim("  (0.50 where unobserved)"));
  for (const [k, v] of Object.entries(p.extendedSignals)) {
    const n = p.coverage.nPerExtendedSignal[k] ?? 0;
    console.log(`    ${k.padEnd(30)} ${n ? pct(v) : color.dim(pct(v))}  ${color.dim(`n=${n}`)}`);
  }
  console.log("");
}

function offered(item: BatteryItem): string[] {
  return item.format === "likert_5" ? [...LIKERT_ANCHORS] : item.options.map((o) => o.label);
}

function renderItem(item: BatteryItem, index: number, total: number, out: (s: string) => void) {
  out("");
  out(color.bold(`[${index}/${total}] ${item.id}`) + color.dim(`  ${item.category}`));
  const pr = item.pr_context;
  if (pr) {
    out(`\n${color.bold("PR:")} ${pr.title}`);
    out(`  ${pr.description}`);
    out(
      color.dim(
        `  CI ${pr.ci_status} · ${pr.files_changed} file(s), +${pr.additions} −${pr.deletions}`,
      ),
    );
    if (pr.author_note) out(color.dim(`  author: ${pr.author_note}`));
  }
  out(`\n${item.scenario}\n`);
  // Six Likert items carry no diff at all — they are statements about how one reviews — and
  // rendering `null` as a diff threw on the third item of the first category.
  for (const line of item.code?.split("\n") ?? []) {
    out(
      line.startsWith("+") && !line.startsWith("+++")
        ? color.green(line)
        : line.startsWith("-") && !line.startsWith("---")
          ? color.red(line)
          : color.dim(line),
    );
  }
  out(`\n${color.bold(item.prompt)}\n`);
  // In the stored label order: the options were shuffled once, on purpose, and scoring reads
  // the chosen option's own mapping, so presenting them any other way changes nothing but
  // defeats the shuffle.
  for (const o of item.options) out(`  ${color.cyan(o.label)}. ${o.text}`);
}

async function take(
  argv: string[],
  store: ProfileStore,
  battery: Battery,
  subject: string,
  io: ProfileIo,
): Promise<number> {
  const prefix = arg(argv, "--category")?.toUpperCase();
  const redo = has(argv, "--redo");
  const answered = store.get(subject)?.responses ?? {};
  const queue = battery.items.filter(
    (i) => (!prefix || i.id.startsWith(prefix)) && (redo || answered[i.id] === undefined),
  );
  if (!queue.length) {
    console.log(
      prefix && !battery.items.some((i) => i.id.startsWith(prefix))
        ? `no item ids start with '${prefix}'`
        : "nothing left to answer. --redo asks again.",
    );
    return prefix && !battery.items.some((i) => i.id.startsWith(prefix)) ? 1 : 0;
  }

  const rl = createInterface({ input: io.input, terminal: false });
  // The line iterator, not `rl.question`: a line that arrives while no question is pending
  // is dropped by `question`, so answers piped in faster than they are asked for vanished —
  // measured, a scripted five-line session saved nothing. The iterator buffers them.
  const lines = rl[Symbol.asyncIterator]();
  const out = (s: string) => io.output.write(`${s}\n`);
  let saved = 0;
  let stopped = false;

  try {
    for (const [n, item] of queue.entries()) {
      renderItem(item, n + 1, queue.length, out);
      const labels = offered(item);
      for (;;) {
        io.output.write(`\nanswer ${labels.join("/")}, s to skip, q to stop: `);
        const next = await lines.next();
        if (next.done) {
          stopped = true;
          break;
        }
        const raw = String(next.value).trim();
        const answer = raw.toUpperCase();
        if (answer === "Q") {
          stopped = true;
          break;
        }
        if (answer === "S") break;
        if (!labels.includes(answer)) {
          out(color.yellow(`'${raw}' is not one of ${labels.join(", ")}`));
          continue;
        }
        store.record(subject, { [item.id]: answer });
        saved++;
        break;
      }
      if (stopped) break;
    }
  } finally {
    rl.close();
  }

  const now = store.get(subject);
  out(
    `\n${saved} answer(s) saved for ${subject}; ${now?.answered ?? 0} of ${battery.items.length} answered.`,
  );
  if (now && now.answered < battery.items.length) out(color.dim("run it again to continue."));
  return 0;
}

export interface ProfileIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export async function profile(
  argv: string[],
  io: ProfileIo = { input: process.stdin, output: process.stdout },
): Promise<number> {
  rejectUnknownFlags(argv, ["--subject", "--category", "--redo", "--replace", "--json", "--item"]);
  if (wantsHelp(argv)) return usage(0);
  const [sub, ...args] = positionals(argv, ["--subject", "--category", "--item"]);
  if (!sub) return usage();
  if (
    ![
      "take",
      "answer",
      "import",
      "show",
      "list",
      "forget",
      "review-first",
      "activate",
      "deactivate",
    ].includes(sub)
  ) {
    console.error(`unknown subcommand: ${sub}`);
    return usage();
  }

  const battery = bundledBattery();
  if (sub === "review-first") {
    console.log(color.bold("\nshipped on the battery authors' judgement — read these first\n"));
    for (const { id, note } of reviewFirstItems(battery)) {
      const item = battery.items.find((i) => i.id === id);
      console.log(`  ${color.cyan(id)}  ${item?.pr_context?.title ?? ""}`);
      if (note) console.log(color.dim(`        ${note}`));
    }
    console.log("");
    return 0;
  }

  const subject = arg(argv, "--subject") ?? userInfo().username;
  const db = await openStore();
  try {
    const store = new ProfileStore(db, battery);

    if (sub === "take") return await take(argv, store, battery, subject, io);

    if (sub === "answer") {
      const [itemId, label] = args;
      if (!itemId || !label) {
        console.error("usage: maestro profile answer <item-id> <label>");
        return 1;
      }
      const saved = store.record(subject, { [itemId.toUpperCase()]: label.toUpperCase() });
      console.log(
        `saved ${itemId.toUpperCase()}=${label.toUpperCase()} for ${saved.subject} (${saved.answered} answered)`,
      );
      return 0;
    }

    if (sub === "import") {
      const [file] = args;
      if (!file) {
        console.error("usage: maestro profile import <responses.json>");
        return 1;
      }
      const sheet = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!sheet || typeof sheet !== "object" || Array.isArray(sheet)) {
        console.error(`${file} must hold one object of {"<item-id>": "<label>"}`);
        return 1;
      }
      const saved = store.record(subject, sheet as Responses, { replace: has(argv, "--replace") });
      console.log(
        `imported into ${saved.subject}: ${saved.answered} of ${battery.items.length} answered`,
      );
      return 0;
    }

    if (sub === "show") {
      const saved = store.get(subject);
      if (!saved) {
        console.error(
          `no profile for ${subject}. Start one: maestro profile take --subject ${subject}`,
        );
        return 1;
      }
      if (has(argv, "--json")) console.log(JSON.stringify(saved, null, 2));
      else printProfile(saved.subject, saved.answered, saved.profile);
      if (!has(argv, "--json") && saved.active)
        console.log(color.green("  active: reviews run as this profile\n"));
      return 0;
    }

    if (sub === "activate") {
      const saved = store.activate(subject);
      console.log(
        `reviews now run as ${saved.subject} (${saved.answered} of ${battery.items.length} items answered)`,
      );
      if (saved.answered < battery.items.length) {
        console.log(
          color.dim(
            "unanswered attributes fall back to the policy defaults; maestro profile take continues",
          ),
        );
      }
      return 0;
    }

    if (sub === "deactivate") {
      const was = store.deactivate();
      console.log(was ? `reviews no longer run as ${was}` : "no profile was active");
      return 0;
    }

    if (sub === "list") {
      const rows = store.list();
      if (!rows.length) {
        console.log("no profiles yet. maestro profile take");
        return 0;
      }
      for (const r of rows) {
        console.log(
          `  ${color.cyan(r.subject.padEnd(24))} ${String(r.answered).padStart(3)} answered  ${color.dim(r.updatedAt)}${r.active ? `  ${color.green("active")}` : ""}`,
        );
      }
      return 0;
    }

    // forget
    const item = arg(argv, "--item");
    const left = store.forget(subject, item ? [item.toUpperCase()] : undefined);
    if (!left) {
      console.error(`no profile for ${subject}`);
      return 1;
    }
    console.log(
      item
        ? `forgot ${item.toUpperCase()} for ${left.subject}`
        : `cleared every answer for ${left.subject}`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    db.close();
  }
}
