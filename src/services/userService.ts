import { sendPushNotificaton, subscribeToPushChannel } from "../controllers/replyController";
import { IUser, User } from "../models/user";
import { computeProxyAddressFromPhone } from "./predictWalletService";

/**
 * Creates a new wallet and user for the given phone number.
 * @param {string} phoneNumber - The phone number to create the wallet for.
 * @returns {Promise<string>} The proxy address of the created wallet.
 */
export const createUserWithWallet = async (phoneNumber: string): Promise<IUser> => {
    // Create new wallet
    const predictedWallet = await computeProxyAddressFromPhone(phoneNumber);

    // Create new user
    const user = new User({
        phone_number: phoneNumber,
        wallet: predictedWallet.proxyAddress,
        walletEOA: predictedWallet.EOAAddress,
        privateKey: predictedWallet.privateKey,
        code: null,
        photo: '/assets/images/avatars/generic_user.jpg',
        email: null,
        name: null,
        settings: { 
            notifications: { 
                language: 'en'
        }}
    });
    await user.save();

    // Push
    console.log('Push protocol', phoneNumber, predictedWallet.EOAAddress )
    const title = 'Chatterpay: Wallet Created!'
    const msg = `Your Wallet ${predictedWallet.EOAAddress} was creadted.` 
    await subscribeToPushChannel(predictedWallet.privateKeyNotHashed, predictedWallet.EOAAddress)
    sendPushNotificaton(title, msg, predictedWallet.EOAAddress) // avoid await            

    return user;
};


/**
 * Gets or creates a user based on the phone number.
 */
export const getOrCreateUser = async (phoneNumber: string): Promise<IUser> => {
    const user = await User.findOne({ phone_number: phoneNumber });

    if (user)
        return user
    console.log(
        `Número de telefono ${phoneNumber} no registrado en ChatterPay, registrando...`,
    );
    
    const newUser: IUser = await createUserWithWallet(phoneNumber);
    console.log(
        `Número de telefono ${phoneNumber} registrado con la wallet ${newUser.wallet}`,
    );

    return newUser;
};