import { BigNumber, type Contract, ethers } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import type { OpGasValues } from '../../models/blockchainModel';
import type { PackedUserOperation } from '../../types/userOperationType';

/**
 * Calculates recommended gas values, prioritizing latest network estimations.
 * Applies a custom multiplier (percentage increase) to the recommended gas values.
 * Falls back to provided defaults if estimation fails or results are zero.
 *
 * @param defaultPerGasValues - Default gas values (as strings in Gwei)
 * @param provider - Ethereum JSON RPC provider
 * @param gasMultiplier - Multiplier for recommended gas values (e.g., 1.2 for 20% increase)
 * @returns Recommended maxPriorityFeePerGas and maxFeePerGas as BigNumbers
 */
const getPerGasValues = async (
  defaultPerGasValues: { maxFeePerGas: string; maxPriorityFeePerGas: string },
  provider: ethers.providers.JsonRpcProvider,
  gasMultiplier: number
): Promise<{ maxPriorityFeePerGas: BigNumber; maxFeePerGas: BigNumber }> => {
  const DEFAULT_MAX_FEE = ethers.utils.parseUnits(defaultPerGasValues.maxFeePerGas, 'gwei');
  const DEFAULT_PRIORITY_FEE = ethers.utils.parseUnits(
    defaultPerGasValues.maxPriorityFeePerGas,
    'gwei'
  );

  try {
    const feeHistory = await provider.send('eth_feeHistory', ['0x5', 'latest', [25, 50, 75]]);
    const baseFees = feeHistory.baseFeePerGas.map((fee: string) => BigNumber.from(fee));
    const priorityFees = feeHistory.reward.flat().map((fee: string) => BigNumber.from(fee));

    if (priorityFees.length === 0 || baseFees.length < 2) {
      throw new Error('Invalid fee history data');
    }

    const latestBaseFee = baseFees[baseFees.length - 2];
    const avgPriorityFee = priorityFees
      .reduce((a: BigNumber, b: BigNumber) => a.add(b), BigNumber.from(0))
      .div(priorityFees.length);

    let adjustedMaxFee = latestBaseFee
      .add(avgPriorityFee)
      .mul(Math.round(gasMultiplier * 100))
      .div(100);

    let adjustedPriorityFee = avgPriorityFee.mul(Math.round(gasMultiplier * 100)).div(100);

    if (adjustedMaxFee.lte(0)) {
      adjustedMaxFee = ethers.utils.parseUnits(defaultPerGasValues.maxFeePerGas, 'gwei');
    }

    if (adjustedPriorityFee.lte(0)) {
      adjustedPriorityFee = ethers.utils.parseUnits(
        defaultPerGasValues.maxPriorityFeePerGas,
        'gwei'
      );
    }

    Logger.info(
      'getPerGasValues',
      `Base Fee: ${ethers.utils.formatUnits(latestBaseFee, 'gwei')} gwei, ` +
        `Priority Fee: ${ethers.utils.formatUnits(adjustedPriorityFee, 'gwei')} gwei, ` +
        `Max Fee: ${ethers.utils.formatUnits(adjustedMaxFee, 'gwei')} gwei`
    );

    return {
      maxPriorityFeePerGas: adjustedPriorityFee,
      maxFeePerGas: adjustedMaxFee
    };
  } catch (error) {
    Logger.error('getRecommendedGasFees', error);
    return {
      maxPriorityFeePerGas: DEFAULT_PRIORITY_FEE,
      maxFeePerGas: DEFAULT_MAX_FEE
    };
  }
};

/**
 * Estimates gas values required for a user operation.
 *
 * @param userOperation - The packed user operation containing transaction details.
 * @param rpcUrl - The RPC URL to send the request for gas estimation.
 * @param entryPointContractAddress - The address of the EntryPoint contract.
 * @param gasMultiplier - A multiplier to adjust the estimated gas limits (default is 1).
 *
 * @returns An object containing estimated gas limits:
 *          - callGasLimit: The gas required for executing the call.
 *          - verificationGasLimit: The gas required for verification.
 *          - preVerificationGas: The gas required before verification.
 */
