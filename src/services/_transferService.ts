/* eslint-disable no-restricted-syntax */
import { ethers, Wallet, BigNumber } from 'ethers';

import { IToken } from '../models/tokenModel';
import { getERC20ABI } from './gcp/gcpService2';
import { Logger } from '../helpers/loggerHelper';
import { getTokenBalances } from './balanceService';
import { IBlockchain } from '../models/blockchainModel';
import { IUser, IUserWallet } from '../models/userModel';
import { mongoUserService } from './mongo/mongoUserService';
import { getUserOpHash } from '../helpers/userOperationHekper';
import { checkBlockchainConditions } from './blockchainService';
import { PackedUserOperation } from '../types/userOperationType';
import { sendUserOperationToBundler } from './web3/bundlerService';
import { createTransferCallData } from './web3/userOperationService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { waitForUserOperationReceipt } from './web3/userOpExecutorService';
import {
  openOperation,
  closeOperation,
  getUserWalletByChainId,
  hasUserAnyOperationInProgress
} from './userService';
import { CALL_GAS_LIMIT, MAX_FEE_PER_GAS, PRE_VERIFICATION_GAS, VERIFICATION_GAS_LIMIT, MAX_PRIORITY_FEE_PER_GAS } from '../config/constants';
import {
  TokenBalance,
  TransactionData,
  SetupContractReturn,
  ExecueTransactionResult,
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult
} from '../types/commonType';

/**
 * Sends a user operation for token transfer.
 *
 * @param networkConfig
 * @param setupContractsResult
 * @param entryPointContract
 * @param fromNumber
 * @param to
 * @param tokenAddress
 * @param amount
 * @returns
 */
