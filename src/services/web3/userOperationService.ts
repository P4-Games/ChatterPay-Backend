import axios, { AxiosResponse } from 'axios';
import { ethers, BigNumber, TypedDataField, TypedDataDomain } from 'ethers';

import { gasService } from './gasService';
import { wrapRpc } from './rpc/rpcService';
import { Logger } from '../../helpers/loggerHelper';
import { addPaymasterData } from './paymasterService';
import { rpcProviders } from '../../types/commonType';
import { IBlockchain } from '../../models/blockchainModel';
import { sendUserOperationToBundler } from './bundlerService';
import { getUserOpHash } from '../../helpers/userOperationHelper';
import { PackedUserOperation, UserOperationReceipt } from '../../types/userOperationType';

/**
 * Creates a generic user operation for a transaction.
 * Retrieves gas parameters from the blockchain config and applies a multiplier.
 *
 * @param {ethers.providers.JsonRpcProvider} provider - Blockchain Provider.
 * @param {IBlockchain['gas']} gasConfig - Blockchain gas config with predefined values.
 * @param {boolean} supportsEIP1559 - Indicates if the network supports EIP-1559 fee structure.
 * @param {string} callData - Encoded function call data.
 * @param {string} sender - Sender address initiating the operation.
 * @param {BigNumber} nonce - Nonce value to prevent replay attacks.
 * @param {'transfer' | 'swap'} userOpType - Operation type determining gas parameters.
 * @param {number} [gasMultiplier=1.0] - Optional multiplier to adjust gas values (default: 1.0).
 * @returns {Promise<PackedUserOperation>} The created user operation with adjusted gas limits and fees.
 */
export async function createGenericUserOperation(
  provider: ethers.providers.JsonRpcProvider,
  gasConfig: IBlockchain['gas'],
  supportsEIP1559: boolean,
  callData: string,
  sender: string,
  nonce: BigNumber,
  userOpType: 'transfer' | 'swap',
  gasMultiplier: number
): Promise<PackedUserOperation> {
  const gasValues = gasConfig.operations[userOpType];
  const perGasData: { maxPriorityFeePerGas: BigNumber; maxFeePerGas: BigNumber } = {
    maxPriorityFeePerGas: ethers.utils.parseUnits(gasValues.maxPriorityFeePerGas, 'gwei'),
    maxFeePerGas: ethers.utils.parseUnits(gasValues.maxFeePerGas, 'gwei')
  };

  if (!gasConfig.useFixedValues) {
    const DynamicGasValues = await gasService.getPerGasValues(
      gasConfig.operations[userOpType],
      provider,
      gasMultiplier
    );

    perGasData.maxPriorityFeePerGas = DynamicGasValues.maxPriorityFeePerGas;
    perGasData.maxFeePerGas = DynamicGasValues.maxFeePerGas;
  }

  // Create and return userOp with adjusted gas values
  const userOp: PackedUserOperation = {
    sender,
    nonce,
    initCode: '0x',
    callData,
    verificationGasLimit: BigNumber.from(gasValues.verificationGasLimit),
    callGasLimit: BigNumber.from(gasValues.callGasLimit),
    preVerificationGas: BigNumber.from(gasValues.preVerificationGas),
    maxFeePerGas: perGasData.maxFeePerGas,
    maxPriorityFeePerGas: supportsEIP1559
      ? perGasData.maxPriorityFeePerGas
      : perGasData.maxFeePerGas,
    paymasterAndData: '0x', // Will be filled by the paymaster service
    signature: '0x' // Empty signature initially
  };

  return userOp;
}

/**
 * Creates the encoded call data for a token transfer.
 * This method is designed to encode the parameters required for a token transfer
 * and returns the encoded data to be included in the user operation.
 *
 * @param {ethers.Contract} chatterPayContract - The contract for the ChatterPay service.
 * @param {ethers.Contract} erc20Contract - The ERC20 token contract to interact with.
 * @param {string} to - The address of the recipient for the token transfer.
 * @param {string} amount - The amount of tokens to be transferred.
 * @returns {string} The encoded call data for the token transfer.
 * @throws {Error} If the 'to' address is invalid or the amount cannot be parsed.
 */
