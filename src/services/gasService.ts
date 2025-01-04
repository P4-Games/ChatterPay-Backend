import PQueue from 'p-queue';
import { ethers, BigNumber } from 'ethers';
import axios, { AxiosResponse } from 'axios';

import { Logger } from '../utils/logger';
import { getUserOpHash } from '../utils/userOperation';
import { PackedUserOperation } from '../types/userOperation';

interface AlchemyGasResponse {
  paymasterAndData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

interface GasOverrides {
  maxFeePerGas?: string | { multiplier: number };
  maxPriorityFeePerGas?: string | { multiplier: number };
  callGasLimit?: string | { multiplier: number };
  verificationGasLimit?: string | { multiplier: number };
  preVerificationGas?: string | { multiplier: number };
}

interface GasServiceConfig {
  apiKey: string;
  policyId: string;
  entryPoint: string;
  network: string;
}

const createGasServiceConfig = (
  apiKey: string,
  policyId: string,
  entryPoint: string,
  network: string = 'arb-sepolia'
): GasServiceConfig => ({
  apiKey,
  policyId,
  entryPoint,
  network
});

export async function generateDummySignature(
  userOperation: Partial<PackedUserOperation>,
  entryPointAddress: string,
  chainId: number
): Promise<string> {
  // Crear una versión "dummy" de la UserOperation
  const dummyUserOp: PackedUserOperation = {
    sender: userOperation.sender ?? ethers.constants.AddressZero,
    nonce: userOperation.nonce || ethers.constants.Zero,
    initCode: userOperation.initCode ?? '0x',
    callData: userOperation.callData ?? '0x',
    callGasLimit: userOperation.callGasLimit || ethers.constants.Zero,
    verificationGasLimit: userOperation.verificationGasLimit || ethers.constants.Zero,
    preVerificationGas: userOperation.preVerificationGas || ethers.constants.Zero,
    maxFeePerGas: userOperation.maxFeePerGas || ethers.constants.Zero,
    maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas || ethers.constants.Zero,
    paymasterAndData: userOperation.paymasterAndData ?? '0x',
    signature: '0x'
  };

  // Calcular el hash de la operación dummy
  const userOpHash = getUserOpHash(dummyUserOp, entryPointAddress, chainId);

  // Generar una firma dummy
  // Utilizamos una clave privada aleatoria para esto
  const dummyWallet = ethers.Wallet.createRandom();
  const dummySignature = await dummyWallet.signMessage(ethers.utils.arrayify(userOpHash));

  Logger.log('Generated dummy signature:', dummySignature);

  return dummySignature;
}

const queue = new PQueue({ interval: 10000, intervalCap: 1 }); // 1 request each 10 seg

export async function getPaymasterAndData(
  config: GasServiceConfig,
  userOp: Partial<PackedUserOperation>,
  signer: ethers.Signer,
  overrides?: GasOverrides
): Promise<AlchemyGasResponse> {
  const chainId = await signer.getChainId();
  const dummySignature = await generateDummySignature(userOp, config.entryPoint, chainId);

  const payload = {
    id: 1,
    jsonrpc: '2.0',
    method: 'alchemy_requestGasAndPaymasterAndData',
    params: [
      {
        policyId: config.policyId,
        entryPoint: config.entryPoint,
        dummySignature,
        userOperation: {
          sender: userOp.sender,
          nonce: userOp.nonce ? ethers.utils.hexlify(userOp.nonce) : '0x0',
          initCode: userOp.initCode ?? '0x',
          callData: userOp.callData
        },
        overrides
      }
    ]
  };

  try {
    // Wrapper function in quue to avoid erro 429 (rate-limit)
    const response = (await queue.add(async () =>
      axios.post(process.env.ARBITRUM_SEPOLIA_RPC_URL ?? '', payload, {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        }
      })
    )) as AxiosResponse;

    if (response.data.error) {
      throw new Error(`Alchemy API Error: ${response.data.error.message}`);
    }

    return response.data.result;
  } catch (error) {
    Logger.error('Error fetching paymaster data:', error);
    throw error;
  }
}

const applyPaymasterDataToUserOp = async (
  config: GasServiceConfig,
  userOp: Partial<PackedUserOperation>,
  signer: ethers.Signer,
  overrides?: GasOverrides
): Promise<PackedUserOperation> => {
  const gasData = await getPaymasterAndData(config, userOp, signer, overrides);

  return {
    ...userOp,
    paymasterAndData: gasData.paymasterAndData,
    callGasLimit: BigNumber.from(gasData.callGasLimit),
    verificationGasLimit: BigNumber.from(gasData.verificationGasLimit),
    preVerificationGas: BigNumber.from(gasData.preVerificationGas),
    maxFeePerGas: BigNumber.from(gasData.maxFeePerGas),
    maxPriorityFeePerGas: BigNumber.from(gasData.maxPriorityFeePerGas)
  } as PackedUserOperation;
};

export const gasService = {
  createConfig: createGasServiceConfig,
  getPaymasterAndData,
  applyPaymasterDataToUserOp
};
