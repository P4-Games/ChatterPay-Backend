import Token from '../../models/tokenModel';

export const mongoTokenService = {
  /**
   * Validates if a token is listed and active in our system
   * @param {string} tokenAddress - The token address to validate
   * @param {number} chain_id - The chain ID where the token exists
   * @returns {Promise<boolean>} True if the token is valid and listed
   */
  async isValidToken(tokenAddress: string, chain_id: number): Promise<boolean> {
    const token = await Token.findOne({
      address: { $regex: new RegExp(`^${tokenAddress}$`, 'i') },
      chain_id,
      is_active: true
    });

    return !!token;
  }
};