export async function createTransferCallData(
  chatterPayContract: ethers.Contract,
  erc20Contract: ethers.Contract,
  to: string,
  amount: string
): Promise<string> {
  if (!ethers.utils.isAddress(to)) {
    throw new Error("Invalid 'to' address");
  }

  let amount_bn;
  try {
    const decimals = await erc20Contract.decimals();
    Logger.log('createTransferCallData', 'contract decimals', decimals);
    amount_bn = ethers.utils.parseUnits(amount, decimals);
  } catch (error) {
    Logger.error('createTransferCallData', `amount ${amount} error`, error);
    throw error;
  }

  try {
    Logger.log(
      'createTransferCallData',
      '[ executeTokenTransfer ]',
      erc20Contract.address,
      to,
      amount_bn
    );

    const functionSignature = 'executeTokenTransfer(address,address,uint256)';
    const functionSelector = ethers.utils
      .keccak256(ethers.utils.toUtf8Bytes(functionSignature))
      .substring(0, 10);
    const encodedParameters = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256'],
      [erc20Contract.address, to, amount_bn]
    );
    const callData = functionSelector + encodedParameters.slice(2);
    Logger.log('createTransferCallData', 'Transfer Call Data:', callData);

    return callData;
  } catch (error) {
    Logger.error('createTransferCallData', 'encodeFunctionData error', error);
    throw error;
  }
}

/**
 * Signs the UserOperation by generating a hash of the operation and using the provided signer to sign it.
 * This method ensures the integrity of the user operation and prevents tampering by verifying the signature.
 *
 * @param {PackedUserOperation} userOperation - The user operation to be signed.
 * @param {string} entryPointAddress - The address of the entry point contract.
 * @param {ethers.Wallet} signer - The User wallet used to sign the user operation.
 * @returns {Promise<PackedUserOperation>} The user operation with the generated signature.
 * @throws {Error} If the signature verification fails.
 */
export async function signUserOperation(
  userOperation: PackedUserOperation,
  entryPointAddress: string,
  signer: ethers.Wallet
): Promise<PackedUserOperation> {
  const { provider } = signer;
  const { chainId } = await provider!.getNetwork();

  const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);

  const ethSignedMessageHash = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['string', 'bytes32'],
      ['\x19Ethereum Signed Message:\n32', userOpHash]
    )
  );

  const { _signingKey } = signer;
  const signature = _signingKey().signDigest(ethers.utils.arrayify(ethSignedMessageHash));
  const recoveredAddress = ethers.utils.recoverAddress(ethSignedMessageHash, signature);

  const { getAddress } = ethers.utils;
  if (getAddress(recoveredAddress) !== getAddress(await signer.getAddress())) {
    throw new Error('Invalid signature');
  }

  return {
    ...userOperation,
    signature: ethers.utils.joinSignature(signature)
  };
}

/**
 * Signs a UserOperation using EIP-712 typed data signature.
 * This method provides replay protection across chains and contracts,
 * and is fully compliant with ERC-4337 standards.
 *
 * @param {PackedUserOperation} userOperation - The user operation to be signed.
 * @param {string} entryPointAddress - Address of the EntryPoint contract.
 * @param {ethers.Wallet} signer - Signer that will sign the operation (must support _signTypedData).
 * @param {string} chatterPayAddress - The ChatterPay proxy wallet address (verifyingContract).
 * @param {number} chainId - The ID of the blockchain network where the signature will be used.
 * @returns {Promise<PackedUserOperation>} - A user operation object with the EIP-712 signature included.
 */
