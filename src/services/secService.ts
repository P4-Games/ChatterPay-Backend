import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { $B, $P, $S, CDS1, CDS2, CDS3 } from '../config/constants';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import type { UserPrincipal } from '../types/commonType';

export const secService = {
  get_up: (pn: string, chanId: string): string => {
    const $c = crypto;
    const $a1 = Reflect.get($c, Buffer.from(CDS1!, 'hex').toString());
    const $a2 = Buffer.from(CDS2!, 'hex').toString();
    const $a3 = Buffer.from(CDS3!, 'hex').toString();
    const $x = getPhoneNumberFormatted;

    return `0x${$a1('sha256')
      [$a2](`${$S}${chanId}${$B}${$x(pn)}`)
      [$a3]('hex')}`;
  },

  get_bs: (provider: ethers.providers.JsonRpcProvider): ethers.Wallet =>
    new ethers.Wallet($P!, provider),

  get_us: (pn: string, chainId: string): UserPrincipal =>
    ((data) => ({ data, EOAAddress: new ethers.Wallet(data).address }))(
      secService.get_up(pn, chainId)
    )
};
