import PQueue from 'p-queue';
import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';

import { IToken } from '../models/tokenModel';
import { gasService } from './web3/gasService';
import { Logger } from '../helpers/loggerHelper';
import { IBlockchain } from '../models/blockchainModel';
import { generatePrivateKey } from '../helpers/SecurityHelper';
import { getChatterPayWalletFactoryABI } from './web3/abiService';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts';
import { SIGNING_KEY, QUEUE_CREATE_PROXY_INTERVAL } from '../config/constants';
import { MintResult, ComputedAddress, PhoneNumberToAddress } from '../types/commonType';

// 1 request each x seg
const queueCreateProxy = new PQueue({ interval: QUEUE_CREATE_PROXY_INTERVAL, intervalCap: 1 });

/**
 * Generates a deterministic Ethereum address based on a phone number and a chain ID.
 *
 * This function derives an Ethereum address by combining the phone number and chain ID
 * with the environment-defined seed private key. The result includes the hashed private key,
 * the private key, and the public key (Ethereum address).
 *
 * @param {string} phoneNumber - The phone number to generate the address from.
 * @param {string} chainId - The chain ID to include in the address generation.
 * @returns {PhoneNumberToAddress} An object containing:
 *   - `hashedPrivateKey`: A SHA-256 hash of the generated private key.
 *   - `privateKey`: The deterministic private key.
 *   - `publicKey`: The Ethereum address corresponding to the private key.
 *
 * @throws {Error} If the seed private key is not found in environment variables.
 */
function phoneNumberToAddress(phoneNumber: string, chainId: string): PhoneNumberToAddress {
  const privateKey = generatePrivateKey(getPhoneNumberFormatted(phoneNumber), chainId);
  const wallet = new ethers.Wallet(privateKey);
  const publicKey = wallet.address;
  const hashedPrivateKey = crypto.createHash('sha256').update(privateKey).digest('hex');

  return {
    hashedPrivateKey,
    privateKey,
    publicKey
  };
}

/**
 * Mints a specified amount of tokens for a given address.
 *
 * @param signer - The ethers.Wallet instance used to sign the transaction.
 * @param tokenAddress - The address of the token contract.
 * @param recipientAddress - The address to receive the minted tokens.
 * @param amount - The amount of tokens to mint (as a string).
 * @param nonce - The nonce to use for the transaction.
 * @returns A promise that resolves to a MintResult object.
 */
async function mintToken(
  signer: ethers.Wallet,
  tokenAddress: string,
  recipientAddress: string,
  amount: string,
  nonce: number
): Promise<MintResult> {
  const erc20Contract: ethers.Contract = new ethers.Contract(
    tokenAddress,
    ['function mint(address to, uint256 amount)', 'function decimals() view returns (uint8)'],
    signer
  );

  const decimals = await erc20Contract.decimals();
  const amountBN: ethers.BigNumber = ethers.utils.parseUnits(amount, decimals);
  const gasLimit: number = 5000000; // Set a reasonable gas limit.

  const gasPrice: ethers.BigNumber = await signer.provider!.getGasPrice();
  const adjustedGasPrice: ethers.BigNumber = gasPrice.mul(120).div(100);

  const tx: ethers.ContractTransaction = await erc20Contract.mint(recipientAddress, amountBN, {
    gasLimit,
    nonce,
    gasPrice: adjustedGasPrice
  });

  return {
    tokenAddress,
    txHash: tx.hash
  };
}

/**
 * Computes the proxy address for a given phone number.
 *
 * @param {string} phoneNumber - The phone number to compute the proxy address for.
 * @returns {Promise<ComputedAddress>} A promise that resolves to an object containing the proxy address, EOA address, and private key.
 * @throws {Error} If there's an error in the computation process.
 */
export async function computeProxyAddressFromPhone(phoneNumber: string): Promise<ComputedAddress> {
  const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc, {
    name: networkConfig.name,
    chainId: networkConfig.chainId
  });

  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const chatterpayWalletFactoryABI = await getChatterPayWalletFactoryABI();
  const factory = ChatterPayWalletFactory__factory.connect(
    networkConfig.contracts.factoryAddress,
    chatterpayWalletFactoryABI,
    backendSigner
  );

  const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(
    phoneNumber,
    networkConfig.chainId.toString()
  );

  const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, {
    gasLimit: 1000000
  });
  Logger.log('computeProxyAddressFromPhone', `Computed proxy address: ${proxyAddress}`);

  const code = await provider.getCode(proxyAddress);
  if (code === '0x') {
    await queueCreateProxy.add(async () => {
      Logger.log(
        'computeProxyAddressFromPhone',
        `Creating new wallet for EOA: ${ownerAddress.publicKey}, will result in: ${proxyAddress}.`
      );
      const gasLimit = await gasService.getDynamicGas(
        factory,
        'createProxy',
        [ownerAddress.publicKey],
        20,
        BigNumber.from('700000')
      );

      const gasPrice = await provider.getGasPrice();

      const tx = await factory.createProxy(ownerAddress.publicKey, {
        gasLimit,
        gasPrice
      });

      await tx.wait();
    });
  }

  Logger.log(
    'computeProxyAddressFromPhone',
    JSON.stringify({
      proxyAddress,
      EOAAddress: ownerAddress.publicKey
    })
  );

  return {
    proxyAddress,
    EOAAddress: ownerAddress.publicKey,
    privateKey: ownerAddress.hashedPrivateKey,
    privateKeyNotHashed: ownerAddress.privateKey
  };
}

/**
 * Issues a specified amount of tokens to a given address, using the queue for rate limiting.
 *
 * @param recipientAddress - The address to receive the minted tokens.
 * @param fastify - The Fastify instance containing network configuration and tokens.
 * @returns A promise that resolves to an array of MintResult objects.
 */
export async function issueTokens(
  recipientAddress: string,
  tokens: IToken[],
  networkConfig: IBlockchain
): Promise<MintResult[]> {
  const amount: string = '10000';

  // Create provider using network config from decorator.
  const provider: ethers.providers.JsonRpcProvider = new ethers.providers.JsonRpcProvider(
    networkConfig.rpc
  );
  const signer: ethers.Wallet = new ethers.Wallet(SIGNING_KEY!, provider);

  // Get tokens for the current chain from the decorator.
  const chainTokens = tokens.filter((token) => token.chain_id === networkConfig.chainId);
  const tokenAddresses: string[] = chainTokens.map((token) => token.address);

  if (tokenAddresses.length === 0) {
    throw new Error(`No tokens found for chain ${networkConfig.chainId}`);
  }

  // Get the current nonce for the signer.
  const currentNonce: number = await provider.getTransactionCount(signer.address);
  Logger.log('issueTokensCore', `Current Nonce: ${currentNonce}`);
  Logger.log(
    'issueTokensCore',
    `Minting tokens on chain ${networkConfig.chainId} for wallet ${recipientAddress} and tokens:`,
    tokenAddresses
  );

  const mintPromises: Promise<MintResult>[] = tokenAddresses.map((tokenAddress, index) =>
    mintToken(signer, tokenAddress, recipientAddress, amount, currentNonce + index)
  );

  const mintResults = await Promise.all(mintPromises);

  return mintResults;
}
