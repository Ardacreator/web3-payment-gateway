/* =========================================================================
 * app.js — Ethers.js v6 connection engine for the Web3 Payment Gateway
 *
 * Responsibilities:
 *   - Connect an injected wallet (MetaMask / Trust Wallet).
 *   - Let the user pick an asset (USDC / ETH / WBTC) and update the amount.
 *   - Trigger payWithNative() or payWithToken() on the deployed contract.
 *   - Stream every step (TXID, settlement) into the on-screen log.
 *
 * NOTE: Fill in the CONFIG block below with your real deployed values.
 * ========================================================================= */

"use strict";

/* -------------------------------------------------------------------------
 * CONFIG — edit these after you deploy the contract
 * ------------------------------------------------------------------------- */
const CONFIG = {
  // Your deployed PaymentGateway address:
  gatewayAddress: "0xb35f439837a65da290b80fe6a08b23ea1d408a49",

  // The merchant (seller) who receives 99%. For a demo this can be you.
  merchantAddress: "0xYOUR_MERCHANT_ADDRESS",

  // The chain you deployed to. Example: Arbitrum One = 42161, Polygon = 137.
  chainIdDecimal: 42161,
  chainName: "Arbitrum One",

  // Off-chain order reference (would normally be generated per order).
  orderId: "ORDER-PRO-0001",

  // Token contracts on the SAME chain as your gateway.
  // These examples are Arbitrum One mainnet addresses — verify before use.
  tokens: {
    USDC: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC (Arbitrum)
      decimals: 6,
      // Display price of the product in this asset:
      price: "100",
    },
    WBTC: {
      address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC (Arbitrum)
      decimals: 8,
      price: "0.0015",
    },
  },

  // Native asset display price (ETH on Arbitrum):
  native: {
    symbol: "ETH",
    decimals: 18,
    price: "0.03",
  },
};

/* -------------------------------------------------------------------------
 * Minimal ABIs
 * ------------------------------------------------------------------------- */
const GATEWAY_ABI = [
  "function payWithNative(address merchant, string orderId) external payable",
  "function payWithToken(address token, address merchant, uint256 amount, string orderId) external",
  "function commissionRate() view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/* -------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */
let provider = null;
let signer = null;
let userAddress = null;
let selectedAsset = "USDC"; // "USDC" | "ETH" | "BTC"

/* -------------------------------------------------------------------------
 * DOM helpers
 * ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const logBox = $("log");

function log(message, type = "info") {
  const colors = {
    info: "text-neutral-400",
    ok: "text-emerald-400",
    warn: "text-amber-400",
    err: "text-rose-400",
    tx: "text-indigo-400",
  };
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = `log-line ${colors[type] || colors.info}`;
  line.textContent = `[${time}] ${message}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function short(addr) {
  return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "";
}

/* -------------------------------------------------------------------------
 * Asset selection + amount display
 * ------------------------------------------------------------------------- */
function assetToConfig(asset) {
  // "BTC" is settled as WBTC under the hood.
  if (asset === "USDC") {
    return { kind: "token", symbol: "USDC", ...CONFIG.tokens.USDC };
  }
  if (asset === "BTC") {
    return { kind: "token", symbol: "BTC", ...CONFIG.tokens.WBTC };
  }
  // ETH (native)
  return {
    kind: "native",
    symbol: CONFIG.native.symbol,
    decimals: CONFIG.native.decimals,
    price: CONFIG.native.price,
  };
}

function updateAmountDisplay() {
  const cfg = assetToConfig(selectedAsset);
  $("amount-display").firstChild.textContent = cfg.price + " ";
  $("amount-symbol").textContent = cfg.symbol;
  $("btc-note").classList.toggle("hidden", selectedAsset !== "BTC");
}

function selectAsset(asset) {
  selectedAsset = asset;
  document.querySelectorAll(".asset-btn").forEach((btn) => {
    const active = btn.dataset.asset === asset;
    btn.classList.toggle("border-indigo-500", active);
    btn.classList.toggle("bg-indigo-500/10", active);
    btn.classList.toggle("text-neutral-400", !active);
    btn.classList.toggle("border-neutral-800", !active);
  });
  updateAmountDisplay();
  log(`Asset selected: ${asset}`);
}

/* -------------------------------------------------------------------------
 * Wallet connection
 * ------------------------------------------------------------------------- */
async function connectWallet() {
  if (typeof window.ethereum === "undefined") {
    log("No injected wallet found. Install MetaMask or Trust Wallet.", "err");
    return;
  }

  try {
    log("Requesting wallet connection…");
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();

    log(`Wallet connected: ${short(userAddress)}`, "ok");

    await ensureCorrectNetwork();

    $("network-badge").textContent = `${CONFIG.chainName} · ${short(userAddress)}`;
    $("network-badge").className =
      "text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400";
    $("pay-btn").disabled = false;
    $("connect-btn").textContent = "Wallet Connected";
  } catch (err) {
    log(`Connection failed: ${err.message || err}`, "err");
  }
}

async function ensureCorrectNetwork() {
  const net = await provider.getNetwork();
  const current = Number(net.chainId);
  if (current === CONFIG.chainIdDecimal) return;

  log(`Wrong network (${current}). Switching to ${CONFIG.chainName}…`, "warn");
  const hexChainId = "0x" + CONFIG.chainIdDecimal.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
    // Re-init provider/signer after the switch.
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    log(`Switched to ${CONFIG.chainName}.`, "ok");
  } catch (switchErr) {
    log(`Please switch to ${CONFIG.chainName} manually.`, "err");
    throw switchErr;
  }
}

