/* Autogenerated file. Do not edit manually. */
/* tslint:disable */
/* eslint-disable */

import { Contract, Signer, utils } from 'ethers';
import type { Provider } from '@ethersproject/providers';
import type {
    ChatterPayWalletFactory,
    ChatterPayWalletFactoryInterface,
} from '../ChatterPayWalletFactory';

export class ChatterPayWalletFactory__factory {
    static createInterface(abi: any): ChatterPayWalletFactoryInterface {
        return new utils.Interface(abi) as ChatterPayWalletFactoryInterface;
    }
    static connect(address: string, abi: any, signerOrProvider: Signer | Provider): ChatterPayWalletFactory {
        return new Contract(address, abi, signerOrProvider) as ChatterPayWalletFactory;
    }
}
