import mongoose from 'mongoose';
import { expect, it } from 'vitest';

import {
  ITemplateSchema,
  NotificationEnum,
  NotificationTemplateType,
  TemplateType
} from '../../src/models/templateModel';

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
      pin_not_set: {
        title: {
          en: 'ChatterPay: Set your Security PIN',
          es: 'ChatterPay: Configurá tu PIN de seguridad',
          pt: 'ChatterPay: Defina seu PIN de segurança'
        },
        message: {
          en: 'Security PIN is not set. Please set it in your ChatterPay profile on the web dashboard.',
          es: 'Tu PIN de seguridad no está configurado. Configuralo en tu perfil de ChatterPay en el panel web.',
          pt: 'Seu PIN de segurança não está definido. Defina-o no seu perfil do ChatterPay no painel web.'
        }
      },
      pin_invalid_remaining_attempts: {
        title: {
          en: 'ChatterPay: Incorrect Security PIN',
          es: 'ChatterPay: PIN de seguridad incorrecto',
          pt: 'ChatterPay: PIN de segurança incorreto'
        },
        message: {
          en: 'Incorrect PIN. You have [REMAINING_ATTEMPTS] attempt(s) left.',
          es: 'PIN incorrecto. Te quedan [REMAINING_ATTEMPTS] intento(s).',
          pt: 'PIN incorreto. Você tem [REMAINING_ATTEMPTS] tentativa(s) restante(s).'
        }
      },
      pin_blocked: {
        title: {
          en: 'ChatterPay: Security PIN temporarily locked',
          es: 'ChatterPay: PIN de seguridad bloqueado temporalmente',
          pt: 'ChatterPay: PIN de segurança temporariamente bloqueado'
        },
        message: {
          en: 'Too many incorrect attempts. Your Security PIN is temporarily locked. Please try again later. (Unlocks at: [BLOCKED_UNTIL])',
          es: 'Demasiados intentos incorrectos. Tu PIN de seguridad quedó bloqueado temporalmente. Volvé a intentar más tarde. (Se desbloquea: [BLOCKED_UNTIL])',
          pt: 'Muitas tentativas incorretas. Seu PIN de segurança foi temporariamente bloqueado. Tente novamente mais tarde. (Desbloqueia em: [BLOCKED_UNTIL])'
        }
      },
      pin_verified_success: {
        title: {
          en: 'ChatterPay: Security PIN verified',
          es: 'ChatterPay: PIN de seguridad verificado',
          pt: 'ChatterPay: PIN de segurança verificado'
        },
        message: {
          en: 'PIN verified successfully.',
          es: 'PIN verificado correctamente.',
          pt: 'PIN verificado com sucesso.'
        }
      },
      pin_internal_error: {
        title: {
          en: 'ChatterPay: PIN verification failed',
          es: 'ChatterPay: Falló la verificación del PIN',
          pt: 'ChatterPay: Falha na verificação do PIN'
        },
        message: {
          en: 'PIN verification error: internal error',
          es: 'Error al verificar el PIN: error interno.',
          pt: 'Erro ao verificar o PIN: erro interno.'
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
      },
      polymarket_settlement_claimed: {
        title: {
          en: 'Settlement Claimed',
          es: 'Liquidación Reclamada',
          pt: 'Liquidação Reivindicada'
        },
        message: {
          en: 'Your sell has settled!',
          es: 'Tu venta se liquidó!',
          pt: 'Sua venda foi liquidada!'
        }
      },
      polymarket_terms_request: {
        title: {
          en: 'Polymarket Terms',
          es: 'Términos de Polymarket',
          pt: 'Termos da Polymarket'
        },
        message: {
          en: 'To place predictions on Polymarket you must accept their Terms of Service (v{0}). Read them at: {1}',
          es: 'Para realizar predicciones en Polymarket debes aceptar sus Términos de Servicio (v{0}). Léelos en: {1}',
          pt: 'Para fazer previsões no Polymarket você deve aceitar os Termos de Serviço (v{0}). Leia-os em: {1}'
        }
      },
      operation_in_progress: {
        title: {
          en: 'ChatterPay: Operation in progress',
          es: 'ChatterPay: Operación en proceso',
          pt: 'ChatterPay: Operação em andamento'
        },
        message: {
          en: 'The operation is being processed. We will notify you once it is completed or if any issues arise.',
          es: 'La operación está siendo procesada. Te notificaremos una vez que se complete o si surge algún inconveniente.',
          pt: 'A operação está sendo processada. Avisaremos você assim que for concluída ou se ocorrer algum problema.'
        }
      },
      cardano_amount_below_minimum: {
        title: {
          en: 'ChatterPay - Amount below the minimum',
          es: 'ChatterPay - Monto por debajo del mínimo',
          pt: 'ChatterPay - Valor abaixo do mínimo'
        },
        message: {
          en: 'The minimum you can send on Cardano is [MIN_AMOUNT] ADA. [NETWORK_MIN] of it is a network limit, not a ChatterPay one: below that, the transfer fails the whole transaction.',
          es: 'El mínimo que podés enviar en Cardano es [MIN_AMOUNT] ADA. De ese total, [NETWORK_MIN] ADA es un límite de la red y no de ChatterPay: por debajo de eso, la transferencia hace fallar toda la transacción.',
          pt: 'O mínimo que você pode enviar na Cardano é [MIN_AMOUNT] ADA. Desse total, [NETWORK_MIN] ADA é um limite da rede e não da ChatterPay: abaixo disso, a transferência faz toda a transação falhar.'
        }
      },
      cardano_insufficient_ada: {
        title: {
          en: 'ChatterPay - Insufficient balance',
          es: 'ChatterPay - Saldo insuficiente',
          pt: 'ChatterPay - Saldo insuficiente'
        },
        message: {
          en: 'Not enough balance. To send [AMOUNT] ADA you need [REQUIRED] ADA in your wallet and you have [HELD] ADA.',
          es: 'No te alcanza el saldo. Para enviar [AMOUNT] ADA necesitás [REQUIRED] ADA en tu wallet y tenés [HELD] ADA.',
          pt: 'Saldo insuficiente. Para enviar [AMOUNT] ADA você precisa de [REQUIRED] ADA na sua carteira e tem [HELD] ADA.'
        }
      },
      cardano_change_carries_tokens: {
        title: {
          en: 'ChatterPay - Maximum amount you can send',
          es: 'ChatterPay - Monto máximo que podés enviar',
          pt: 'ChatterPay - Valor máximo que você pode enviar'
        },
        message: {
          en: 'With [HELD] ADA you can send up to [MAX_AMOUNT] ADA. The rest has to stay in your wallet: it holds tokens, and the [CHANGE_FLOOR] ADA that carries them cannot leave with the transfer.',
          es: 'Con [HELD] ADA podés enviar hasta [MAX_AMOUNT] ADA. El resto tiene que quedarse en tu wallet: ahí hay tokens, y los [CHANGE_FLOOR] ADA que los transportan no pueden salir con la transferencia.',
          pt: 'Com [HELD] ADA você pode enviar até [MAX_AMOUNT] ADA. O resto precisa ficar na sua carteira: ela tem tokens, e os [CHANGE_FLOOR] ADA que os transportam não podem sair com a transferência.'
        }
      },
      cardano_change_below_floor: {
        title: {
          en: 'ChatterPay - Maximum amount you can send',
          es: 'ChatterPay - Monto máximo que podés enviar',
          pt: 'ChatterPay - Valor máximo que você pode enviar'
        },
        message: {
          en: 'With [HELD] ADA you can send up to [MAX_AMOUNT] ADA, or send it all ([ALL_AMOUNT] ADA). Between those two figures the change falls below the minimum the network requires ([CHANGE_FLOOR] ADA) and is lost.',
          es: 'Con [HELD] ADA podés enviar hasta [MAX_AMOUNT] ADA, o enviar todo ([ALL_AMOUNT] ADA). Entre esos dos montos, el vuelto queda por debajo del mínimo que exige la red ([CHANGE_FLOOR] ADA) y se pierde.',
          pt: 'Com [HELD] ADA você pode enviar até [MAX_AMOUNT] ADA, ou enviar tudo ([ALL_AMOUNT] ADA). Entre esses dois valores, o troco fica abaixo do mínimo exigido pela rede ([CHANGE_FLOOR] ADA) e é perdido.'
        }
      },
      cardano_token_needs_ada: {
        title: {
          en: 'ChatterPay - Not enough ADA to send the token',
          es: 'ChatterPay - Falta ADA para enviar el token',
          pt: 'ChatterPay - Falta ADA para enviar o token'
        },
        message: {
          en: 'Sending a Cardano token also takes ADA: the network requires the transfer to carry [ATTACHED] ADA attached. You need [REQUIRED] ADA in your wallet and you have [HELD] ADA.',
          es: 'Enviar un token de Cardano también consume ADA: la red exige que la transferencia lleve [ATTACHED] ADA adjuntos. Necesitás [REQUIRED] ADA en tu wallet y tenés [HELD] ADA.',
          pt: 'Enviar um token na Cardano também consome ADA: a rede exige que a transferência leve [ATTACHED] ADA anexados. Você precisa de [REQUIRED] ADA na sua carteira e tem [HELD] ADA.'
        }
      },
      cardano_token_needs_ada_keeping_rest: {
        title: {
          en: 'ChatterPay - Not enough ADA to send the token',
          es: 'ChatterPay - Falta ADA para enviar el token',
          pt: 'ChatterPay - Falta ADA para enviar o token'
        },
        message: {
          en: 'Sending a Cardano token also takes ADA: the network requires the transfer to carry [ATTACHED] ADA attached, and as much again for the change that keeps the rest of the token. You need [REQUIRED] ADA in your wallet and you have [HELD] ADA.',
          es: 'Enviar un token de Cardano también consume ADA: la red exige que la transferencia lleve [ATTACHED] ADA adjuntos, y otro tanto para el vuelto que conserva el resto del token. Necesitás [REQUIRED] ADA en tu wallet y tenés [HELD] ADA.',
          pt: 'Enviar um token na Cardano também consome ADA: a rede exige que a transferência leve [ATTACHED] ADA anexados, e outro tanto para o troco que mantém o restante do token. Você precisa de [REQUIRED] ADA na sua carteira e tem [HELD] ADA.'
        }
      },
      cardano_token_change_needs_ada: {
        title: {
          en: 'ChatterPay - Not enough ADA to send the token',
          es: 'ChatterPay - Falta ADA para enviar el token',
          pt: 'ChatterPay - Falta ADA para enviar o token'
        },
        message: {
          en: 'To send part of a token you have to keep the rest in your wallet, and the network requires [CHANGE_FLOOR] ADA to carry it. You have [HELD] ADA. Sending the whole balance needs none.',
          es: 'Para enviar una parte del token tenés que conservar el resto en tu wallet, y la red exige [CHANGE_FLOOR] ADA para transportarlo. Tenés [HELD] ADA. Enviar el saldo completo no requiere nada.',
          pt: 'Para enviar parte do token você precisa manter o resto na sua carteira, e a rede exige [CHANGE_FLOOR] ADA para transportá-lo. Você tem [HELD] ADA. Enviar o saldo completo não exige nada.'
        }
      },
      cardano_token_balance_not_enough: {
        title: {
          en: 'ChatterPay - Insufficient balance',
          es: 'ChatterPay - Saldo insuficiente',
          pt: 'ChatterPay - Saldo insuficiente'
        },
        message: {
          en: 'Not enough balance: you have [HELD] and you are trying to send [AMOUNT].',
          es: 'No te alcanza el saldo: tenés [HELD] y estás intentando enviar [AMOUNT].',
          pt: 'Saldo insuficiente: você tem [HELD] e está tentando enviar [AMOUNT].'
        }
      },
      cardano_amount_below_fee: {
        title: {
          en: 'ChatterPay - Amount below the minimum',
          es: 'ChatterPay - Monto por debajo del mínimo',
          pt: 'ChatterPay - Valor abaixo do mínimo'
        },
        message: {
          en: 'The amount has to be more than the [FEE] fee for this transfer, otherwise nothing would reach the destination.',
          es: 'El monto tiene que ser mayor a la comisión de [FEE] de esta transferencia; si no, no llegaría nada al destino.',
          pt: 'O valor precisa ser maior que a taxa de [FEE] desta transferência; caso contrário, nada chegaria ao destino.'
        }
      },
      cardano_sponsor_unavailable: {
        title: {
          en: 'ChatterPay - We could not process the transfer',
          es: 'ChatterPay - No pudimos procesar la transferencia',
          pt: 'ChatterPay - Não conseguimos processar a transferência'
        },
        message: {
          en: 'We could not process the transfer right now. Please try again in a few minutes.',
          es: 'No pudimos procesar la transferencia en este momento. Por favor, intentá de nuevo en unos minutos.',
          pt: 'Não conseguimos processar a transferência neste momento. Por favor, tente novamente em alguns minutos.'
        }
      },
      cardano_insufficient_funds: {
        title: {
          en: 'ChatterPay - Insufficient balance',
          es: 'ChatterPay - Saldo insuficiente',
          pt: 'ChatterPay - Saldo insuficiente'
        },
        message: {
          en: 'Your Cardano wallet does not have enough ADA for this transfer. Fund this address and try again: [ADDRESS]',
          es: 'Tu wallet de Cardano no tiene ADA suficiente para esta transferencia. Fondeá esta dirección y volvé a intentar: [ADDRESS]',
          pt: 'Sua carteira Cardano não tem ADA suficiente para esta transferência. Deposite neste endereço e tente novamente: [ADDRESS]'
        }
      },
      user_blocked: {
        title: {
          en: 'ChatterPay - Account suspended',
          es: 'ChatterPay - Cuenta suspendida',
          pt: 'ChatterPay - Conta suspensa'
        },
        message: {
          en: 'Your account was suspended after activity flagged as an attempt to attack the platform. Reach out through our support channels if you believe this is a mistake.',
          es: 'Tu cuenta fue suspendida tras detectar actividad identificada como un intento de ataque a la plataforma. Contactanos por los canales de soporte si creés que es un error.',
          pt: 'Sua conta foi suspensa após atividade identificada como uma tentativa de ataque à plataforma. Fale com o suporte se você acredita que é um engano.'
        }
      },
      wallet_not_created: {
        title: {
          en: 'ChatterPay: Wallet not created',
          es: 'ChatterPay: Wallet no creada',
          pt: 'ChatterPay: Carteira não criada'
        },
        message: {
          en: "A wallet linked to your phone number hasn't been created yet. Please create one to continue with the operation.",
          es: 'Aún no se creó una wallet vinculada a tu número de teléfono. Por favor, creá una para continuar con la operación.',
          pt: 'Uma carteira vinculada ao seu número de telefone ainda não foi criada. Por favor, crie uma para continuar com a operação.'
        }
      },
      wallet_creation_intro: {
        title: {
          en: 'Wallet Created!',
          es: '¡Billetera Creada!',
          pt: 'Carteira Criada!'
        },
        message: {
          en: 'Your wallet was successfully created and linked to your WhatsApp number!',
          es: '¡Tu wallet fue creada y vinculada a tu número de WhatsApp con éxito!',
          pt: 'Sua carteira foi criada e vinculada ao seu número do WhatsApp com sucesso!'
        }
      },
      wallet_already_exists_intro: {
        title: {
          en: 'Your Wallet',
          es: 'Tu Billetera',
          pt: 'Sua Carteira'
        },
        message: {
          en: 'You already have a wallet linked to your WhatsApp number.',
          es: 'Ya tienes una wallet vinculada a tu número de WhatsApp.',
          pt: 'Você já tem uma carteira vinculada ao seu número do WhatsApp.'
        }
      },
      deposit_from_other_networks: {
        title: {
          en: 'Deposit from other networks',
          es: 'Depositar desde otras redes',
          pt: 'Depositar de outras redes'
        },
        message: {
          en: 'Deposit from Ethereum, Bitcoin, Solana, Polygon, Arbitrum and more.',
          es: 'Depositá desde Ethereum, Bitcoin, Solana, Polygon, Arbitrum y más.',
          pt: 'Deposite de Ethereum, Bitcoin, Solana, Polygon, Arbitrum e mais.'
        },
        footer: {
          en: 'ChatterPay Beta',
          es: 'ChatterPay Beta',
          pt: 'ChatterPay Beta'
        },
        button: {
          en: 'Deposit Now',
          es: 'Depositar Ahora',
          pt: 'Depositar Agora'
        }
      },
      deposit_info_intro: {
        title: {
          en: 'Deposit Info',
          es: 'Información de Depósito',
          pt: 'Informações de Depósito'
        },
        message: {
          en: 'Deposit information message.',
          es: 'Mensaje de información de depósito.',
          pt: 'Mensagem de informações de depósito.'
        }
      },
      wallet_next_steps: {
        title: {
          en: 'What would you like to do?',
          es: '¿Qué te gustaría hacer?',
          pt: 'O que você gostaria de fazer?'
        },
        message: {
          en: 'Next steps message.',
          es: 'Mensaje de próximos pasos.',
          pt: 'Mensagem de próximos passos.'
        },
        footer: {
          en: 'ChatterPay',
          es: 'ChatterPay',
          pt: 'ChatterPay'
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
