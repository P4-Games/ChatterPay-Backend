import { ethers } from 'ethers';
import * as crypto from 'crypto';

import { UserPrincipal } from '../types/commonType';
import { $P, $S, BUN_ENV } from '../config/constants';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';

export const secService = {
  get_up: (pn: string, chanId: string): string =>
    `0x${crypto
      .createHash('sha256')
      .update(`${$S}${chanId}${BUN_ENV}${getPhoneNumberFormatted(pn)}`)
      .digest('hex')}`,

  get_bs: (provider: ethers.providers.JsonRpcProvider): ethers.Wallet =>
    new ethers.Wallet($P!, provider),

  get_us: (pn: string, chainId: string): UserPrincipal =>
    ((data) => ({ data, EOAAddress: new ethers.Wallet(data).address }))(
      secService.get_up(pn, chainId)
    )
};