export async function sendUserOperation(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  fromNumber: string,
  to: string,
  tokenAddress: string,
  amount: string
): Promise<ExecueTransactionResult> {
  try {
    Logger.log("sendUserOperation", "owner in chattrpay", setupContractsResult.chatterPay.owner());


    Logger.log("sendUserOperation", "getERC20ABI");

    // Create transfer-specific call data
    // const erc20 = await setupERC20(tokenAddress, setupContractsResult.signer);
    const erc20ABI = await getERC20ABI();
    const erc20 = new ethers.Contract(
      tokenAddress,
      /*
      [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)'
      ],
      */
      erc20ABI,
      setupContractsResult.signer
    );
    
      
    // Verificar allowance
    const amount_bn = '100000000000000'; //  ethers.utils.parseUnits(amount, erc20.decimals); // '1000000' //
    const allowance = await erc20.allowance(setupContractsResult.proxy.proxyAddress, setupContractsResult.chatterPay.address);
    Logger.log("sendUserOperation", "Current allowance:", allowance.toString(), amount_bn);
    
    // Si no hay suficiente allowance, hacer approve
    if (allowance.lt(amount_bn)) {
      Logger.log("sendUserOperation", "Allowance insufficient, approving...");
      const approveTx = await erc20.approve(setupContractsResult.chatterPay.address, amount_bn);
      /* 
      let approvalData = await erc20.approve.populateTransaction(
        setupContractsResult.chatterPay.address,
        amount_bn
      ) */

      await approveTx.wait();
      Logger.log("sendUserOperation", "Approval transaction confirmed:", approveTx.hash);
    }
    
    
    const callData = createTransferCallData(setupContractsResult.chatterPay, erc20, to, amount);

    /*
    const callData = setupContractsResult.chatterPay.interface.encodeFunctionData('executeTokenTransfer', [
      erc20.address,
      to,
      amount_bn
    ]);
    */


    /*

    const approvalData = await erc20.approve.populateTransaction(
      '0x5c6237ee0628aB08D7D9eCCD7dD2d14F1fe3B231', // FIJO MI WALLET
      amount_bn
    )
    
    let callData = approvalData
    */


    /*
    const callData = setupContractsResult.chatterPay.interface.encodeFunctionData('executeTokenTransfer', [
      erc20.address,
      to,
      amount_bn
    ]);
    */
    // Logger.log('createTransferCallData', 'Transfer Call Data:', callData);
      
    // new
    /*
    const gasLimit = await setupContractsResult.provider.estimateGas({
    callData,
    from: setupContractsResult.proxy.proxyAddress // MI WALLET  wallet.address,
    })
    const gasPrice = (await setupContractsResult.provider.getFeeData()).gasPrice!
    Logger.log('createTransferCallData', 'GasLimit, gasPrice', gasLimit, gasPrice);


    callData = {
      ...callData,
      from: setupContractsResult.chatterPay.address,
      gasLimit,
      gasPrice,
      chainId: (await setupContractsResult.provider.getNetwork()).chainId,
      nonce: await setupContractsResult.provider.getTransactionCount(setupContractsResult.chatterPay.address),
      type: 113,
      customData: {
          gasPerPubdata: '50_000', // utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
      }, // as types.Eip712Meta,
      value: 0n,
  }
      */

    // Get the nonce
    // Logger.log('make_transaction', 'proxy_adddress', setupContractsResult.proxy.proxyAddress)

    // Logger.log("sendUserOperation", "CallData for executeTokenTransfer:", callData);
    
    // Estimar gas
    /*
    let gasLimit;
    try {
      gasLimit = await setupContractsResult.provider.estimateGas({
        to: setupContractsResult.chatterPay.address,
        data: callData,
        from: setupContractsResult.proxy.proxyAddress,
      });
      gasLimit = gasLimit.mul(120).div(100); // Aumentar un 20% para margen de seguridad
      Logger.log("sendUserOperation", "Gas estimation successful:", gasLimit.toString());
    } catch (error) {
      Logger.error("sendUserOperation", "Gas estimation failed:", error);
      return { success: false, transactionHash: '' };
    }
    */


    const nonce = await entryPointContract.getNonce(setupContractsResult.proxy.proxyAddress, 0);
    Logger.log('sendUserOperation', "nonce", nonce)
    
    // Create the base user operation
    /*
    let userOperation = await createGenericUserOperation(
      callData,
      setupContractsResult.proxy.proxyAddress,
      nonce
    );
    */

    const sender = setupContractsResult.proxy.proxyAddress;
    const userOperation: PackedUserOperation = {
        sender,
        nonce,
        initCode: '0x',
        callData,
        verificationGasLimit: BigNumber.from(VERIFICATION_GAS_LIMIT),
        callGasLimit: BigNumber.from(CALL_GAS_LIMIT),
        preVerificationGas: BigNumber.from(PRE_VERIFICATION_GAS),
        maxFeePerGas: BigNumber.from(ethers.utils.parseUnits(MAX_FEE_PER_GAS, 'gwei')),
        maxPriorityFeePerGas: BigNumber.from(ethers.utils.parseUnits(MAX_PRIORITY_FEE_PER_GAS, 'gwei')),
        paymasterAndData: '0x', // Will be filled by the paymaster service
        signature: '0x' // Empty signature initially
      };

    /* ******************************************************************************** */
    // Add paymaster data

    /*
    userOperation = await addPaymasterData(
      userOperation,
      networkConfig.contracts.paymasterAddress!,
      setupContractsResult.backendSigner,
      networkConfig.contracts.entryPoint,
      callData,
      networkConfig.chain_id
    );
    */
  
    /*
    const userOpWithPaymasterData = await createPaymasterAndData(
      networkConfig.contracts.paymasterAddress!,
      userOperation.sender,
      setupContractsResult.backendSigner,
      networkConfig.contracts.entryPoint,
      callData,
      3600, // 1 hour validity
      networkConfig.chain_id
    );
    */

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expirationTimestamp = currentTimestamp + 3600;
  
    // 1. Include chainId, entryPoint and callData in hash
    const messageHash = ethers.utils.solidityKeccak256(
      ['address', 'uint64', 'uint256', 'address', 'bytes'],
      [
        networkConfig.contracts.paymasterAddress!,
        expirationTimestamp,
        networkConfig.chain_id || (await setupContractsResult.backendSigner.getChainId()),
        networkConfig.contracts.entryPoint,
        callData // Key to prevent frontrunning!
      ]
    );
  
    // 2. Sign WITHOUT Ethereum prefix (use signDigest)
    const walletSigner = userOperation.sender as unknown as Wallet;
    const signature = walletSigner._signingKey().signDigest(
      ethers.utils.arrayify(messageHash)
    );
  
    // 3. Convert expiration to bytes8
    const expirationBytes = ethers.utils.hexZeroPad(
      ethers.utils.hexlify(expirationTimestamp),
      8
    );
  
    // 4. Concatenate components
    const userOpWithPaymasterData = ethers.utils.hexConcat([
      networkConfig.contracts.paymasterAddress!,
      ethers.utils.joinSignature(signature),
      expirationBytes
    ]);
    /* ******************************************************************************** */

    

    
    // Return the user operation with the added paymaster data
    const finalUserOperation =  {
        ...userOperation,
        userOpWithPaymasterData
      };



    Logger.log('addPaymasterData', 'finalUserOperation:', finalUserOperation);

    // Sign the user operation
    /*
    const finalUserOperation2 = await signUserOperation(
      finalUserOperation,
      networkConfig.contracts.entryPoint,
      setupContractsResult.signer
    );
    */

      const { provider } = setupContractsResult.signer;
      const { chainId } = await provider!.getNetwork();
    
      // 1. Generate userOpHash (correct format for EntryPoint)
      const userOpHash = getUserOpHash(userOperation, networkConfig.contracts.entryPoint, chainId);
    

      // 2. Sign the hash WITHOUT Ethereum prefix
      const { _signingKey } = setupContractsResult.signer;
      
      const signature2 = _signingKey().signDigest(
        ethers.utils.arrayify(userOpHash)
      );
    
      // 3. Verify using EntryPoint's method (without prefix)
      const recoveredAddress = ethers.utils.recoverAddress(
        userOpHash, // Original hash, no prefix
        signature
      );
    
      const { getAddress } = ethers.utils;
      if (getAddress(recoveredAddress) !== getAddress(await setupContractsResult.signer.getAddress())) {
        throw new Error('Invalid signature');
      }
    
      const finalUserOperation2 = { 
        ...finalUserOperation,
        signature: ethers.utils.joinSignature(signature2) 
      };


    Logger.log('addPaymasterData', 'finalUserOperation2:', finalUserOperation2);


    Logger.log('sendUserOperation', 'Sending user operation to bundler');
    const bundlerResponse = await sendUserOperationToBundler(
      setupContractsResult.bundlerUrl,
      finalUserOperation2,
      entryPointContract.address
    );
    Logger.log('sendUserOperation', 'Bundler response:', bundlerResponse);

    Logger.log('sendUserOperation', 'Waiting for transaction to be mined.');
    const receipt = await waitForUserOperationReceipt(
      setupContractsResult.provider,
      bundlerResponse
    );
    Logger.log('sendUserOperation', 'Transaction receipt:', JSON.stringify(receipt));

    if (!receipt?.success) {
      throw new Error('sendUserOperation: Transaction failed or not found');
    }

    Logger.log('sendUserOperation', 'Transaction confirmed in block:', receipt.receipt.blockNumber);
    Logger.log('sendUserOperation', 'end!');

    return { success: true, transactionHash: receipt.receipt.transactionHash };
  } catch (error) {
    Logger.error(
      'sendUserOperation',
      `Error, from: ${fromNumber}, to: ${to}, ` +
        `token address: ${tokenAddress}, amount: ${amount}, error: `,
      JSON.stringify(error)
    );
    return { success: false, transactionHash: '' };
  }
}

