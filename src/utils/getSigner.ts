import { ethers } from "ethers";
import User from "../models/user"
import { computeProxyAddressFromPhone } from "../services/predictWalletService";
import { SCROLL_CONFIG } from "../constants/networks";

export const getSigner = async (phone_number: string): Promise<ethers.Wallet> => {
    const user = await User.find({ phone_number });

    if (!user) {
        throw new Error(`User with phone number ${phone_number} not found`);
    }

    const privateKey = (await computeProxyAddressFromPhone(phone_number)).privateKey;

    const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);

    const signer = new ethers.Wallet(privateKey, provider);

    return signer;
}