const getcallDataGasValues = async (
  opGasValues: OpGasValues,
  userOperation: PackedUserOperation,
  rpcUrl: string,
  entryPointContractAddress: string,
  gasMultiplier: number = 1
): Promise<{
  callGasLimit: BigNumber;
  verificationGasLimit: BigNumber;
  preVerificationGas: BigNumber;
}> => {
  const gasResult = {
    callGasLimit: BigNumber.from(opGasValues.callGasLimit),
    verificationGasLimit: BigNumber.from(opGasValues.verificationGasLimit),
    preVerificationGas: BigNumber.from(opGasValues.preVerificationGas)
  };

  const AlchemyUserOp = {
    sender: userOperation.sender,
    nonce: userOperation.nonce.toHexString(),
    initCode: userOperation.initCode,
    callData: userOperation.callData,
    maxFeePerGas: userOperation.maxFeePerGas.toHexString(),
    maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas.toHexString(),
    paymasterAndData: userOperation.paymasterAndData,
    signature: userOperation.signature
  };

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_estimateUserOperationGas',
      params: [AlchemyUserOp, entryPointContractAddress]
    })
  });

  let gettingGasValuesfrom = 'bdd';
  const alchemyResult = await response.json();

  if (alchemyResult && alchemyResult.result) {
    // Apply the same buffer to all three values: the bundler (Pimlico) re-validates
    // against its own estimate moments later, and on L2s preVerificationGas/verificationGasLimit
    // can drift up between estimation and submission (e.g. L1 calldata price changes on Arbitrum),
    // causing "preVerificationGas is not enough" if left unbuffered.
    const multiplierBps = Math.round(gasMultiplier * 100);
    gasResult.callGasLimit = BigNumber.from(alchemyResult.result.callGasLimit)
      .mul(multiplierBps)
      .div(100);
    gasResult.verificationGasLimit = BigNumber.from(alchemyResult.result.verificationGasLimit)
      .mul(multiplierBps)
      .div(100);
    gasResult.preVerificationGas = BigNumber.from(alchemyResult.result.preVerificationGas)
      .mul(multiplierBps)
      .div(100);
    gettingGasValuesfrom = 'alchemy';
  }

  Logger.log('getcallDataGasValues', '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
  Logger.info(
    'getcallDataGasValues',
    `Gas Params - callGasLimit: ${userOperation.callGasLimit.toString()}, verificationGasLimit: ${userOperation.verificationGasLimit.toString()}, preVerificationGas: ${userOperation.preVerificationGas.toString()}, maxFeePerGas: ${userOperation.maxFeePerGas.toString()} , maxPriorityFeePerGas: ${userOperation.maxPriorityFeePerGas.toString()}, getted values from: ${gettingGasValuesfrom}`
  );
  Logger.log('getcallDataGasValues', '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');

  return {
    callGasLimit: gasResult.callGasLimit,
    verificationGasLimit: gasResult.verificationGasLimit,
    preVerificationGas: gasResult.preVerificationGas
  };
};

/**
 * Tells a contract revert apart from a node that simply could not answer.
 *
 * ethers v5 marks a decoded revert with `CALL_EXCEPTION`, and carries the raw revert payload in
 * `data` (or the decoded custom-error name in `errorName`) even when the outer code says
 * `UNPREDICTABLE_GAS_LIMIT`. Everything else — `SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`,
 * rate limits — means the call was never evaluated and says nothing about the transaction.
 *
 * @param {unknown} error - Error thrown by estimateGas or callStatic
 * @returns {boolean} True when the error proves the transaction would revert
 */
const isRevert = (error: unknown): boolean => {
  const err = error as { code?: string; data?: unknown; errorName?: string; error?: unknown };
  if (!err) return false;
  if (err.code === 'CALL_EXCEPTION') return true;
  if (err.errorName || err.data) return true;
  const inner = err.error as { code?: number; data?: unknown } | undefined;
  // JSON-RPC error code 3 is the standard "execution reverted" response.
  return Boolean(inner && (inner.code === 3 || inner.data));
};

/**
 * Extracts the most informative description available from a revert.
 *
 * A `revert("msg")` sets `errorName` to the literal `'Error'` and puts the message in `reason`,
 * so preferring `errorName` unconditionally would print `Error` and discard the message. A
 * custom error such as `ChatterPay__SwapFailed` carries its name in `errorName` and no reason.
 *
 * @param {unknown} error - Error thrown by estimateGas or callStatic
 * @returns {string} Human-readable revert description
 */
const describeRevert = (error: unknown): string => {
  const err = error as { errorName?: string; reason?: string; message?: string };
  if (err?.errorName && err.errorName !== 'Error') return err.errorName;
  return err?.reason ?? err?.message ?? 'Unknown error';
};

