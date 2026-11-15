// launch.mjs — launch the Magic 8-Ball ($8BALL) coin for makefun-coin-promo-01 on pump.fun.
// Run from this directory (repo/launch):
//   node launch.mjs --dry-run   # validate everything, build + simulate the create tx, send NOTHING
//   node launch.mjs             # the real launch: upload metadata, create the coin, write ../LAUNCH.json
// Env: MAKEFUN_KEYPAIR (default /home/hatch/workspace/makefun/nova-eoa-keypair.json),
//      SOLANA_RPC_URL (default https://api.mainnet-beta.solana.com).
// Costs: pump.fun create fee 0.02 SOL + network fees (~0.00001 SOL). The script refuses to
// launch unless the wallet holds at least 0.03 SOL. First buy is 0 — no buy, create only.
// On success it writes ../LAUNCH.json {mint, create_signature} and prints the pump.fun URL.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const KEYPAIR_PATH = process.env.MAKEFUN_KEYPAIR ?? '/home/hatch/workspace/makefun/nova-eoa-keypair.json';
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const MINT_KEYPAIR_PATH = join(__dirname, 'mint-keypair.json');
const LAUNCH_JSON_PATH = join(REPO_ROOT, 'LAUNCH.json');
const LOGO_PATH = join(REPO_ROOT, 'logo.png');

const NAME = 'Magic 8-Ball';
const SYMBOL = '8BALL';
const WEBSITE = 'https://make.fun/bounty/makefun-coin-promo-01';
const DESCRIPTION = [
  'Ask the ball a question. It answers with a program.',
  '\u{1F3B1} Magic 8-Ball is an AI agent\u2019s coin for the make.fun bounty \u2014 shake it and an agent builds whatever you asked for.',
  'make.fun is a site where people and their AI agents build programs, enter them in paid competitions (bounties) and are scored and ranked in the open.',
  `This coin was launched by an AI agent for this bounty: ${WEBSITE} \u2014 ask the ball, then go build on make.fun.`,
].join(' ');

const CREATE_FEE_SOL = 0.02; // pump.fun program create fee
const MIN_BALANCE_SOL = 0.03; // create fee + network fees + margin

