import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';

import { IToken } from '../models/tokenModel';
import { gasService } from './web3/gasService';
import { wrapRpc } from './web3/rpc/rpcService';
import { Logger } from '../helpers/loggerHelper';
import { SIGNING_KEY } from '../config/constants';
import { IBlockchain } from '../models/blockchainModel';
import { generateWalletSeed } from '../helpers/SecurityHelper';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { getChatterPayWalletFactoryABI } from './web3/abiService';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts';
import {
  MintResult,
  rpcProviders,
  ComputedAddress,
  PhoneNumberToAddress
} from '../types/commonType';

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
  const privateKey = generateWalletSeed(getPhoneNumberFormatted(phoneNumber), chainId);
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
  try {
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
      await wrapRpc(async () => {
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

        let gasPrice: ethers.BigNumber;

        try {
          gasPrice = await provider.getGasPrice();
        } catch (error) {
          // Default to 5 Gwei if the call fails
          Logger.warn(
            'computeProxyAddressFromPhone',
            'Fallback gas price used due to getGasPrice() failure:',
            error
          );
          gasPrice = ethers.utils.parseUnits('5', 'gwei');
        }

        const tx = await factory.createProxy(ownerAddress.publicKey, {
          gasLimit,
          gasPrice
        });
        Logger.log('computeProxyAddressFromPhone', `tx: ${tx.hash}`);

        return tx.wait().then(() => true);
      }, rpcProviders.ALCHEMY);
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
  } catch (error) {
    Logger.error('computeProxyAddressFromPhone', error);
    throw error;
  }
}

/**
 * Issues a specified amount of tokens to a given address, using the RPC queue for rate limiting.
 *
 * @param recipientAddress - The address to receive the minted tokens.
 * @param tokens - The list of IToken to mint.
 * @param networkConfig - The blockchain network configuration.
 * @returns A promise that resolves to an array of MintResult objects.
 * @throws Will throw if no tokens are found for the specified chain.
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

  // Filter tokens for the current chain
  const chainTokens = tokens.filter((token) => token.chain_id === networkConfig.chainId);
  const tokenAddresses: string[] = chainTokens.map((token) => token.address);

  if (tokenAddresses.length === 0) {
    throw new Error(`No tokens found for chain ${networkConfig.chainId}`);
  }

  // Fetch nonce using rate-limited queue
  const currentNonce = (await wrapRpc(
    () => provider.getTransactionCount(signer.address),
    rpcProviders.ALCHEMY
  )) as number;

  Logger.log('issueTokensCore', `Current Nonce: ${currentNonce}`);
  Logger.log(
    'issueTokensCore',
    `Minting tokens on chain ${networkConfig.chainId} for wallet ${recipientAddress}`,
    tokenAddresses
  );

  // Wrap each mint in the Alchemy RPC queue
  const mintPromises: Promise<MintResult>[] = tokenAddresses.map(
    (tokenAddress, index): Promise<MintResult> =>
      wrapRpc<MintResult>(
        () => mintToken(signer, tokenAddress, recipientAddress, amount, currentNonce + index),
        rpcProviders.ALCHEMY
      ) as Promise<MintResult>
  );
  const mintResults = await Promise.all(mintPromises);

  return mintResults;
}

/**
 * Safely issues tokens and returns a boolean indicating success or failure.
 *
 * @param recipientAddress - The address to receive the tokens.
 * @param tokens - The list of tokens.
 * @param networkConfig - The blockchain network configuration.
 * @returns Promise<boolean> - true if tokens were issued successfully, false otherwise.
 */
export async function tryIssueTokens(
  recipientAddress: string,
  tokens: IToken[],
  networkConfig: IBlockchain
): Promise<boolean> {
  try {
    await issueTokens(recipientAddress, tokens, networkConfig);
    return true;
  } catch (error) {
    Logger.error('tryIssueTokens', `Failed to issue tokens to ${recipientAddress}`, error);
    return false;
  }
}