/* -------------------------------------------------------------------------
 * Payment flow
 * ------------------------------------------------------------------------- */
async function pay() {
  if (!signer) {
    log("Connect a wallet first.", "warn");
    return;
  }

  $("pay-btn").disabled = true;
  const cfg = assetToConfig(selectedAsset);

  try {
    const gateway = new ethers.Contract(CONFIG.gatewayAddress, GATEWAY_ABI, signer);

    if (cfg.kind === "native") {
      await payNative(gateway, cfg);
    } else {
      await payToken(gateway, cfg);
    }
  } catch (err) {
    const reason = err?.info?.error?.message || err?.shortMessage || err?.message || String(err);
    log(`Payment failed: ${reason}`, "err");
  } finally {
    $("pay-btn").disabled = false;
  }
}

async function payNative(gateway, cfg) {
  const value = ethers.parseUnits(cfg.price, cfg.decimals);
  log(`Preparing native payment of ${cfg.price} ${cfg.symbol}…`);

  const tx = await gateway.payWithNative(CONFIG.merchantAddress, CONFIG.orderId, {
    value,
  });
  log(`TX submitted: ${short(tx.hash)}`, "tx");
  log(`Awaiting confirmation…`);

  const receipt = await tx.wait();
  log(`Block ${receipt.blockNumber} · Settlement Complete ✔`, "ok");
  log(`99% → merchant, 1% → platform (atomic).`, "ok");
}

async function payToken(gateway, cfg) {
  const token = new ethers.Contract(cfg.address, ERC20_ABI, signer);
  const amount = ethers.parseUnits(cfg.price, cfg.decimals);

  // Balance check
  const balance = await token.balanceOf(userAddress);
  if (balance < amount) {
    log(`Insufficient ${cfg.symbol} balance.`, "err");
    return;
  }

  // Approve if needed
  const allowance = await token.allowance(userAddress, CONFIG.gatewayAddress);
  if (allowance < amount) {
    log(`Approving ${cfg.price} ${cfg.symbol} for the gateway…`);
    const approveTx = await token.approve(CONFIG.gatewayAddress, amount);
    log(`Approval TX: ${short(approveTx.hash)}`, "tx");
    await approveTx.wait();
    log(`Approval confirmed.`, "ok");
  } else {
    log(`Existing allowance sufficient, skipping approval.`);
  }

  // Pay
  log(`Executing payWithToken for ${cfg.price} ${cfg.symbol}…`);
  const tx = await gateway.payWithToken(
    cfg.address,
    CONFIG.merchantAddress,
    amount,
    CONFIG.orderId
  );
  log(`TX submitted: ${short(tx.hash)}`, "tx");
  log(`Awaiting confirmation…`);

  const receipt = await tx.wait();
  log(`Block ${receipt.blockNumber} · Settlement Complete ✔`, "ok");
  log(`99% → merchant, 1% → platform (atomic).`, "ok");
}

/* -------------------------------------------------------------------------
 * Wallet event listeners
 * ------------------------------------------------------------------------- */
function wireWalletEvents() {
  if (typeof window.ethereum === "undefined") return;

  window.ethereum.on("accountsChanged", (accounts) => {
    if (!accounts.length) {
      log("Wallet disconnected.", "warn");
      location.reload();
    } else {
      log(`Account changed: ${short(accounts[0])}`, "warn");
      location.reload();
    }
  });

  window.ethereum.on("chainChanged", () => {
    log("Network changed. Reloading…", "warn");
    location.reload();
  });
}

/* -------------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------------- */
function init() {
  document.querySelectorAll(".asset-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectAsset(btn.dataset.asset));
  });
  $("connect-btn").addEventListener("click", connectWallet);
  $("pay-btn").addEventListener("click", pay);

  wireWalletEvents();
  updateAmountDisplay();

  log("Gateway ready. Connect a wallet to begin.", "ok");
}

document.addEventListener("DOMContentLoaded", init);
