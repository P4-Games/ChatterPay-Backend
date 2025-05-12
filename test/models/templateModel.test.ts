import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { it, expect, describe, afterEach, beforeEach } from 'vitest';

import {
  TemplateType,
  ITemplateSchema,
  NotificationEnum,
  NotificationTemplateType
} from '../../src/models/templateModel';

describe('Template Model', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    await mongoose.disconnect();
    await mongoose.connect(uri, {});
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('should create and save a Template document successfully', async () => {
    type TestTemplateSchema = Partial<ITemplateSchema>;

    const validTemplate: TestTemplateSchema = {
      notifications: {
        transfer: {
          title: {
            en: 'Transfer completed',
            es: 'Transferencia completada',
            pt: 'Transferência concluída'
          },
          message: {
            en: 'Your transfer was successful.',
            es: 'Tu transferencia fue exitosa.',
            pt: 'Sua transferência foi bem-sucedida.'
          }
        },
        swap: {
          title: { en: 'Swap completed', es: 'Intercambio completado', pt: 'Troca concluída' },
          message: {
            en: 'Your swap was successful.',
            es: 'Tu intercambio fue exitoso.',
            pt: 'Sua troca foi bem-sucedida.'
          }
        },
        mint: {
          title: { en: 'Minting completed', es: 'Creación completada', pt: 'Criação concluída' },
          message: {
            en: 'Your minting was successful.',
            es: 'Tu creación fue exitosa.',
            pt: 'Sua criação foi bem-sucedida.'
          }
        },
        outgoing_transfer: {
          title: {
            en: 'Outgoing Transfer',
            es: 'Transferencia Saliente',
            pt: 'Transferência de Saída'
          },
          message: {
            en: 'Your transfer is on the way.',
            es: 'Tu transferencia está en camino.',
            pt: 'Sua transferência está a caminho.'
          }
        },
        wallet_creation: {
          title: { en: 'Wallet Created', es: 'Billetera Creada', pt: 'Carteira Criada' },
          message: {
            en: 'Your wallet has been created successfully.',
            es: 'Tu billetera ha sido creada con éxito.',
            pt: 'Sua carteira foi criada com sucesso.'
          }
        },
        user_balance_not_enough: {
          title: { en: 'Insufficient Balance', es: 'Saldo Insuficiente', pt: 'Saldo Insuficiente' },
          message: {
            en: 'You do not have enough balance.',
            es: 'No tienes saldo suficiente.',
            pt: 'Você não tem saldo suficiente.'
          }
        },
        no_valid_blockchain_conditions: {
          title: {
            en: 'Invalid Blockchain Conditions',
            es: 'Condiciones de Blockchain Inválidas',
            pt: 'Condições de Blockchain Inválidas'
          },
          message: {
            en: 'Blockchain conditions are not met.',
            es: 'No se cumplen las condiciones de blockchain.',
            pt: 'As condições do blockchain não foram atendidas.'
          }
        },
        internal_error: {
          title: { en: 'Internal Error', es: 'Error Interno', pt: 'Erro Interno' },
          message: {
            en: 'An unexpected error occurred.',
            es: 'Ocurrió un error inesperado.',
            pt: 'Ocorreu um erro inesperado.'
          }
        },
        concurrent_operation: {
          title: {
            en: 'Concurrent Operation',
            es: 'Operación Concurrente',
            pt: 'Operação Concorrente'
          },
          message: {
            en: 'Another operation is in progress.',
            es: 'Otra operación está en progreso.',
            pt: 'Outra operação está em andamento.'
          }
        },
        daily_limit_reached: {
          title: {
            en: 'ChatterPay: Daily Limit Reached 🌟',
            es: 'ChatterPay: Límite diario alcanzado 🌟',
            pt: 'ChatterPay: Limite diário atingido 🌟'
          },
          message: {
            en: "You've reached the maximum number of daily operations allowed for this type of transaction. Please try again tomorrow. 🙌",
            es: 'Has alcanzado la cantidad máxima diaria permitida para este tipo de operación. Por favor, inténtalo nuevamente mañana. 🙌',
            pt: 'Você atingiu a quantidade máxima diária permitida para esse tipo de operação. Por favor, tente novamente amanhã. 🙌'
          }
        },
        amount_outside_limits: {
          title: {
            en: 'ChatterPay - Operation Outside Limits 🚫',
            es: 'ChatterPay - Operación fuera de los límites 🚫',
            pt: 'ChatterPay - Operação fora dos limites 🚫'
          },
          message: {
            en: "The amount you're trying to operate is outside the limits of this operation (min: [LIMIT_MIN], max: [LIMIT_MAX]). Please try again with a valid amount. 🙅‍♂️",
            es: 'El monto que intentas operar está fuera de los límites de esta operación (min: [LIMIT_MIN], max: [LIMIT_MAX]). Por favor, inténtalo nuevamente con un monto válido. 🙅‍♂️',
            pt: 'O valor que você está tentando operar está fora dos limites desta operação (min: [LIMIT_MIN], max: [LIMIT_MAX]). Tente novamente com um valor válido. 🙅‍♂️'
          }
        }
      }
    };

    const template = new TemplateType(validTemplate);
    const savedTemplate = await template.save();

    expect(savedTemplate._id).toBeDefined();
    expect(savedTemplate.notifications.transfer.title.en).toBe('Transfer completed');
  });

  it('should fail to save without required fields', async () => {
    type PartialNotifications = Partial<{
      [key in NotificationEnum]: Partial<NotificationTemplateType>;
    }>;

    type TestTemplateSchema = Omit<ITemplateSchema, 'notifications'> & {
      notifications?: PartialNotifications;
    };

    const invalidTemplate = {
      notifications: {
        transfer: {
          title: {
            en: 'Transfer completed',
            es: 'Transferencia completada',
            pt: 'Transferência concluída'
          }
          // missing message field
        }
      }
    } as TestTemplateSchema;

    const template = new TemplateType(invalidTemplate);

    await expect(template.save()).rejects.toThrow(mongoose.Error.ValidationError);
  });
});
