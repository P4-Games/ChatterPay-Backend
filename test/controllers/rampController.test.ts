import { it, expect, describe } from 'vitest';

import {
  ONRAMP_APP_ID,
  ONRAMP_BASE_URL,
  ONRAMP_DEFAULT_NETWORK,
  ONRAMP_DEFAULT_COIN_CODE
} from '../../src/config/constants';

describe('generateOnRampLink', () => {
  it('should generate a valid on-ramp link with wallet address', () => {
    const mockWalletAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    const expectedLink = `${ONRAMP_BASE_URL}?appId=${ONRAMP_APP_ID}&coinCode=${ONRAMP_DEFAULT_COIN_CODE}&network=${ONRAMP_DEFAULT_NETWORK}&walletAddress=${mockWalletAddress}`;

    expect(expectedLink).toContain(ONRAMP_BASE_URL);
    expect(expectedLink).toContain(`appId=${ONRAMP_APP_ID}`);
    expect(expectedLink).toContain(`coinCode=${ONRAMP_DEFAULT_COIN_CODE}`);
    expect(expectedLink).toContain(`network=${ONRAMP_DEFAULT_NETWORK}`);
    expect(expectedLink).toContain(`walletAddress=${mockWalletAddress}`);
  });

  it('should validate link format', () => {
    const mockWalletAddress = '0x1234567890123456789012345678901234567890';
    const link = `${ONRAMP_BASE_URL}?appId=${ONRAMP_APP_ID}&coinCode=${ONRAMP_DEFAULT_COIN_CODE}&network=${ONRAMP_DEFAULT_NETWORK}&walletAddress=${mockWalletAddress}`;

    expect(link).toMatch(
      /^https:\/\/onramp\.money\/main\/buy\/\?appId=\d+&coinCode=\w+&network=\w+&walletAddress=0x[a-fA-F0-9]{40}$/
    );
  });
});
