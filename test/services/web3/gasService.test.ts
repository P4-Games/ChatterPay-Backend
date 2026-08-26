import { BigNumber, type Contract } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { gasService } from '../../../src/services/web3/gasService';

/**
 * Builds a contract double for `executeSwap` where gas estimation and the static call can
 * each be made to succeed or revert independently.
 */
function contractDouble({
  estimateGas,
  callStatic
}: {
  estimateGas: () => Promise<BigNumber>;
  callStatic: () => Promise<unknown>;
}) {
  return {
    executeSwap: vi.fn(),
    estimateGas: { executeSwap: vi.fn(estimateGas) },
    callStatic: { executeSwap: vi.fn(callStatic) }
  } as unknown as Contract;
}

const revert = () => {
  throw Object.assign(new Error('call revert exception'), {
    errorName: 'ChatterPay__SwapFailed'
  });
};

describe('gasService.getDynamicGas', () => {
  it('buffers the estimate when estimation succeeds', async () => {
    const contract = contractDouble({
      estimateGas: async () => BigNumber.from(100_000),
      callStatic: async () => undefined
    });

    const gas = await gasService.getDynamicGas(contract, 'executeSwap', [], 20);
    expect(gas.toString()).toBe('120000');
  });

  it('falls back to the default gas limit when the static call reverts', async () => {
    const contract = contractDouble({ estimateGas: revert, callStatic: revert });

    const gas = await gasService.getDynamicGas(
      contract,
      'executeSwap',
      [],
      20,
      BigNumber.from(500_000)
    );
    expect(gas.toString()).toBe('500000');
  });

  it('rethrows with the contract error name when throwOnStaticRevert is set', async () => {
    const contract = contractDouble({ estimateGas: revert, callStatic: revert });

    await expect(
      gasService.getDynamicGas(contract, 'executeSwap', [], 20, BigNumber.from(500_000), true)
    ).rejects.toThrow(/executeSwap would revert on-chain: ChatterPay__SwapFailed/);
  });

  it('still returns a gas limit when only estimation fails but the static call passes', async () => {
    const contract = contractDouble({ estimateGas: revert, callStatic: async () => undefined });

    const gas = await gasService.getDynamicGas(
      contract,
      'executeSwap',
      [],
      20,
      BigNumber.from(500_000),
      true
    );
    expect(gas.toString()).toBe('600000');
  });
});