export async function signUserOperationEIP712(
  userOperation: PackedUserOperation,
  entryPointAddress: string,
  signer: ethers.Wallet,
  chatterPayAddress: string,
  chainId: number
): Promise<PackedUserOperation> {
  const domain: TypedDataDomain = {
    name: 'ChatterPayWallet',
    version: '1.0.0',
    chainId,
    verifyingContract: chatterPayAddress
  };

  const types: Record<string, TypedDataField[]> = {
    UserOperation: [
      { name: 'sender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'initCode', type: 'bytes' },
      { name: 'callData', type: 'bytes' },
      { name: 'callGasLimit', type: 'uint256' },
      { name: 'verificationGasLimit', type: 'uint256' },
      { name: 'preVerificationGas', type: 'uint256' },
      { name: 'maxFeePerGas', type: 'uint256' },
      { name: 'maxPriorityFeePerGas', type: 'uint256' },
      { name: 'paymasterAndData', type: 'bytes' },
      { name: 'signature', type: 'bytes' }
    ]
  };

  const userOpToSign = {
    ...userOperation,
    signature: '0x'
  };

  const signature = await signer._signTypedData(domain, types, userOpToSign);

  return {
    ...userOperation,
    signature
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    backendSigner: ethers.Signer;
    provider: ethers.providers.JsonRpcProvider;
  }
}

/**
 * Waits for a user operation receipt to be available by polling the provider for the receipt hash.
 * It retries periodically until the receipt is found or a timeout occurs.
 *
 * @param {ethers.providers.JsonRpcProvider} provider - The JSON RPC provider to communicate with the Ethereum network.
 * @param {string} userOpHash - The hash of the user operation to wait for.
 * @param {number} timeout - The maximum time to wait for the receipt, in milliseconds. Default is 60000ms.
 * @param {number} interval - The interval between retries, in milliseconds. Default is 5000ms.
 * @returns {Promise<UserOperationReceipt>} The user operation receipt when available.
 */
export async function waitForUserOperationReceipt(
  bundlerRpcUrl: string,
  userOpHash: string,
  timeout = 300000, // 5 minutes
  interval = 5000 // 5 seconds
): Promise<UserOperationReceipt> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkReceipt = async () => {
      const payload = {
        jsonrpc: '2.0',
        method: 'eth_getUserOperationReceipt',
        params: [userOpHash],
        id: Date.now()
      };

      Logger.log('waitForUserOperationReceipt', `payload: ${JSON.stringify(payload)}`);

      try {
        const response = (await wrapRpc(
          async () =>
            axios.post(bundlerRpcUrl, payload, {
              headers: {
                'Content-Type': 'application/json'
              }
            }),
          rpcProviders.PIMLICO
        )) as AxiosResponse;

        const receipt = response.data.result;

        Logger.log(
          'waitForUserOperationReceipt',
          `Received from bundler: ${JSON.stringify(receipt)}`
        );

        if (receipt) {
          resolve(receipt);
        } else if (Date.now() - startTime < timeout) {
          const elapsed = Date.now() - startTime;
          Logger.log('waitForUserOperationReceipt', `Retrying... ${elapsed} / ${timeout} ms`);
          setTimeout(checkReceipt, interval);
        } else {
          reject(new Error('Timeout waiting for user operation receipt'));
        }
      } catch (error) {
        Logger.error('waitForUserOperationReceipt', error);

        if (Date.now() - startTime < timeout) {
          const elapsed = Date.now() - startTime;
          Logger.log(
            'waitForUserOperationReceipt',
            `Retrying after error... ${elapsed} / ${timeout} ms`
          );
          setTimeout(checkReceipt, interval);
        } else {
          reject(error);
        }
      }
    };

    checkReceipt();
  });
}

/**
 * Prepare and Execute User Operation
 * @param networkConfig - Blockchain network configuration
 * @param provider - Ethereum provider instance
 * @param signer - Wallet instance for signing transactions
 * @param backendSigner - Wallet instance for backend signing
 * @param entryPointContract - EntryPoint contract instance
 * @param userOpCallData - Encoded calldata for the user operation
 * @param userProxyAddress - Address of the user proxy contract
 * @param userOpType - Type of user operation ('transfer' or 'swap')
 * @param perGasMultiplier - Initial gas multiplier
 * @param callDataGasMultiplier - Multiplier for callData gas estimation
 * @returns
 */
