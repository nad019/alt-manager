#!/usr/bin/env node
// alt-manager — create, extend, inspect, deactivate and close Solana Address Lookup Tables.
// MIT License, Copyright (c) 2026 HHVL (https://github.com/nad019)
//
// Every command that writes on chain is a DRY RUN unless --send is given; with --send each transaction is simulated
// first and only sent if the simulation succeeds.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const MAX_ADDRESSES = 256;
// a deactivated table can be closed once its deactivation slot has left the SlotHashes sysvar (512 slots)
const DEACTIVATION_COOLDOWN_SLOTS = 513;

// ---------- config ----------

function loadDotEnv(file = path.join(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val; // real environment wins
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const c of s) {
    let carry = B58.indexOf(c);
    if (carry < 0) throw new Error("invalid base58 character in PRIVATE_KEY");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function loadKeypair(): Keypair {
  const inline = (process.env.PRIVATE_KEY || "").trim();
  let secret: Uint8Array;
  if (inline) {
    secret = inline.startsWith("[") ? Uint8Array.from(JSON.parse(inline)) : base58Decode(inline);
  } else {
    const p = (process.env.KEYPAIR_PATH || "~/.config/solana/id.json").replace(/^~(?=$|\/)/, os.homedir());
    if (!fs.existsSync(p)) throw new Error(`keypair file not found: ${p} (set KEYPAIR_PATH or PRIVATE_KEY)`);
    secret = Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")));
  }
  if (secret.length !== 64) throw new Error(`secret key must be 64 bytes, got ${secret.length}`);
  return Keypair.fromSecretKey(secret);
}

// ---------- address files ----------

interface Entry {
  address: string;
  label: string;
}

// Accepted formats: JSON array of strings or {address,label} objects, a JSON object with an "addresses" array
// (the output of `show --out`), or plain text with one address per line and an optional "# label".
function readAddressFile(file: string): Entry[] {
  const text = fs.readFileSync(file, "utf8");
  const trimmed = text.trim();
  let entries: Entry[] = [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    const arr: unknown[] = Array.isArray(json) ? json : json.addresses;
    if (!Array.isArray(arr)) throw new Error(`${file}: expected a JSON array or an object with "addresses"`);
    entries = arr.map((x: any) =>
      typeof x === "string" ? { address: x, label: "" } : { address: String(x.address), label: String(x.label || "") },
    );
  } else {
    for (const raw of text.split("\n")) {
      const hash = raw.indexOf("#");
      const addr = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
      if (!addr) continue;
      entries.push({ address: addr, label: hash >= 0 ? raw.slice(hash + 1).trim() : "" });
    }
  }
  for (const e of entries) {
    let ok = false;
    try {
      ok = new PublicKey(e.address).toBase58() === e.address;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${file}: invalid address "${e.address}"`);
  }
  return entries;
}

// ---------- chain helpers ----------

async function fetchTable(conn: Connection, table: PublicKey): Promise<AddressLookupTableAccount> {
  const res = await conn.getAddressLookupTable(table);
  if (!res.value) throw new Error(`lookup table ${table.toBase58()} not found`);
  return res.value;
}

function requireAuthority(t: AddressLookupTableAccount, kp: Keypair): void {
  const auth = t.state.authority;
  if (!auth) throw new Error("table is frozen (no authority): it can no longer be modified");
  if (!auth.equals(kp.publicKey)) {
    throw new Error(`table authority is ${auth.toBase58()}, but the loaded keypair is ${kp.publicKey.toBase58()}`);
  }
}

function isActive(t: AddressLookupTableAccount): boolean {
  return t.state.deactivationSlot === BigInt("18446744073709551615");
}

// Simulate, then send and confirm. Returns the signature; throws (with program logs) if the simulation fails.
async function simulateAndSend(conn: Connection, kp: Keypair, ixs: TransactionInstruction[], what: string): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).map((l) => "    " + l).join("\n");
    throw new Error(`${what}: simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`);
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${what}: transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  console.log(`  ${what}: ${sig}`);
  return sig;
}

// Picks the entries that are new (valid, not duplicated, not already in the table) and checks the 256 limit.
function plan(entries: Entry[], existing: Set<string>): PublicKey[] {
  const seen = new Set<string>();
  const todo: PublicKey[] = [];
  for (const e of entries) {
    const label = e.label ? `  ${e.label}` : "";
    if (seen.has(e.address)) {
      console.log(`  duplicate in file, skipped: ${e.address}${label}`);
      continue;
    }
    seen.add(e.address);
    if (existing.has(e.address)) {
      console.log(`  already in table:           ${e.address}${label}`);
      continue;
    }
    console.log(`  + ${e.address}${label}`);
    todo.push(new PublicKey(e.address));
  }
  const total = existing.size + todo.length;
  console.log(`to add: ${todo.length}  →  ${total} / ${MAX_ADDRESSES}`);
  if (total > MAX_ADDRESSES) throw new Error(`a lookup table holds at most ${MAX_ADDRESSES} addresses`);
  return todo;
}

async function extendInBatches(conn: Connection, kp: Keypair, table: PublicKey, todo: PublicKey[], batch: number): Promise<void> {
  const n = Math.ceil(todo.length / batch);
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const ix = AddressLookupTableProgram.extendLookupTable({
      lookupTable: table,
      authority: kp.publicKey,
      payer: kp.publicKey,
      addresses: chunk,
    });
    await simulateAndSend(conn, kp, [ix], `extend batch ${i / batch + 1}/${n} (${chunk.length} addresses)`);
  }
}

// ---------- commands ----------

async function cmdShow(conn: Connection, args: string[], opts: Opts): Promise<void> {
  const table = new PublicKey(need(args[0], "TABLE"));
  const t = await fetchTable(conn, table);
  const addrs = t.state.addresses.map((a) => a.toBase58());
  console.log(`table:        ${table.toBase58()}`);
  console.log(`authority:    ${t.state.authority ? t.state.authority.toBase58() : "(frozen)"}`);
  console.log(`addresses:    ${addrs.length} / ${MAX_ADDRESSES}`);
  console.log(`status:       ${isActive(t) ? "active" : `deactivated at slot ${t.state.deactivationSlot}`}`);
  console.log(`last extended slot: ${t.state.lastExtendedSlot}`);
  addrs.forEach((a, i) => console.log(`  ${String(i).padStart(3)}  ${a}`));
  if (opts.out) {
    const doc = {
      table: table.toBase58(),
      authority: t.state.authority ? t.state.authority.toBase58() : null,
      read_at: new Date().toISOString(),
      note: "index = position in the table; transactions reference addresses by index, the order never changes",
      count: addrs.length,
      addresses: addrs.map((address, index) => ({ index, address, label: "" })),
    };
    fs.writeFileSync(opts.out, JSON.stringify(doc, null, 2) + "\n");
    console.log(`written: ${opts.out}`);
  }
}

async function cmdCreate(conn: Connection, args: string[], opts: Opts): Promise<void> {
  const kp = loadKeypair();
  const entries = args[0] ? readAddressFile(args[0]) : [];
  console.log(`authority / payer: ${kp.publicKey.toBase58()}`);
  const todo = plan(entries, new Set());
  if (!opts.send) {
    console.log("\nDRY RUN: nothing sent. The table address depends on the slot at creation; re-run with --send.");
    return;
  }
  const recentSlot = await conn.getSlot("finalized");
  const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: kp.publicKey, payer: kp.publicKey, recentSlot });
  console.log(`creating table ${table.toBase58()} (recent slot ${recentSlot})`);
  await simulateAndSend(conn, kp, [ix], "create");
  if (todo.length) await extendInBatches(conn, kp, table, todo, opts.batch);
  await verify(conn, table, todo);
  console.log(`\ntable: ${table.toBase58()}`);
}

async function cmdExtend(conn: Connection, args: string[], opts: Opts): Promise<void> {
  const table = new PublicKey(need(args[0], "TABLE"));
  const entries = readAddressFile(need(args[1], "ADDRESS_FILE"));
  const kp = loadKeypair();
  const t = await fetchTable(conn, table);
  requireAuthority(t, kp);
  if (!isActive(t)) throw new Error("table is deactivated: it cannot be extended");
  const existing = new Set(t.state.addresses.map((a) => a.toBase58()));
  console.log(`table ${table.toBase58()}: ${existing.size} addresses, authority ${kp.publicKey.toBase58()}`);
  const todo = plan(entries, existing);
  if (!todo.length) return;
  if (!opts.send) {
    console.log("\nDRY RUN: nothing sent. Re-run with --send.");
    return;
  }
  await extendInBatches(conn, kp, table, todo, opts.batch);
  await verify(conn, table, todo);
}

async function cmdDeactivate(conn: Connection, args: string[], opts: Opts): Promise<void> {
  const table = new PublicKey(need(args[0], "TABLE"));
  const kp = loadKeypair();
  const t = await fetchTable(conn, table);
  requireAuthority(t, kp);
  if (!isActive(t)) {
    console.log(`already deactivated at slot ${t.state.deactivationSlot}`);
    return;
  }
  console.log(`table ${table.toBase58()} (${t.state.addresses.length} addresses) will be DEACTIVATED.`);
  console.log("Transactions that use it stop working once it is deactivated; this cannot be undone.");
  if (!opts.send) {
    console.log("\nDRY RUN: nothing sent. Re-run with --send.");
    return;
  }
  const ix = AddressLookupTableProgram.deactivateLookupTable({ lookupTable: table, authority: kp.publicKey });
  await simulateAndSend(conn, kp, [ix], "deactivate");
  console.log(`it can be closed after ~${DEACTIVATION_COOLDOWN_SLOTS} slots (a few minutes): alt-manager close ${table.toBase58()}`);
}

async function cmdClose(conn: Connection, args: string[], opts: Opts): Promise<void> {
  const table = new PublicKey(need(args[0], "TABLE"));
  const kp = loadKeypair();
  const t = await fetchTable(conn, table);
  requireAuthority(t, kp);
  if (isActive(t)) throw new Error("table is still active: run `deactivate` first");
  const slot = BigInt(await conn.getSlot("confirmed"));
  const ready = t.state.deactivationSlot + BigInt(DEACTIVATION_COOLDOWN_SLOTS);
  if (slot < ready) throw new Error(`still cooling down: try again in ~${ready - slot} slots`);
  const rent = await conn.getBalance(table);
  console.log(`closing ${table.toBase58()}: ${rent / 1e9} SOL rent goes back to ${kp.publicKey.toBase58()}`);
  if (!opts.send) {
    console.log("\nDRY RUN: nothing sent. Re-run with --send.");
    return;
  }
  const ix = AddressLookupTableProgram.closeLookupTable({ lookupTable: table, authority: kp.publicKey, recipient: kp.publicKey });
  await simulateAndSend(conn, kp, [ix], "close");
}

async function verify(conn: Connection, table: PublicKey, added: PublicKey[]): Promise<void> {
  const t = await fetchTable(conn, table);
  const now = new Set(t.state.addresses.map((a) => a.toBase58()));
  const missing = added.filter((p) => !now.has(p.toBase58()));
  console.log(`done: table has ${now.size} addresses; missing after extend: ${missing.length}`);
  missing.forEach((p) => console.log(`  MISSING: ${p.toBase58()}`));
}

// ---------- CLI ----------

interface Opts {
  send: boolean;
  batch: number;
  out?: string;
  rpc?: string;
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing argument ${name} (see --help)`);
  return v;
}

const HELP = `alt-manager — Solana Address Lookup Table tool

usage:
  alt-manager show       <TABLE> [--out table.json]       list the addresses (index order), optional JSON dump
  alt-manager create     [ADDRESS_FILE] [--send]          create a table (and fill it from the file)
  alt-manager extend     <TABLE> <ADDRESS_FILE> [--send]  add the addresses that are not in the table yet
  alt-manager deactivate <TABLE> [--send]                 first step to get the rent back (irreversible)
  alt-manager close      <TABLE> [--send]                 close a deactivated table, rent back to the authority

options:
  --send        actually send (default: dry run; every transaction is simulated before sending)
  --batch N     addresses per extend transaction (default 20, max 30)
  --out FILE    show: write the table as JSON
  --rpc URL     override RPC_URL

ADDRESS_FILE: JSON array of addresses or {"address","label"} objects, the JSON written by 'show --out',
or text with one address per line ('# label' optional).
environment / .env: RPC_URL, KEYPAIR_PATH or PRIVATE_KEY (see .env.example).`;

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const opts: Opts = { send: false, batch: 20 };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") opts.send = true;
    else if (a === "--batch") opts.batch = Number(need(argv[++i], "--batch N"));
    else if (a === "--out") opts.out = need(argv[++i], "--out FILE");
    else if (a === "--rpc") opts.rpc = need(argv[++i], "--rpc URL");
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  if (!Number.isInteger(opts.batch) || opts.batch < 1 || opts.batch > 30) throw new Error("--batch must be 1..30");
  const rpc = opts.rpc || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const [cmd, ...args] = pos;
  switch (cmd) {
    case "show":
      return cmdShow(conn, args, opts);
    case "create":
      return cmdCreate(conn, args, opts);
    case "extend":
      return cmdExtend(conn, args, opts);
    case "deactivate":
      return cmdDeactivate(conn, args, opts);
    case "close":
      return cmdClose(conn, args, opts);
    default:
      throw new Error(`unknown command "${cmd}" (see --help)`);
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