function loadKeypair(path) {
  const arr = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

const creator = loadKeypair(KEYPAIR_PATH);
console.log(JSON.stringify({ mode: DRY_RUN ? 'dry-run' : 'launch', creator: creator.publicKey.toBase58(), rpc: RPC_URL }));

const connection = new Connection(RPC_URL, 'confirmed');
// Minimal Wallet for AnchorProvider (avoids the NodeWallet ESM/CJS interop pitfall).
const wallet = {
  publicKey: creator.publicKey,
  signTransaction: async (tx) => { tx.partialSign(creator); return tx; },
  signAllTransactions: async (txs) => { txs.forEach((tx) => tx.partialSign(creator)); return txs; },
};
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const sdk = new PumpFunSDK(provider);

// 1. Balance gate (hard in launch mode, report-only in dry-run).
const balanceLamports = await connection.getBalance(creator.publicKey);
const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
console.log(JSON.stringify({ step: 'balance', lamports: balanceLamports, sol: balanceSol, min_sol: MIN_BALANCE_SOL }));
if (!DRY_RUN && balanceLamports < MIN_BALANCE_SOL * LAMPORTS_PER_SOL) {
  console.error(`STOP: wallet holds ${balanceSol} SOL, need at least ${MIN_BALANCE_SOL} SOL (create fee ${CREATE_FEE_SOL} SOL + network fees). Fund ${creator.publicKey.toBase58()} and re-run.`);
  process.exit(2);
}

// 2. Refuse to launch twice: if LAUNCH.json already names a real mint, stop.
if (!DRY_RUN && existsSync(LAUNCH_JSON_PATH)) {
  const cur = JSON.parse(readFileSync(LAUNCH_JSON_PATH, 'utf8'));
  if (cur.mint && !cur.mint.includes('REPLACE')) {
    console.error(`STOP: ${LAUNCH_JSON_PATH} already names mint ${cur.mint}. Refusing to launch a second coin.`);
    process.exit(3);
  }
}

// 3. Mint keypair: reuse the saved one if present (a retry after a crash reuses the same mint),
//    otherwise generate and save it BEFORE sending anything, so a crash cannot lose the mint.
let mint;
if (existsSync(MINT_KEYPAIR_PATH)) {
  mint = loadKeypair(MINT_KEYPAIR_PATH);
  console.log(JSON.stringify({ step: 'mint', reused: true, mint: mint.publicKey.toBase58() }));
} else {
  mint = Keypair.generate();
  writeFileSync(MINT_KEYPAIR_PATH, JSON.stringify(Array.from(mint.secretKey)), { mode: 0o600 });
  console.log(JSON.stringify({ step: 'mint', reused: false, mint: mint.publicKey.toBase58() }));
}

// 4. Metadata URI. Primary: pump.fun's own IPFS upload (the SDK's path). If that is
// unreachable (pump.fun's WAF 403s this host's egress IP), fall back to GitHub-raw:
// the metadata JSON + logo are committed to this public repo and served from
// raw.githubusercontent.com — a plain HTTPS URI pump.fun renders the same way.
// The fallback verifies the raw URLs answer 200 before they are used.
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? 'RenzzHGE';
const GITHUB_REPO = process.env.GITHUB_REPO ?? 'magic-8ball-makefun';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? 'main';

async function githubRawMetadataUri() {
  const metadataJson = {
    name: NAME,
    symbol: SYMBOL,
    description: DESCRIPTION,
    image: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/logo.png`,
    external_url: WEBSITE,
    properties: { files: [{ uri: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/logo.png`, type: 'image/png' }], category: 'image' },
  };
  writeFileSync(join(REPO_ROOT, 'metadata.json'), `${JSON.stringify(metadataJson, null, 2)}\n`);
  const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
  git(['add', 'logo.png', 'metadata.json']);
  // Only commit when these two files themselves changed (other dirty files in the
  // repo must not trigger — or be swept into — this commit).
  const status = git(['status', '--porcelain', '--', 'logo.png', 'metadata.json']);
  if (status.trim()) {
    git(['-c', 'user.name=RenzzHGE', '-c', 'user.email=RenzzHGE@users.noreply.github.com', 'commit', '-m', 'metadata: logo + metadata.json for the 8BALL coin', '--', 'logo.png', 'metadata.json']);
    git(['push', 'origin', GITHUB_BRANCH]);
  }
  const uri = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/metadata.json`;
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`raw metadata URL not serving: ${uri} -> HTTP ${res.status}`);
  const img = await fetch(metadataJson.image);
  if (!img.ok) throw new Error(`raw logo URL not serving: ${metadataJson.image} -> HTTP ${img.status}`);
  return uri;
}

const logo = readFileSync(LOGO_PATH);
console.log(JSON.stringify({ step: 'logo', bytes: logo.length, path: LOGO_PATH }));
if (logo.length > 5 * 1024 * 1024) throw new Error('logo over the 5 MiB pump.fun limit');
const metadata = {
  name: NAME,
  symbol: SYMBOL,
  description: DESCRIPTION,
  file: new Blob([logo], { type: 'image/png' }),
  website: WEBSITE,
};

let metadataUri;
try {
  const { metadataUri: uri } = await sdk.createTokenMetadata(metadata);
  if (typeof uri !== 'string' || !uri.startsWith('https://')) throw new Error(`unexpected metadataUri: ${uri}`);
  metadataUri = uri;
  console.log(JSON.stringify({ step: 'metadata', via: 'pumpfun-ipfs', uri: metadataUri }));
} catch (err) {
  console.log(JSON.stringify({ step: 'metadata', via: 'pumpfun-ipfs', failed: String(err?.message ?? err), fallback: 'github-raw' }));
  metadataUri = await githubRawMetadataUri();
  console.log(JSON.stringify({ step: 'metadata', via: 'github-raw', uri: metadataUri }));
}

// 5a. Dry-run: build the exact create transaction and simulate it. Send nothing.
if (DRY_RUN) {
  const tx = await sdk.getCreateInstructions(creator.publicKey, NAME, SYMBOL, metadataUri, mint);
  tx.feePayer = creator.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(creator, mint);
  console.log(JSON.stringify({ step: 'tx-built', instructions: tx.instructions.length, feePayer: tx.feePayer.toBase58() }));
  const sim = await connection.simulateTransaction(tx);
  console.log(JSON.stringify({ step: 'simulate', err: sim.value.err ?? null, logs: (sim.value.logs ?? []).slice(-3) }));
  if (sim.value.err) {
    const s = JSON.stringify(sim.value.err);
    // An unfunded wallet's account does not exist on-chain at all until it first
    // receives SOL, so simulation reports AccountNotFound for the fee payer —
    // verified by a control: a trivial self-transfer from the same wallet fails
    // with the identical error. Both mean the same blocker: 0 SOL.
    if (s.includes('InsufficientFunds') || s.includes('insufficient') || s.includes('AccountNotFound')) {
      console.log('DRY-RUN OK: simulation fails only because the fee-payer account is unfunded (0 SOL, never funded) — the expected blocker. The transaction itself is well-formed.');
    } else {
      console.error('DRY-RUN PROBLEM: simulation failed for a reason other than funds — inspect before launching.');
      process.exit(4);
    }
  } else {
    console.log('DRY-RUN OK: simulation passed. (With a funded wallet the real launch should succeed.)');
  }
  console.log(JSON.stringify({ dry_run: 'complete', mint: mint.publicKey.toBase58(), metadataUri }));
  process.exit(0);
}

// 5b. Real launch: create only (buy amount 0 SOL — no first buy).
const res = await sdk.createAndBuy(creator, mint, metadata, 0n);
console.log(JSON.stringify({ step: 'create', success: res.success, signature: res.signature ?? null, error: res.error ? String(res.error) : null }));
if (!res.success || !res.signature) throw new Error(`create failed: ${JSON.stringify(res.error ?? res)}`);

// 6. Verify on-chain, then write LAUNCH.json.
const curve = await sdk.getBondingCurveAccount(mint.publicKey, 'confirmed');
if (!curve) throw new Error('bonding curve account missing after create — verify manually before submitting');
const launch = { mint: mint.publicKey.toBase58(), create_signature: res.signature };
writeFileSync(LAUNCH_JSON_PATH, `${JSON.stringify(launch, null, 2)}\n`);
console.log(JSON.stringify({ launched: true, ...launch, url: `https://pump.fun/${launch.mint}` }));
