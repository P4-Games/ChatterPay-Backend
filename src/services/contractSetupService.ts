import { ethers } from 'ethers';

import { IBlockchain } from '../models/blockchain';
import { getNetworkConfig } from './networkService';
import chatterPayABI from '../utils/chatterPayABI.json';
import { getBundlerUrl, validateBundlerUrl } from '../utils/bundler';
import { computeProxyAddressFromPhone } from './predictWalletService';

/**
 * Sets up the necessary contracts and providers for blockchain interaction.
 * @param blockchain - The blockchain configuration.
 * @param privateKey - The private key for the signer.
 * @param fromNumber - The phone number to compute the proxy address.
 * @returns An object containing the setup contracts and providers.
 * @throws Error if the chain ID is unsupported or the bundler URL is invalid.
 */
export async function setupContracts(blockchain: IBlockchain, privateKey: string, fromNumber: string) {
    const bundlerUrl = getBundlerUrl(blockchain.chain_id);
    if (!bundlerUrl) {
        throw new Error(`Unsupported chain ID: ${blockchain.chain_id}`);
    }

    console.log(`Validating bundler URL: ${bundlerUrl}`);
    const isValidBundler = await validateBundlerUrl(bundlerUrl);
    if (!isValidBundler) {
        throw new Error(`Invalid or unreachable bundler URL: ${bundlerUrl}`);
    }

    const network = await getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(network.rpc);
    const signer = new ethers.Wallet(privateKey, provider);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const proxy = await computeProxyAddressFromPhone(fromNumber);
    const accountExists = true;

    const chatterPay = new ethers.Contract(proxy.proxyAddress, chatterPayABI, signer);

    return { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists };
}

/**
 * Sets up an ERC20 token contract.
 * @param tokenAddress - The address of the ERC20 token contract.
 * @param signer - The signer to use for the contract.
 * @returns An ethers.Contract instance for the ERC20 token.
 */
export async function setupERC20(tokenAddress: string, signer: ethers.Wallet) {
    return new ethers.Contract(tokenAddress, [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)'
    ], signer);
}