async function prepareAndExecuteUserOperation(
  networkConfig: IBlockchain,
  provider: ethers.providers.JsonRpcProvider,
  signer: ethers.Wallet,
  backendSigner: ethers.Wallet,
  entryPointContract: ethers.Contract,
  userOpCallData: string,
  userProxyAddress: string,
  userOpType: 'transfer' | 'swap',
  logKey: string,
  perGasMultiplier: number,
  callDataGasMultiplier: number
) {
  try {
    Logger.log(userOpType, logKey, 'Getting Nonce');
    const nonce = await entryPointContract.getNonce(userProxyAddress, 0);
    Logger.info(
      userOpType,
      logKey,
      `Current nonce for proxy ${userProxyAddress}: ${nonce.toString()}`
    );

    // Create and prepare the user operation with the gas multiplier
    Logger.debug(userOpType, logKey, 'Creating generic user operation');
    let userOperation = await createGenericUserOperation(
      provider,
      networkConfig.gas,
      networkConfig.supportsEIP1559,
      userOpCallData,
      userProxyAddress,
      nonce,
      userOpType,
      perGasMultiplier
    );

    // Add paymaster data using the backend signer
    Logger.debug(
      userOpType,
      logKey,
      `Adding paymaster data with address: ${networkConfig.contracts.paymasterAddress}`
    );
    userOperation = await addPaymasterData(
      userOperation,
      networkConfig.contracts.paymasterAddress!,
      backendSigner,
      networkConfig.contracts.entryPoint,
      userOpCallData,
      networkConfig.chainId
    );

    // Sign the user operation with the user's signer
    Logger.debug(userOpType, logKey, 'Signing user operation');
    userOperation = await signUserOperation(
      userOperation,
      networkConfig.contracts.entryPoint,
      signer
    );
    /*
    userOperation = await signUserOperationEIP712(
      userOperation,
      networkConfig.contracts.entryPoint,
      signer,
      networkConfig.contracts.chatterPayAddress!,
      networkConfig.chainId
    );
    */

    Logger.info(userOpType, logKey, 'User operation signed successfully');

    if (!networkConfig.gas.useFixedValues) {
      // Get dynamic callData Gas Values and update userOperation
      Logger.debug(userOpType, logKey, 'Update gas values');
      const callDataGasValues = await gasService.getcallDataGasValues(
        networkConfig.gas.operations[userOpType],
        userOperation,
        networkConfig.rpc,
        entryPointContract.address,
        callDataGasMultiplier
      );
      userOperation.callGasLimit = callDataGasValues.callGasLimit;
      userOperation.verificationGasLimit = callDataGasValues.verificationGasLimit;
      userOperation.preVerificationGas = callDataGasValues.preVerificationGas;

      // Re-sign User Operation (because we changed the gas values!)
      Logger.debug(userOpType, logKey, 'Re-sign user operation');
      userOperation = await signUserOperation(
        userOperation,
        networkConfig.contracts.entryPoint,
        signer
      );

      /*
      userOperation = await signUserOperationEIP712(
        userOperation,
        networkConfig.contracts.entryPoint,
        signer,
        networkConfig.contracts.chatterPayAddress!,
        networkConfig.chainId
      );
      */
    }

    // Send the operation to the bundler and wait for receipt
    Logger.info(userOpType, logKey, `Sending operation to bundler: ${networkConfig.rpcBundler}`);
    const bundlerResponse = await sendUserOperationToBundler(
      networkConfig.rpcBundler,
      userOperation,
      entryPointContract.address
    );
    Logger.debug(userOpType, logKey, `Bundler response: ${JSON.stringify(bundlerResponse)}`);

    Logger.log(userOpType, logKey, 'Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(networkConfig.rpcBundler, bundlerResponse);

    if (!receipt?.success) {
      Logger.error(userOpType, logKey, `Operation failed. Receipt: ${JSON.stringify(receipt)}`);
      throw new Error(
        `Transaction failed or not found. Receipt: ${receipt.success}, Hash: ${receipt.userOpHash}`
      );
    }

    Logger.info(
      userOpType,
      logKey,
      `Operation completed successfully. Hash: ${receipt.receipt.transactionHash}, Block: ${receipt.receipt.blockNumber}`
    );

    Logger.log(userOpType, logKey, 'end!');

    return { success: true, transactionHash: receipt.receipt.transactionHash, error: '' };
  } catch (error) {
    const errorMessage = (error as Error).message;
    Logger.error(userOpType, logKey, `Error executing operation: ${errorMessage}`);
    return { success: false, transactionHash: '', error: errorMessage };
  }
}

/**
 * Execute User Operation with Retry
 * @param networkConfig - Blockchain network configuration
 * @param provider - Ethereum provider instance
 * @param signer - Wallet instance for signing transactions
 * @param backendSigner - Wallet instance for backend signing
 * @param entryPointContract - EntryPoint contract instance
 * @param userOpCallData - Encoded calldata for the user operation
 * @param userProxyAddress - Address of the user proxy contract
 * @param userOpType - Type of user operation ('transfer' or 'swap')
 * @param perGasInitialMultiplier - Initial gas multiplier
 * @param perGasIncrement - Increment factor for per Gas Fee.
 * @param callDataGasInitialMultiplier - Multiplier for callData gas estimation
 * @param timeoutMsBetweenRetries -Time Out (in ms) between retries
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @param attempt - number of attempt
 * @returns Execution result with success status, transaction hash, and error message
 */
export async function executeUserOperationWithRetry(
  networkConfig: IBlockchain,
  provider: ethers.providers.JsonRpcProvider,
  signer: ethers.Wallet,
  backendSigner: ethers.Wallet,
  entryPointContract: ethers.Contract,
  userOpCallData: string,
  userProxyAddress: string,
  userOpType: 'transfer' | 'swap',
  logKey: string,
  perGasInitialMultiplier: number,
  perGasIncrement: number,
  callDataGasInitialMultiplier: number,
  timeoutMsBetweenRetries: number,
  maxRetries: number = 5,
  attempt: number = 0
): Promise<{ success: boolean; transactionHash: string; error: string }> {
  Logger.log(
    `executeUserOperationWithRetry-${userOpType}`,
    `Attempt ${attempt + 1}/${maxRetries} with perGasMultiplier: ${perGasInitialMultiplier}`
  );

  const result = await prepareAndExecuteUserOperation(
    networkConfig,
    provider,
    signer,
    backendSigner,
    entryPointContract,
    userOpCallData,
    userProxyAddress,
    userOpType,
    logKey,
    perGasInitialMultiplier,
    callDataGasInitialMultiplier
  );

  if (result.success) {
    return result;
  }

  // Check if error is "replacement transaction UnderPriced" (case insensitive)
  if (/replacement transaction underpriced/i.test(result.error) && attempt < maxRetries) {
    Logger.warn(
      `executeUserOperationWithRetry-${userOpType}`,
      `Retrying due to underpriced transaction error (${attempt}/${maxRetries})`
    );
    await new Promise((resolve) => setTimeout(resolve, timeoutMsBetweenRetries));
    return executeUserOperationWithRetry(
      networkConfig,
      provider,
      signer,
      backendSigner,
      entryPointContract,
      userOpCallData,
      userProxyAddress,
      userOpType,
      logKey,
      perGasInitialMultiplier * perGasIncrement,
      callDataGasInitialMultiplier,
      maxRetries,
      attempt + 1
    );
  }

  Logger.error(
    `executeUserOperationWithRetry-${userOpType}`,
    `Max retries reached or a non-retryable error occurred.`
  );
  return result;
}
