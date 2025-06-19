// scripts/update_missing_names.ts

import dotenv from 'dotenv';
import mongoose, { Schema, Document, Connection } from 'mongoose';

import { Logger } from '../src/helpers/loggerHelper';

dotenv.config();

const CHATTERPAY_MONGO_URI = process.env.CHATTERPAY_MONGO_URI!;
const CHATIZALO_MONGO_URI = process.env.CHATIZALO_MONGO_URI!;
const CHATTERPAY_DB_NAME = process.env.CHATTERPAY_DB_NAME!;
const CHATIZALO_DB_NAME = process.env.CHATIZALO_DB_NAME!;
const CHATTERPAY_COLLECTION_NAME = 'users';
const CHATIZALO_COLLECTION_NAME = 'contacts';
const ONLY_TEST = false;

interface User extends Document {
  name?: string | null;
  phone_number: string;
}

interface Contact extends Document {
  name: string;
  phone_number?: string;
  channel_user_id?: string;
}

const chatterpayUserSchema = new Schema<User>({
  name: { type: String, default: null },
  phone_number: { type: String, required: true }
});

const chatizaloContactSchema = new Schema<Contact>({
  name: { type: String, required: true },
  phone_number: { type: String },
  channel_user_id: { type: String }
});

function buildUri(baseUri: string, dbName: string): string {
  if (baseUri.includes('mongodb+srv')) {
    return `${baseUri}${baseUri.includes('?') ? '&' : '?'}retryWrites=true&w=majority&dbName=${dbName}`;
  }
  if (baseUri.endsWith('/')) {
    return `${baseUri}${dbName}`;
  }
  return `${baseUri}/${dbName}`;
}

async function main() {
  let chatterpayConn: Connection;
  let chatizaloConn: Connection;

  try {
    Logger.info('connect', `Connecting to chatterpay DB: ${CHATTERPAY_DB_NAME}`);
    chatterpayConn = await mongoose
      .createConnection(buildUri(CHATTERPAY_MONGO_URI, CHATTERPAY_DB_NAME))
      .asPromise();
    Logger.info('connect', 'Connected to chatterpay');

    Logger.info('connect', `Connecting to chatizalo DB: ${CHATIZALO_DB_NAME}`);
    chatizaloConn = await mongoose
      .createConnection(buildUri(CHATIZALO_MONGO_URI, CHATIZALO_DB_NAME))
      .asPromise();
    Logger.info('connect', 'Connected to chatizalo');

    const ChatterpayUserModel = chatterpayConn.model<User>(
      'User',
      chatterpayUserSchema,
      CHATTERPAY_COLLECTION_NAME
    );

    const ChatizaloContactModel = chatizaloConn.model<Contact>(
      'Contact',
      chatizaloContactSchema,
      CHATIZALO_COLLECTION_NAME
    );

    const usersToUpdate = await ChatterpayUserModel.find({ name: null });
    Logger.info('process', `Found ${usersToUpdate.length} users with null names.`);
    let updatedCount = 0;

    await Promise.all(
      usersToUpdate.map(async (user) => {
        const phone = user.phone_number;

        const matchingContact = await ChatizaloContactModel.findOne({
          $or: [{ phone_number: phone }, { channel_user_id: phone }]
        });

        if (matchingContact?.name) {
          Logger.log(`Updating user ${user.phone_number} with name ${matchingContact.name}`);
          if (!ONLY_TEST) {
            await ChatterpayUserModel.updateOne(
              { _id: user._id },
              { $set: { name: matchingContact.name } }
            );
            updatedCount += 1;
          }
        }
      })
    );

    Logger.log(`Successfully updated ${updatedCount} users`);
  } catch (err) {
    Logger.error('Migration error:', err);
  } finally {
    await Promise.all(mongoose.connections.map((conn) => conn.close()));
    Logger.log('Connections closed');
  }
}

main();
