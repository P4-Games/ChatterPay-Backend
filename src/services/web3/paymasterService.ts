import { ethers, BigNumber } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { IBlockchain } from '../../models/blockchainModel';
import { PackedUserOperation } from '../../types/userOperationType';
import { createPaymasterAndData } from '../../helpers/paymasterHelper';

/**
 * Add paymaster-related data to the given UserOperation.
 *
 * This function computes and attaches the necessary data that the paymaster requires for the UserOperation,
 * such as the paymaster address, the sender's address, and validity period.
 *
 * @param userOp - The user operation to which the paymaster data will be added.
 * @param paymasterAddress - The address of the paymaster contract.
 * @param backendSigner - The signer that signs the paymaster data.
 * @returns A new UserOperation with the added paymaster data.
 */
export async function addPaymasterData(
  userOp: PackedUserOperation,
  paymasterAddress: string,
  backendSigner: ethers.Signer,
  entrypoint: string,
  callData: string,
  chainId: number
): Promise<PackedUserOperation> {
  const paymasterAndData = await createPaymasterAndData(
    paymasterAddress,
    userOp.sender,
    backendSigner,
    entrypoint,
    callData,
    3600, // 1 hour validity
    chainId
  );

  Logger.log('addPaymasterData', 'Generated paymasterAndData:', paymasterAndData);

  return {
    ...userOp,
    paymasterAndData
  };
}

/**
 * Ensures that the paymaster has enough ETH prefund for operations.
 *
 * This function checks if the paymaster has enough balance to cover the required minimum prefund
 * and deposits additional funds if necessary. It logs each action taken.
 *
 * @param entrypointContract - The contract that interacts with the paymaster.
 * @param paymasterContractAddress - The address of the paymaster contract.
 * @returns A boolean indicating whether the operation was successful.
 */
export async function ensurePaymasterHasEnoughEth(
  blockchainBalances: IBlockchain['balances'],
  entrypointContract: ethers.Contract,
  paymasterContractAddress: string
): Promise<boolean> {
  try {
    const paymasterBalance = await entrypointContract.balanceOf(paymasterContractAddress);
    const minBalance = ethers.utils.parseEther(blockchainBalances.paymasterMinBalance);
    const targetBalance = ethers.utils.parseEther(blockchainBalances.paymasterTargetBalance);

    Logger.log(
      'ensurePaymasterHasEnoughEth',
      `Checking prefund requirements in paymaster ${paymasterContractAddress}.`
    );
    Logger.log(
      'ensurePaymasterHasEnoughEth',
      `Paymaster: current balance: ${ethers.utils.formatEther(paymasterBalance)} ETH.`
    );
    Logger.log(
      'ensurePaymasterHasEnoughEth',
      `Paymaster: minimum required balance: ${ethers.utils.formatEther(minBalance)} ETH.`
    );
    Logger.log(
      'ensurePaymasterHasEnoughEth',
      `Paymaster: Target balance if deposit needed: ${ethers.utils.formatEther(targetBalance)} ETH.`
    );

    // If the paymaster balance is less than the minimum, perform a deposit
    if (paymasterBalance.lt(minBalance)) {
      Logger.log('ensurePaymasterHasEnoughEth', 'Paymaster does not have enough pre-fund.');
      const missingFunds = targetBalance.sub(paymasterBalance);
      Logger.log(
        'ensurePaymasterHasEnoughEth',
        `Depositing ${ethers.utils.formatEther(missingFunds)} ETH to account.`
      );

      // Deposit funds into the paymaster
      const tx = await entrypointContract.depositTo(paymasterContractAddress, {
        value: missingFunds,
        gasLimit: 500000
      });
      await tx.wait();
      Logger.log('ensurePaymasterHasEnoughEth', 'Deposit transaction confirmed.');

      // Verify the new balance after deposit
      const newBalance = await entrypointContract.balanceOf(paymasterContractAddress);
      Logger.log(
        'ensurePaymasterHasEnoughEth',
        `New balance after deposit: ${ethers.utils.formatEther(newBalance)} ETH`
      );
    } else {
      Logger.log('ensurePaymasterHasEnoughEth', 'Paymaster has enough pre-fund.');
    }
    return true;
  } catch (error) {
    Logger.error('ensurePaymasterHasEnoughEth', error);
    return false;
  }
}

/**
 * Retrieves the deposit balance of a Paymaster contract within the EntryPoint contract.
 *
 * @param {ethers.Contract} entrypointContract - The EntryPoint contract instance to check the Paymaster's balance.
 * @param {string} paymasterContractAddress - The address of the Paymaster contract.
 * @returns {Promise<{ value: BigNumber; inEth: string }>}
 *   - `value`: The Paymaster's deposit balance as a BigNumber.
 *   - `inEth`: The Paymaster's deposit balance formatted as a string in ETH.
 */
export async function getPaymasterEntryPointDepositValue(
  entrypointContract: ethers.Contract,
  paymasterContractAddress: string
): Promise<{ value: BigNumber; inEth: string }> {
  try {
    const paymasterBalance = await entrypointContract.balanceOf(paymasterContractAddress);
    return {
      value: paymasterBalance,
      inEth: `${ethers.utils.formatEther(paymasterBalance)} eth`
    };
  } catch (error) {
    Logger.error('ensurePaymasterHasEnoughEth', error);
    return { value: BigNumber.from('0'), inEth: '' };
  }
}

/**
 * Logs the change in the Paymaster's deposit value in the EntryPoint contract.
 *
 * @param entryPointContract - The EntryPoint contract instance used to fetch the current Paymaster deposit value.
 * @param paymasterContractAddress - The address of the Paymaster contract whose deposit value is being tracked.
 * @param paymasterDepositValuePrev - The previous Paymaster deposit value, including both raw value and its equivalent in ETH.
 */
export async function logPaymasterEntryPointDeposit(
  entryPointContract: ethers.Contract,
  paymasterContractAddress: string,
  paymasterDepositValuePrev: { value: BigNumber; inEth: string }
) {
  const paymasterDepositValueNow = await getPaymasterEntryPointDepositValue(
    entryPointContract,
    paymasterContractAddress
  );
  const cost = paymasterDepositValuePrev.value.sub(paymasterDepositValueNow.value);
  const costInEth = (
    parseFloat(paymasterDepositValuePrev.inEth) - parseFloat(paymasterDepositValueNow.inEth)
  ).toFixed(6);
  Logger.info(
    'sendTransferUserOperation',
    `Paymaster pre: ${paymasterDepositValuePrev.value.toString()} (${paymasterDepositValuePrev.inEth}), ` +
      `Paymaster now: ${paymasterDepositValueNow.value.toString()} (${paymasterDepositValueNow.inEth}), ` +
      `Cost: ${cost.toString()} (${costInEth} ETH)`
  );
}