export async function withdrawWalletAllFunds(
  tokens: IToken[],
  networkConfig: IBlockchain,
  channel_user_id: string,
  to_wallet: string
): Promise<{ result: boolean; message: string }> {
  try {
    const bddUser: IUser | null = await mongoUserService.getUser(channel_user_id);
    if (!bddUser) {
      return { result: false, message: 'There are not user with that phone number' };
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      bddUser.wallets,
      networkConfig.chain_id
    );
    if (!userWallet) {
      return { result: false, message: `No wallet found for chain ${networkConfig.chain_id}` };
    }

    if (
      !userWallet ||
      userWallet.wallet_proxy === to_wallet ||
      userWallet.wallet_eoa === to_wallet
    ) {
      return { result: false, message: 'You are trying to send funds to your own wallet' };
    }

    if (hasUserAnyOperationInProgress(bddUser)) {
      return {
        result: false,
        message: `Concurrent withdraw-all operation for wallet ${userWallet.wallet_proxy}, phone: ${bddUser.phone_number}.`
      };
    }

    const to_wallet_formatted: string = !to_wallet.startsWith('0x') ? `0x${to_wallet}` : to_wallet;

    const walletTokensBalance: TokenBalance[] = await getTokenBalances(
      userWallet.wallet_proxy,
      tokens,
      networkConfig
    );

    // Check Blockchain Conditions
    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      return { result: false, message: 'Invalid Blockchain Conditions to make transaction' };
    }

    await openOperation(bddUser.phone_number, ConcurrentOperationsEnum.WithdrawAll);

    // Use forEach to iterate over the array and execute the transaction if the balance is greater than 0
    const delay = (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    // Arrays to store transactions data for later persistence
    const transactionsOutToSave: TransactionData[] = [];

    // Iterate through tokens and execute transactions
    for (let index = 0; index < walletTokensBalance.length; index += 1) {
      const tokenBalance: TokenBalance = walletTokensBalance[index];
      const { balance, address, symbol } = tokenBalance;
      const amount = parseFloat(balance);

      if (amount > 0) {
        // We are aware that using await inside for loops should be avoided,
        // as it can cause performance issues. We tried using Promise.all,
        // but it resulted in the failure of the user operation calls.
        //
        // eslint-disable-next-line no-await-in-loop
        const executeTransactionResult: ExecueTransactionResult = await sendUserOperation(
          networkConfig,
          checkBlockchainConditionsResult.setupContractsResult!,
          checkBlockchainConditionsResult.entryPointContract!,
          userWallet.wallet_proxy,
          to_wallet_formatted,
          address,
          balance
        );

        // Store transaction out data as a generic object
        transactionsOutToSave.push({
          tx: executeTransactionResult.transactionHash,
          walletFrom: userWallet.wallet_proxy,
          walletTo: to_wallet_formatted,
          amount,
          token: symbol,
          type: 'withdraw',
          status: 'completed'
        });

        // Only if it's not the last one
        if (index < walletTokensBalance.length - 1) {
          delay(15000); // 15 seg delay
        }
      }
    }

    // Persist all transaction data to the database after the loop
    await Promise.all(
      transactionsOutToSave.map((transaction) =>
        mongoTransactionService.saveTransaction(transaction)
      )
    );
  } catch (error: unknown) {
    return { result: false, message: (error as Error).message };
  }

  await closeOperation(channel_user_id, ConcurrentOperationsEnum.WithdrawAll);
  return { result: true, message: '' };
}


