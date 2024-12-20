import axios from 'axios';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import PinataSDK from '@pinata/sdk';
import { createHash } from 'crypto';
import { HttpAgent } from '@dfinity/agent';
import { AssetManager } from '@dfinity/assets';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { mnemonicToSeed, validateMnemonic } from 'bip39';

import {
    PINATA_JWT,
    ICP_MNEMONIC,
    ICP_CANISTER_ID,
    NFT_UPLOAD_IMAGE_ICP,
    NFT_UPLOAD_IMAGE_IPFS,
} from '../constants/environment';

dotenv.config();

// Funciones auxiliares

async function generateIdentityFromMnemonic(mnemonic: string): Promise<Ed25519KeyIdentity> {
    const isValidMnemonic = validateMnemonic(mnemonic);
    if (!isValidMnemonic) {
        throw new Error('La frase semilla es inválida');
    }
    const seed = await mnemonicToSeed(mnemonic);
    const privateKey = createHash('sha512').update(seed).digest().slice(0, 32);
    // @ts-expect-error 'it is ok'
    return Ed25519KeyIdentity.fromSecretKey(privateKey);
}

async function createAgent(identity: Ed25519KeyIdentity): Promise<HttpAgent> {
    const agent = new HttpAgent({
        host: 'https://ic0.app',
        identity,
    });

    return agent;
}

export const getImageDetails = async (imageUrl: string) => {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data, 'binary');
        const fileName = imageUrl.split('/').pop();
        const width = 800;
        const height = 600;
        return { fileName, width, height, imageBuffer };
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Error al descargar la imagen: ${error.message}`);
        } else {
            throw new Error('Error desconocido al descargar la imagen');
        }
    }
};

// Funciones de carga

export async function uploadToICP(imageBuffer: Buffer, fileName: string): Promise<string> {
    if (!NFT_UPLOAD_IMAGE_ICP) {
        console.info('upload NFT image to ICP disabled');
        return '';
    }

    console.info('Subiendo imagen a ICP');
    const FOLDER_UPLOAD = 'uploads';

    if (!ICP_CANISTER_ID) {
        throw new Error('CANISTER_ID is not set in the environment variables');
    }

    if (!ICP_MNEMONIC) {
        throw new Error('MNEMONIC is not set in the environment variables');
    }

    const identity = await generateIdentityFromMnemonic(ICP_MNEMONIC);
    const agent = await createAgent(identity);

    const assetManager = new AssetManager({ canisterId: ICP_CANISTER_ID, agent });
    const batch = assetManager.batch();
    const url = `https://${ICP_CANISTER_ID}.icp0.io/${FOLDER_UPLOAD}/${fileName}`;

    try {
        const key = await batch.store(imageBuffer, {
            path: `/${FOLDER_UPLOAD}`,
            fileName,
        });

        await batch.commit({
            onProgress: ({ current, total }) => {
                console.log(`Progreso de carga a ICP: ${(current / total) * 100}%`);
            },
        });
        console.log('this is my key', key);
        console.log(`Imagen subida con éxito a ICP: ${url}`);
        return url;
    } catch (error: unknown) {
        if (error instanceof Error) {
            if (error.message.includes('asset already exists')) {
                console.log(`La imagen ya existe en ICP: ${url}`);
                return `${url}`;
            }
            console.error('Error al subir a ICP:', error);
            throw error;
        } else {
            console.error('Error desconocido al subir a ICP:', error);
            throw new Error('Error desconocido');
        }
    }
}

export async function uploadToIpfs(imageBuffer: Buffer, fileName: string): Promise<string> {
    if (!NFT_UPLOAD_IMAGE_IPFS) {
        console.info('upload NFT image to IPFS disabled');
        return '';
    }

    console.info('Subiendo imagen a IPFS');

    try {
        const pinata = new PinataSDK({ pinataJWTKey: PINATA_JWT });
        const readableStream = new Readable();
        readableStream.push(imageBuffer);
        readableStream.push(null);

        const result = await pinata.pinFileToIPFS(readableStream, {
            pinataMetadata: { name: fileName },
            pinataOptions: { cidVersion: 0 },
        });

        const url = `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`;
        console.log(`Imagen subida con éxito a IPFS: ${url}`);
        return url;
    } catch (error) {
        console.error('Error al subir a IPFS:', error);
        throw error;
    }
}

export async function downloadAndProcessImage(imageUrl: string): Promise<Buffer> {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');

    return sharp(buffer)
        .resize(800, 600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
}
