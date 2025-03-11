import { ethers, BigNumber } from 'ethers';

import { gasService } from './gasService';
import { Logger } from '../../helpers/loggerHelper';
import { addPaymasterData } from './paymasterService';
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
    maxPriorityFeePerGas: perGasData.maxPriorityFeePerGas,
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
      '*** [ executeTokenTransfer ] *** ',
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
  provider: ethers.providers.JsonRpcProvider,
  userOpHash: string,
  timeout = 300000, // 5 minutes
  interval = 5000 // 5 seconds
): Promise<UserOperationReceipt> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const checkReceipt = () => {
      provider
        .send('eth_getUserOperationReceipt', [userOpHash])
        .then((receipt: UserOperationReceipt | null) => {
          if (receipt) {
            resolve(receipt);
          } else if (Date.now() - startTime < timeout) {
            const elapsed = Date.now() - startTime;
            Logger.log('waitForUserOperationReceipt', `Retrying... ${elapsed} / ${timeout} ms`);
            setTimeout(checkReceipt, interval);
          } else {
            reject(
              new Error('waitForUserOperationReceipt: Timeout waiting for user operation receipt')
            );
          }
        })
        .catch((error) => {
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
        });
    };

    checkReceipt();
  });
}

/**
 * Prepare and Execute User Operation
 * @param networkConfig
 * @param provider
 * @param signer
 * @param backendSigner
 * @param entryPointContract
 * @param userOpCallData
 * @param userProxyAddress
 * @param userOpType
 * @param perGasMultiplier
 * @param callDataGasMultiplier
 * @returns
 */
export async function prepareAndExecuteUserOperation(
  networkConfig: IBlockchain,
  provider: ethers.providers.JsonRpcProvider,
  signer: ethers.Wallet,
  backendSigner: ethers.Wallet,
  entryPointContract: ethers.Contract,
  userOpCallData: string,
  userProxyAddress: string,
  userOpType: 'transfer' | 'swap',
  perGasMultiplier: number,
  callDataGasMultiplier: number
) {
  try {
    Logger.log(userOpType, 'Getting Nonce');
    const nonce = await entryPointContract.getNonce(userProxyAddress, 0);
    Logger.info(userOpType, `Current nonce for proxy ${userProxyAddress}: ${nonce.toString()}`);

    // Create and prepare the user operation with the gas multiplier
    Logger.debug(userOpType, 'Creating generic user operation');
    let userOperation = await createGenericUserOperation(
      provider,
      networkConfig.gas,
      userOpCallData,
      userProxyAddress,
      nonce,
      userOpType,
      perGasMultiplier
    );

    // Add paymaster data using the backend signer
    Logger.debug(
      userOpType,
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
    Logger.debug(userOpType, 'Signing user operation');
    userOperation = await signUserOperation(
      userOperation,
      networkConfig.contracts.entryPoint,
      signer
    );
    Logger.info(userOpType, 'User operation signed successfully');

    if (!networkConfig.gas.useFixedValues) {
      // Get dynamic callData Gas Values and update userOperation
      Logger.debug(userOpType, 'Update gas values');
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
      Logger.debug(userOpType, 'Re-sign user operation');
      userOperation = await signUserOperation(
        userOperation,
        networkConfig.contracts.entryPoint,
        signer
      );
    }

    // Send the operation to the bundler and wait for receipt
    Logger.info(userOpType, `Sending operation to bundler: ${networkConfig.bundlerUrl}`);
    const bundlerResponse = await sendUserOperationToBundler(
      // networkConfig.bundlerUrl!,
      networkConfig.rpc,
      userOperation,
      entryPointContract.address
    );
    Logger.debug(userOpType, `Bundler response: ${JSON.stringify(bundlerResponse)}`);

    Logger.log(userOpType, 'Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
    Logger.log(userOpType, 'Transaction receipt:', JSON.stringify(receipt));

    if (!receipt?.success) {
      Logger.error(userOpType, `Operation failed. Receipt: ${JSON.stringify(receipt)}`);
      throw new Error(
        `Transaction failed or not found. Receipt: ${receipt.success}, Hash: ${receipt.userOpHash}`
      );
    }

    Logger.info(
      userOpType,
      `Operation completed successfully. Hash: ${receipt.receipt.transactionHash}, Block: ${receipt.receipt.blockNumber}`
    );

    Logger.log(userOpType, 'end!');

    return { success: true, transactionHash: receipt.receipt.transactionHash, error: '' };
  } catch (error) {
    const errorMessage = (error as Error).message;
    Logger.error(userOpType, `Error executing operation: ${errorMessage}`);
    return { success: false, transactionHash: '', error: errorMessage };
  }
}
