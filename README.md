# alt-manager

A small command-line tool for **Solana Address Lookup Tables (ALTs)**: create a table, add addresses from a file,
list what is inside, and get the rent back when you no longer need it.

A versioned (v0) transaction can reference up to 256 addresses stored in a lookup table by a 1-byte index,
instead of the full 32-byte key. Keeping your programs, mints and fixed accounts in an ALT lets you fit more
instructions / more accounts in the 1232-byte transaction limit.

## Features
- `show`: lists the table in index order (status, authority, last extend slot); `--out` writes it as JSON, and that
  file can be edited and fed back to `extend`.
- `create`: creates a table and fills it from a file in the same run.
- `extend`: only adds what is **not already** in the table, drops duplicates, checks the 256 limit and that your key
  is the table authority, then verifies on chain that every address landed.
- `deactivate` + `close`: get the rent back. `close` checks that the cool-down after deactivation has passed.
- **Dry run by default.** Nothing is sent without `--send`. With `--send`, every transaction is **simulated first**
  and sent only if the simulation succeeds (program logs are printed if it fails).
- The key is read from a keypair file or an environment variable, never from the code.

## Install
```bash
npm install
npm run build
cp .env.example .env      # RPC_URL + KEYPAIR_PATH (or PRIVATE_KEY)
```
Node.js ≥ 18.

## Usage
```bash
node dist/alt-manager.js show <TABLE> --out my-table.json
node dist/alt-manager.js create examples/common-programs.json          # dry run
node dist/alt-manager.js create examples/common-programs.json --send   # creates + fills, prints the table address
node dist/alt-manager.js extend <TABLE> new-addresses.txt               # dry run: what would be added
node dist/alt-manager.js extend <TABLE> new-addresses.txt --send
node dist/alt-manager.js deactivate <TABLE> --send                      # irreversible
node dist/alt-manager.js close <TABLE> --send                           # ~513 slots after deactivation
```
| Option | Default | |
|---|---|---|
| `--send` | off | actually send (otherwise dry run) |
| `--batch N` | 20 | addresses per extend transaction (1–30) |
| `--out FILE` | — | `show`: write the table as JSON |
| `--rpc URL` | `RPC_URL` | RPC endpoint override |

### Address files
Any of:
- a JSON array of addresses: `["111…", "Tokenkeg…"]`
- a JSON array of objects: `[{"address": "…", "label": "SPL Token"}]` (see `examples/common-programs.json`)
- the JSON written by `show --out`
- plain text, one address per line, with an optional `# label` (see `examples/addresses.txt`)

Every address is validated before anything is sent.

### Good to know
- **The order never changes.** Transactions refer to table entries by index, so addresses can only be appended,
  never removed or reordered. To drop entries, create a new table.
- A freshly added address is usable from the **next slot**.
- Programs you call directly (top-level instructions) must be static keys in the transaction, so putting them in an
  ALT does not help those calls. Signers and the fee payer can't come from an ALT either.
- Deactivating breaks every transaction that still uses the table. Closing returns the rent (~0.0013 SOL + 0.00022 SOL
  per address) to the authority.

## Security
- Keep your key out of git: `.env`, `node_modules/`, `dist/` and keypair files are in `.gitignore`.
- `KEYPAIR_PATH` (a `solana-keygen` JSON file) is preferred over putting the secret in `PRIVATE_KEY`.

## Credits & third-party licenses
MIT-licensed (see `LICENSE`). Dependencies are installed with npm and not included in this repository; their
licenses apply to their code:

| Component | Use | License |
|---|---|---|
| [`@solana/web3.js`](https://github.com/solana-foundation/solana-web3.js) | RPC, transactions, Address Lookup Table program instructions | MIT |
| [`typescript`](https://github.com/microsoft/TypeScript) (dev) | compiler | Apache-2.0 |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) (dev) | Node.js type definitions | MIT |

Uses any Solana JSON-RPC endpoint you configure; respect its terms and rate limits.
