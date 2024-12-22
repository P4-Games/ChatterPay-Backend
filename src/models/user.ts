import { model, Schema, Document } from 'mongoose';

export interface IUser extends Document {
    name: string;
    email: string;
    phone_number: string;
    photo: string;
    wallet: string;
    code: number;
    privateKey: string;
    settings?: {
        notifications: {
            language: string;
        };
    }; 
}

const userSchema = new Schema<IUser>({
    name: { type: String, required: false },
    email: { type: String, required: false },
    phone_number: { type: String, required: true },
    photo: { type: String, required: false },
    wallet: { type: String, required: true },
    privateKey: { type: String, required: true },
    code: { type: Number, required: false },
    settings: { 
        notifications: {
            language: { type: String, required: true, default: 'en' } 
        }
    }
});

export const User = model<IUser>('User', userSchema, 'users');

/**
 * Función para obtener el wallet basado en el número de teléfono
 * @param {string} phoneNumber - El número de teléfono a buscar
 * @returns {Promise<string | null>} La dirección del wallet o null si no se encuentra
 */
export async function getWalletByPhoneNumber(phoneNumber: string): Promise<string | null> {
    try {
        const user = await User.findOne({ phone_number: phoneNumber }).select('wallet').exec();
        return user ? user.wallet : null; // Retorna la wallet si se encuentra, de lo contrario null
    } catch (error) {
        console.error('Error al obtener la wallet:', error);
        throw new Error('No se pudo obtener la wallet');
    }
}
