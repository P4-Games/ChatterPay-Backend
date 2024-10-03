import { Storage } from '@google-cloud/storage';
import { GCP_BUCKET_NAME, GCP_KEYFILE_PATH } from '../constants/constants';

// Inicializa el cliente de GCP Storage
const storage = new Storage({
    keyFilename: GCP_KEYFILE_PATH
});

// Function to get file from the GCP bucket
export const getFile = async (fileName: string): Promise<any> => {
    try {
        const bucket = storage.bucket(GCP_BUCKET_NAME);
        const file = bucket.file(fileName);
        const [fileContents] = await file.download();

        // Parsear JSON
        return JSON.parse(fileContents.toString());
    } catch (error) {
        console.error('Error al leer el archivo ABI:', error);
        throw new Error('Error al obtener el archivo ABI');
    }
};

// Function to get ERC20 ABI from the GCP bucket
export const getERC20ABI = async (): Promise<any> => {
    return getFile('ERC20.json');
};

// Function to get ChatterPay NFT ABI from the GCP bucket
export const getChatterPayNFTABI = async (): Promise<any> => {
    return getFile('ChatterPayNFT.json');
};

// Function to get ChatterPay Wallet ABI from the GCP bucket
export const getChatterPayWalletABI = async (): Promise<any> => {
    return getFile('ChatterPayWallet.json');
};

// Function to get ChatterPay Wallet Factory ABI from the GCP bucket
export const getChatterPayWalletFactoryABI = async (): Promise<any> => {
    return getFile('ChatterPayWalletFactory.json');
};

// Function to get EntryPoint ABI from the GCP bucket
export const getEntryPointABI = async (): Promise<any> => {
    return getFile('EntryPoint.json');
};