/**
 * Marker for the error this module raises on a proven revert.
 *
 * The revert is detected in an inner catch whose throw is caught again by the outer one. The
 * error raised there is a plain Error carrying none of the provider's revert metadata, so
 * without a marker `isRevert` would not recognise it and the outer handler would swallow it
 * back into the default gas limit.
 */
const DOOMED_TX = Symbol('doomedTransaction');

/** True when the error is the one this module raised for a proven revert. */
const isDoomedTxError = (error: unknown): boolean =>
  Boolean((error as Record<symbol, unknown>)?.[DOOMED_TX]);

/**
 * Calculates a dynamic gas limit for a contract method, including a buffer percentage.
 * If estimation fails, it falls back to a default gas limit.
 *
 * @param {Contract} contract - The contract instance where the method will be executed.
 * @param {string} methodName - The name of the contract method to estimate gas for.
 * @param {unknown[]} args - The arguments to pass to the contract method.
 * @param {number} [gasBufferPercentage=10] - The buffer percentage to add to the estimated gas.
 * @param {BigNumber} [defaultGasLimit=BigNumber.from('7000000')] - The fallback gas limit if estimation fails.
 * @param {boolean} [throwOnStaticRevert=false] - Rethrow instead of falling back when the static
 *   call reverts. A reverting static call means the transaction is guaranteed to fail on-chain,
 *   so returning a default gas limit only broadcasts a doomed transaction and burns the gas.
 *   Callers that can surface the failure to the user should opt in.
 * @returns {Promise<BigNumber>} - The calculated gas limit.
 */
const getDynamicGas = async (
  contract: Contract,
  methodName: string,
  args: unknown[],
  gasBufferPercentage: number = 20,
  defaultGasLimit: BigNumber = BigNumber.from('250000'),
  throwOnStaticRevert: boolean = false
): Promise<BigNumber> => {
  const defaultGasMessage = `Default Estimated gas limit for ${methodName}: ${defaultGasLimit.toString()}`;

  try {
    if (typeof contract[methodName] !== 'function') {
      throw new Error(`The method ${methodName} doesn't exist in contract.`);
    }

    // First try estimateGas directly, without static call
    try {
      const estimatedGas: ethers.BigNumber = await contract.estimateGas[methodName](...args);
      const gasLimit: BigNumber = estimatedGas
        .mul(BigNumber.from(100 + gasBufferPercentage))
        .div(BigNumber.from(100));

      Logger.debug('getDynamicGas', `Estimated gas limit for ${methodName}:`, gasLimit.toString());
      return gasLimit;
    } catch (estimateError) {
      Logger.warn('getDynamicGas', `Gas estimation failed for ${methodName}:`, estimateError);

      // If estimateGas fails, try with static call as fallback
      try {
        await contract.callStatic[methodName](...args);
        // If static call works, use default gas with buffer
        const gasWithBuffer = defaultGasLimit
          .mul(BigNumber.from(100 + gasBufferPercentage))
          .div(BigNumber.from(100));

        Logger.debug(
          'getDynamicGas',
          `Using default gas with buffer for ${methodName}:`,
          gasWithBuffer.toString()
        );
        return gasWithBuffer;
      } catch (staticError) {
        Logger.warn('getDynamicGas', `Static call also failed for ${methodName}:`, staticError);

        // Only a genuine revert proves the transaction cannot succeed. This branch is also
        // reached when the node itself could not answer — a timeout, a 429, a SERVER_ERROR —
        // and aborting on those would turn a transient RPC blip into a failed user operation.
        // Fall back to the default gas limit in that case, exactly as before.
        if (throwOnStaticRevert && isRevert(staticError)) {
          throw Object.assign(
            new Error(`${methodName} would revert on-chain: ${describeRevert(staticError)}`),
            { [DOOMED_TX]: true }
          );
        }

        Logger.debug('getDynamicGas', defaultGasMessage);
        return defaultGasLimit;
      }
    }
  } catch (error) {
    if (throwOnStaticRevert && (isDoomedTxError(error) || isRevert(error))) throw error;
    Logger.warn('getDynamicGas', `Gas estimation completely failed for ${methodName}:`, error);
    Logger.debug('getDynamicGas', defaultGasMessage);
    return defaultGasLimit;
  }
};

export const gasService = {
  getPerGasValues,
  getcallDataGasValues,
  getDynamicGas
};
