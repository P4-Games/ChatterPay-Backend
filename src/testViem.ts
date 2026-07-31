import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
const account = privateKeyToAccount(privateKey as `0x${string}`);

const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http('https://polygon-rpc.com')
});

console.log('Transport keys:', Object.keys(walletClient.transport));
console.log('Transport type:', walletClient.transport.type);
// @ts-expect-error
console.log('Transport config:', walletClient.transport.config);
