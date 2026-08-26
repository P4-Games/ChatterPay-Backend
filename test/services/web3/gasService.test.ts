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

  it('does not abort on a transient RPC failure, which proves nothing about the tx', async () => {
    // Both estimateGas and callStatic land in the same catch, but a node that never evaluated
    // the call must not be reported as a guaranteed revert.
    const rpcDown = () => {
      throw Object.assign(new Error('missing response'), { code: 'SERVER_ERROR' });
    };
    const contract = contractDouble({ estimateGas: rpcDown, callStatic: rpcDown });

    const gas = await gasService.getDynamicGas(
      contract,
      'executeSwap',
      [],
      20,
      BigNumber.from(500_000),
      true
    );
    expect(gas.toString()).toBe('500000');
  });

  it('treats a CALL_EXCEPTION without a decoded name as a real revert', async () => {
    const reverted = () => {
      throw Object.assign(new Error('call revert exception'), {
        code: 'CALL_EXCEPTION',
        reason: 'STF'
      });
    };
    const contract = contractDouble({ estimateGas: reverted, callStatic: reverted });

    await expect(
      gasService.getDynamicGas(contract, 'executeSwap', [], 20, BigNumber.from(500_000), true)
    ).rejects.toThrow(/would revert on-chain: STF/);
  });

  it('keeps the message of a require-string revert instead of printing "Error"', async () => {
    // ethers sets errorName to the literal 'Error' for revert("msg") and puts the text in reason.
    const reverted = () => {
      throw Object.assign(new Error('call revert exception'), {
        code: 'CALL_EXCEPTION',
        errorName: 'Error',
        reason: 'ERC20: transfer amount exceeds balance'
      });
    };
    const contract = contractDouble({ estimateGas: reverted, callStatic: reverted });

    await expect(
      gasService.getDynamicGas(contract, 'executeSwap', [], 20, BigNumber.from(500_000), true)
    ).rejects.toThrow(/ERC20: transfer amount exceeds balance/);
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
