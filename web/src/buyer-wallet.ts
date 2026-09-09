export interface BuyerWalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
function wallet(): BuyerWalletProvider {
  const provider = (window as Window & { ethereum?: BuyerWalletProvider }).ethereum;
  if (!provider?.request) throw new Error("Open this page in a browser with an EVM wallet extension to connect your existing wallet.");
  return provider;
}
export async function buyerWalletAccount(connect = false): Promise<string> {
  const provider = wallet();
  const accounts = await provider.request({ method: connect ? "eth_requestAccounts" : "eth_accounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0]) || /^0x0{40}$/i.test(accounts[0])) throw new Error("Connect the wallet you want to use for this assessment.");
  if (await provider.request({ method: "eth_chainId" }) !== "0x38") throw new Error("Select BNB Smart Chain mainnet (chain 56) in your wallet, then connect again.");
  return accounts[0];
}
export async function sendBuyerWalletStep(account: string, step: { to: string; data: string; value: string; nonce: number; gas: string; gasPrice: string }, expiresAt: string): Promise<string> {
  try {
    const current = await buyerWalletAccount();
    if (current.toLowerCase() !== account.toLowerCase()) throw new Error("The selected wallet changed. Reconnect the wallet used for this recommendation.");
    if (Date.now() >= Date.parse(expiresAt)) throw new Error("The review window expired before signing. Refresh the assessment or withdrawal quote.");
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("Wallet verification failed before signing."), { notBroadcast: true });
  }
  const hash = await wallet().request({ method: "eth_sendTransaction", params: [{ from: account, to: step.to, data: step.data,
    value: "0x0", chainId: "0x38", nonce: `0x${step.nonce.toString(16)}`, gas: `0x${BigInt(step.gas).toString(16)}`, gasPrice: `0x${BigInt(step.gasPrice).toString(16)}` }] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The wallet did not return a transaction hash. Check wallet activity before trying any action again.");
  return hash;
}
