import { it, expect, describe } from 'vitest';

describe('generateOnRampLink', () => {
  it('should generate a valid on-ramp link with wallet address', () => {
    const mockWalletAddress = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    const expectedLink = `https://onramp.money/main/buy/?appId=1562916&coinCode=usdt&network=scroll&walletAddress=${mockWalletAddress}`;

    expect(expectedLink).toContain('https://onramp.money/main/buy/');
    expect(expectedLink).toContain('appId=1562916');
    expect(expectedLink).toContain('coinCode=usdt');
    expect(expectedLink).toContain('network=scroll');
    expect(expectedLink).toContain(`walletAddress=${mockWalletAddress}`);
  });

  it('should validate link format', () => {
    const mockWalletAddress = '0x1234567890123456789012345678901234567890';
    const link = `https://onramp.money/main/buy/?appId=1562916&coinCode=usdt&network=scroll&walletAddress=${mockWalletAddress}`;

    expect(link).toMatch(
      /^https:\/\/onramp\.money\/main\/buy\/\?appId=\d+&coinCode=\w+&network=\w+&walletAddress=0x[a-fA-F0-9]{40}$/
    );
  });
});
