import Token, { IToken } from '../../models/tokenModel';

export const mongoTokenService = {
  /**
   * Gets a token from the database if it exists
   * @param {string} tokenAddress - The token address to find
   * @param {number} chain_id - The chain ID where the token exists
   * @returns {Promise<Token | null>} The token object if found, null otherwise
   */
  async getToken(tokenAddress: string, chain_id: number): Promise<IToken | null> {
    return Token.findOne({
      address: { $regex: new RegExp(`^${tokenAddress}$`, 'i') },
      chain_id
    });
  }
};
