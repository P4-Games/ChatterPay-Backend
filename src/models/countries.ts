import { model, Schema, Document } from 'mongoose';

import { NotificationLanguage, notificationLanguages } from '../types/commonType';

export interface ICountry extends Document {
  code: string; // ISO 3166-1 alpha-2 country code (e.g., 'AR')
  name: string;
  phone_code: string; // ITU-T E.164 international dialing code (e.g., '54' for Argentina)
  notification_language: NotificationLanguage; // Used for system messages
  main_language: string; // ISO 639-1 primary language code (e.g., 'ES', 'ZH', 'JA')
}

const CountrySchema = new Schema<ICountry>({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone_code: { type: String, required: true },
  notification_language: {
    type: String,
    required: true,
    enum: [...notificationLanguages] // match lowercase type
  },
  main_language: { type: String, required: true }
});

const CountryModel = model<ICountry>('Country', CountrySchema, 'countries');

export default CountryModel;
