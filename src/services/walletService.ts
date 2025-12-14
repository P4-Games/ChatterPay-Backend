import { ethers } from 'ethers';
import { Logger } from '../helpers/loggerHelper';
import type { IBlockchain } from '../models/blockchainModel';
import type { IToken } from '../models/tokenModel';
import { type MintResult, rpcProviders } from '../types/commonType';
import { mongoUserService } from './mongo/mongoUserService';
import { secService } from './secService';
import { addWalletToUser, createUserWithWallet, getUserWalletByChainId } from './userService';
import { wrapRpc } from './web3/rpc/rpcService';

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

  const provider: ethers.providers.JsonRpcProvider = new ethers.providers.JsonRpcProvider(
    networkConfig.rpc
  );
  const bs = secService.get_bs(provider);

  // Filter tokens for the current chain
  const chainTokens = tokens.filter((token) => token.chain_id === networkConfig.chainId);
  const tokenAddresses: string[] = chainTokens.map((token) => token.address);

  if (tokenAddresses.length === 0) {
    throw new Error(`No tokens found for chain ${networkConfig.chainId}`);
  }

  // Fetch nonce using rate-limited queue
  const currentNonce = (await wrapRpc(
    {
      fn: () => provider.getTransactionCount(bs.address),
      name: 'getTransactionCount',
      args: [bs.address]
    },
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
        {
          fn: () => mintToken(bs, tokenAddress, recipientAddress, amount, currentNonce + index),
          name: 'mintToken',
          args: [
            bs.address,
            tokenAddress,
            recipientAddress,
            amount.toString(),
            currentNonce + index
          ]
        },
        rpcProviders.ALCHEMY
      ).then((res) => res as MintResult)
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

export async function createOrReturnWallet(
  channelUserId: string,
  networkConfig: IBlockchain,
  logKey: string
): Promise<{
  message: string;
  walletAddress: string;
  wasWalletCreated: boolean;
}> {
  const { chainId } = networkConfig;
  const chatterpayProxyAddress = networkConfig.contracts.chatterPayAddress;
  const { factoryAddress } = networkConfig.contracts;

  const NETWORK_WARNING = `

⚠️ Important: If you plan to send crypto to this wallet from an external platform (like a wallet or exchange), make sure to use the *${networkConfig.name} network* and double-check the address.
ChatterPay can’t reverse transactions made outside of our app, such as when the wrong network is selected or the wallet address is mistyped.`;

  const existingUser = await mongoUserService.getUser(channelUserId);

  if (existingUser) {
    const existingWallet = getUserWalletByChainId(existingUser.wallets, chainId);
    if (existingWallet) {
      return {
        message: `The user already exists, your wallet is ${existingWallet.wallet_proxy}. ${NETWORK_WARNING}`,
        walletAddress: existingWallet.wallet_proxy,
        wasWalletCreated: false
      };
    }

    Logger.log('createOrReturnWallet', logKey, `Creating new wallet for existing user`);

    const result = await addWalletToUser(
      channelUserId,
      chainId,
      chatterpayProxyAddress,
      factoryAddress
    );

    if (!result) {
      Logger.error(
        'createOrReturnWallet',
        logKey,
        `Error creating wallet for user '${channelUserId}' and chain ${chainId}`
      );
      throw new Error(`Error creating wallet for user '${channelUserId}' and chain ${chainId}`);
    }

    return {
      message: `The wallet was created successfully!. ${NETWORK_WARNING}`,
      walletAddress: result.newWallet.wallet_proxy,
      wasWalletCreated: true
    };
  }

  Logger.log('createOrReturnWallet', logKey, `Creating user and wallet from scratch`);

  const newUser = await createUserWithWallet(channelUserId, chatterpayProxyAddress, factoryAddress);

  const wallet = newUser.wallets[0];

  return {
    message: `The wallet was created successfully!. ${NETWORK_WARNING}`,
    walletAddress: wallet.wallet_proxy,
    wasWalletCreated: true
  };
}
