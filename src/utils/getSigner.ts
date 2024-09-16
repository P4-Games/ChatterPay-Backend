import { ethers } from "ethers";

import { User } from "../models/user"
import { getNetworkConfig } from "../services/networkService";
import { computeProxyAddressFromPhone } from "../services/predictWalletService";

/**
 * Retrieves a signer for a given phone number.
 *
 * @param {string} phone_number - The phone number associated with the user.
 * @returns {Promise<ethers.Wallet>} A promise that resolves to an ethers Wallet instance.
 * @throws {Error} If the user is not found or if there's an error creating the signer.
 */
export const getSigner = async (phone_number: string): Promise<ethers.Wallet> => {
    const user = await User.findOne({ phone_number });

    if (!user) {
        throw new Error(`User with phone number ${phone_number} not found`);
    }

    const {privateKey} = await computeProxyAddressFromPhone(phone_number);

    const networkConfig = await getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);

    const signer = new ethers.Wallet(privateKey, provider);

    return signer;
}