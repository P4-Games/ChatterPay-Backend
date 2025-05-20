import crypto from 'crypto';
import { ethers } from 'ethers';

import { Logger } from '../src/helpers/loggerHelper';
import { PhoneNumberToAddress } from '../src/types/commonType';

function getPhoneNumberFormatted(phone: string): string {
  return phone.replace(/\D/g, '');
}

function generatePrivateKey(
  phoneNumber: string,
  chanId: string,
  environment: string,
  privateKey: string
): PhoneNumberToAddress {
  if (!privateKey) {
    throw new Error('Seed private key not found in the provided input');
  }
  const seed = `${privateKey}${chanId}${environment}${getPhoneNumberFormatted(phoneNumber)}`;
  const privateKeyWallet = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;

  const wallet = new ethers.Wallet(privateKeyWallet);
  const publicKey = wallet.address;
  const hashedPrivateKey = crypto.createHash('sha256').update(privateKey).digest('hex');

  return {
    hashedPrivateKey,
    privateKey: privateKeyWallet,
    publicKey
  };
}

// Main function to be called from CLI
function main() {
  const args = process.argv.slice(2);

  if (args.length !== 4) {
    console.error('Usage: <phoneNumber> <chainId> <environment> <privateKey>');
    process.exit(1);
  }

  const [phoneNumber, chainId, environment, privateKey] = args;

  const wallet = generatePrivateKey(phoneNumber, chainId, environment, privateKey);
  Logger.log(`Generated wallet: ${JSON.stringify(wallet)}`);
}

main();
