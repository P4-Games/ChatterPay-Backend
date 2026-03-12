import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  type ITemplateSchema,
  type NotificationEnum,
  type NotificationTemplateType,
  TemplateType
} from '../../src/models/templateModel';

describe('Template Model', () => {
  it('should create and save a Template document successfully', async () => {
    type TestTemplateSchema = Partial<ITemplateSchema>;

    const validTemplate: TestTemplateSchema = {
      notifications: {
        incoming_transfer: {
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
        incoming_transfer_w_note: {
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
        incoming_transfer_external: {
          title: {
            en: 'External Transfer completed',
            es: 'Transferencia externa completada',
            pt: 'Transferência exerna concluída'
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
        wallet_already_exists: {
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
        },
        aave_supply_created: {
          title: {
            en: 'Chatterpay: Savings created successfully!',
            es: 'Chatterpay: ✅ Ahorro creado con éxito',
            pt: 'Chatterpay: Poupança criada com sucesso!'
          },
          message: {
            en: '✅ You have successfully deposited [AMOUNT] [TOKEN] to start earning interest! 🎉\n\nCheck the transaction details here: [EXPLORER]/tx/[TX_HASH]',
            es: '✅ ¡Has depositado correctamente [AMOUNT] [TOKEN] para empezar a generar intereses! 🎉\n\nPodés ver los detalles de la transacción aquí:\n[EXPLORER]/tx/[TX_HASH]',
            pt: '✅ Você depositou [AMOUNT] [TOKEN] com sucesso para começar a ganhar juros! 🎉\n\nConfira os detalhes da transação aqui:\n[EXPLORER]/tx/[TX_HASH]'
          }
        },
        aave_supply_info: {
          title: {
            en: 'Chatterpay: Your Savings Info',
            es: 'Chatterpay: 💰 Información de tu Ahorro',
            pt: 'Chatterpay: Informações da sua Poupança'
          },
          message: {
            en: '📊 Current savings status:\n• Deposited amount: [ATOKEN_BALANCE] [ATOKEN_SYMBOL]\n• Annual interest rate (APY): [SUPPLY_APY]%\n\n✨ Your funds keep earning interest automatically.',
            es: '📊 Estado actual de tu ahorro:\n• Monto depositado: [ATOKEN_BALANCE] [ATOKEN_SYMBOL]\n• Tasa de interés anual (APY): [SUPPLY_APY]%\n\n✨ Tu dinero sigue generando intereses automáticamente.',
            pt: '📊 Status atual da sua poupança:\n• Quantia depositada: [ATOKEN_BALANCE] [ATOKEN_SYMBOL]\n• Taxa de juros anual (APY): [SUPPLY_APY]%\n\n✨ Seu dinheiro continua gerando juros automaticamente.'
          }
        },
        aave_supply_info_no_data: {
          title: {
            en: 'Chatterpay: Your Savings Info',
            es: 'Chatterpay: 💰 Información de tu Ahorro',
            pt: 'Chatterpay: Informações da sua Poupança'
          },
          message: {
            en: 'ℹ️ We couldn’t find information about your savings at this moment.',
            es: 'ℹ️ No encontramos información de tu ahorro en este momento.',
            pt: 'ℹ️ Não encontramos informações da sua poupança neste momento.'
          }
        },
        aave_supply_modified: {
          title: {
            en: 'Chatterpay: Savings withdrawal completed',
            es: 'Chatterpay: ✅ Retiro de ahorro completado',
            pt: 'Chatterpay: Retirada de poupança concluída'
          },
          message: {
            en: '✅ You successfully withdrew [AMOUNT] [TOKEN] from your interest-bearing account. 🎉\n\nCheck the transaction details here:\n[EXPLORER]/tx/[TX_HASH]',
            es: '✅ Has retirado correctamente [AMOUNT] [TOKEN] de tu cuenta con intereses. 🎉\n\nPodés ver los detalles de la transacción aquí:\n[EXPLORER]/tx/[TX_HASH]',
            pt: '✅ Você retirou com sucesso [AMOUNT] [TOKEN] da sua conta com juros. 🎉\n\nConfira os detalhes da transação aqui:\n[EXPLORER]/tx/[TX_HASH]'
          }
        },
        chatterpoints_operation: {
          title: {
            en: 'ChatterPay: You earned ChatterPoints! 🎯',
            es: 'ChatterPay: ¡Ganaste ChatterPoints! 🎯',
            pt: 'ChatterPay: Você ganhou ChatterPoints! 🎯'
          },
          message: {
            en: 'Con esta operación sumaste [POINTS] ChatterPoints! 🥳',
            es: '¡Con esta operación sumaste [POINTS] ChatterPoints! 🥳',
            pt: 'Com esta operação você ganhou [POINTS] ChatterPoints! 🥳'
          }
        },
        cross_chain_disabled: {
          title: {
            en: 'Cross-chain transfers disabled',
            es: 'Transferencias cross-chain deshabilitadas',
            pt: 'Transferências cross-chain desativadas'
          },
          message: {
            en: 'Cross-chain transfers are currently disabled.',
            es: 'Las transferencias cross-chain están actualmente deshabilitadas.',
            pt: 'As transferências cross-chain estão atualmente desativadas.'
          }
        },
        polymarket_account_created: {
          title: {
            en: 'Polymarket Account Created',
            es: 'Cuenta de Polymarket Creada',
            pt: 'Conta Polymarket Criada'
          },
          message: {
            en: 'Your Polymarket account has been created.',
            es: 'Tu cuenta de Polymarket fue creada.',
            pt: 'Sua conta Polymarket foi criada.'
          }
        },
        polymarket_order_placed: {
          title: { en: 'Order Placed', es: 'Orden Ejecutada', pt: 'Ordem Colocada' },
          message: {
            en: 'Your order has been placed.',
            es: 'Tu orden fue ejecutada.',
            pt: 'Sua ordem foi colocada.'
          }
        },
        polymarket_order_cancelled: {
          title: { en: 'Order Cancelled', es: 'Orden Cancelada', pt: 'Ordem Cancelada' },
          message: {
            en: 'Your order has been cancelled.',
            es: 'Tu orden fue cancelada.',
            pt: 'Sua ordem foi cancelada.'
          }
        },
        polymarket_order_failed: {
          title: { en: 'Order Failed', es: 'Orden Fallida', pt: 'Ordem Falhou' },
          message: {
            en: 'Your order could not be placed.',
            es: 'Tu orden no pudo ser ejecutada.',
            pt: 'Sua ordem não pôde ser colocada.'
          }
        },
        polymarket_terms_not_accepted: {
          title: {
            en: 'Terms Not Accepted',
            es: 'Términos No Aceptados',
            pt: 'Termos Não Aceitos'
          },
          message: {
            en: 'Accept terms before trading.',
            es: 'Aceptá los términos antes de operar.',
            pt: 'Aceite os termos antes de negociar.'
          }
        },
        polymarket_account_not_found: {
          title: {
            en: 'No Polymarket Account',
            es: 'Sin Cuenta de Polymarket',
            pt: 'Sem Conta Polymarket'
          },
          message: {
            en: 'Create an account first.',
            es: 'Creá una cuenta primero.',
            pt: 'Crie uma conta primeiro.'
          }
        },
        polymarket_bridge_initiated: {
          title: { en: 'Bridge Initiated', es: 'Puente Iniciado', pt: 'Ponte Iniciada' },
          message: {
            en: 'Bridging USDC to Polygon.',
            es: 'Transfiriendo USDC a Polygon.',
            pt: 'Transferindo USDC para Polygon.'
          }
        },
        polymarket_disabled: {
          title: {
            en: 'Polymarket Unavailable',
            es: 'Polymarket No Disponible',
            pt: 'Polymarket Indisponível'
          },
          message: {
            en: 'Polymarket is currently disabled.',
            es: 'Polymarket está deshabilitado.',
            pt: 'Polymarket está desativado.'
          }
        }
      }
    };

    const template = new TemplateType(validTemplate);
    const savedTemplate = await template.save();

    expect(savedTemplate._id).toBeDefined();
    expect(savedTemplate.notifications.incoming_transfer.title.en).toBe('Transfer completed');

    expect(savedTemplate.notifications.aave_supply_created.title.es).toBe(
      'Chatterpay: ✅ Ahorro creado con éxito'
    );
    expect(savedTemplate.notifications.aave_supply_info.message.es).toContain(
      'Estado actual de tu ahorro'
    );
    expect(savedTemplate.notifications.aave_supply_modified.title.es).toBe(
      'Chatterpay: ✅ Retiro de ahorro completado'
    );
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
        incoming_transfer: {
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
