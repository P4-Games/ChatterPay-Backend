# Cardano — opciones de fees

Todo medido con el builder del repo, parámetros reales de Preprod (`minFeeA=44`, `minFeeB=155381`,
`coinsPerUtxoByte=4310`), base addresses. ADA = **USD 0.1735**.

La pregunta que ordena todo el documento: **¿cuánto tiene que tener una wallet de Cardano para poder
transferir?**

## Constantes

| | ADA | USD |
|---|---|---|
| min-ADA de un output (solo ADA) | 0.969750 | 0.168 |
| min-ADA de un output (llevando USDCx) | 1.155080 | 0.200 |
| fee de red, transferencia de ADA | 0.168229 | 0.029 |
| fee de red, transferencia de USDCx | 0.172013 | 0.030 |
| fee de red, con input de ChatterPay | 0.172673 | 0.030 |
| fee ChatterPay 0.08 USD | 0.461100 | 0.080 |

El **min-ADA no es un cargo**: es el piso del ledger para cualquier UTxO y esa plata queda en poder
del destinatario. Un output por debajo de ese piso no se rechaza solo — tumba la transacción entera.

**Un token nunca viaja solo.** El output que lleva USDCx necesita ADA adjunta (1.155080), que sale
del emisor y la recibe el destinatario. Y si el emisor manda **parte** de su USDCx, su propio vuelto
también carga token, así que necesita min-ADA otra vez: **el piso se paga dos veces**.

---

## A) ChatterPay no cubre fee de red y tampoco cobra fee

### Mínimo en la wallet

| Para transferir | Mínimo |
|---|---|
| ADA | **1.135119 ADA** |
| USDCx, mandando **todo** el token | **1.322341 ADA** + el token |
| USDCx, mandando **parte** del token | **2.482173 ADA** + el token |

### El caso límite, ADA

**userA => (0.969750 ADA) userB**

| | antes | después |
|---|---|---|
| balance A | 1.135119 ADA | **0** |
| balance B | 0 | **0.969750 ADA** |

fee red: 0.165369 — lo paga A. La wallet queda vacía: no hay saldo inmovilizado.

### El caso límite, USDCx

**userA => (10 USDCx, todo) userB**

| | antes | después |
|---|---|---|
| balance A | 10 USDCx + 1.322341 ADA | **0** |
| balance B | 0 | **10 USDCx + 1.155080 ADA** |

fee red: 0.167261 — lo paga A.

> Un usuario con USDCx y **cero ADA no puede transferir**.

---

## B) ChatterPay no cubre fee de red y cobra fee por la transferencia

### Mínimo en la wallet

| Para transferir | Mínimo |
|---|---|
| ADA | **1.135119 ADA** |
| USDCx, mandando **todo** el token | **1.322341 ADA** + el token |
| USDCx, mandando **parte** del token | **2.482173 ADA** + el token |
| ADA, en la transferencia donde se cobra | **~2.53 ADA** |

Los mínimos son los mismos que en A: el fee de ChatterPay no se cobra en cada transferencia.

### El caso límite, ADA

**userA => (0.969750 ADA) userB**

| | antes | después |
|---|---|---|
| balance A | 1.135119 ADA | **0** + deuda de 0.461100 ADA |
| balance B | 0 | **0.969750 ADA** |

> **Nota:** el fee adeudado del usuario A **se tiene que acumular**, dado el mínimo que requiere la
> red. 0.461100 ADA está por debajo del min-ADA (0.969750), así que un output de 0.08 USD es
> **inválido** y hace fallar la transacción entera.
>
> Recién a la **3ª** transferencia lo acumulado (1.383300 ADA) supera el mínimo y se puede cobrar,
> montado como un tercer output en la transferencia que el usuario ya está haciendo — sin necesidad
> de una transacción aparte ni de otro fee de red. Esa transferencia le sube el mínimo requerido a
> ~2.53 ADA.
>
> Queda por definir qué pasa con la deuda de un usuario que deja de transferir.

---

## C) ChatterPay cubre fee de red y cobra fee por la transferencia

### Mínimo en la wallet

| Para transferir | Mínimo |
|---|---|
| ADA | **0.969750 ADA** — solo el monto |
| USDCx, mandando **todo** el token | **0** |
| USDCx, mandando **parte** del token | **0** |

### El caso límite, ADA

**userA => (0.969750 ADA) userB**

| | antes | después |
|---|---|---|
| balance A | 0.969750 ADA | **0** + deuda de 0.461100 ADA |
| balance B | 0 | **0.969750 ADA** |

fee red: 0.172673 — **lo paga ChatterPay** (USD 0.030 por transferencia).

### El caso límite, USDCx

**userA => (5 USDCx, la mitad) userB**

| | antes | después |
|---|---|---|
| balance A | 10 USDCx + **0 ADA** | **5 USDCx + 1.155080 ADA** + deuda de 0.461100 ADA |
| balance B | 0 | **5 USDCx + 1.155080 ADA** |

A cargo de ChatterPay: el fee de red más los dos min-ADA (uno para el destinatario, otro para el
vuelto que carga el token restante), ~2.48 ADA. De eso **2.310160 quedan en poder de los dos
usuarios** — no se pierde, vuelve al circuito cuando lo gastan. El costo real es el fee: USD 0.030.

> Funciona porque una transacción de Cardano acepta inputs de **varias addresses** y solo pide la
> firma de cada dueño. ChatterPay ya firma por el usuario, así que sumar su input no cambia el modelo
> de confianza. Cuesta 0.004444 ADA más de fee que sin él.
>
> Requiere una wallet de Cardano de ChatterPay con saldo, monitoreada y recargable.

---

## Comparación — mínimo en la wallet

| Para transferir | A | B | C |
|---|---|---|---|
| ADA | 1.135119 | 1.135119 (~2.53 al cobrar) | **0.969750** |
| USDCx, todo el token | 1.322341 | 1.322341 | **0** |
| USDCx, parte del token | 2.482173 | 2.482173 | **0** |
| Costo para ChatterPay por transferencia | 0 | 0 | USD 0.030 |

---

## Notas

**Babel fees.** No se puede cubrir el fee con otro token de la red de Cardano: tiene que ser todo
con ADA. Se discute hace tiempo, pero no se ponen de acuerdo. No está en mainnet y no conviene
contar con eso.

**Ventana de dust.** En A y en B, si el vuelto del emisor queda entre 0 y 0.969750 ADA no puede ser
un UTxO propio y se quema como fee. Con 3.49 ADA en la wallet:

```
  mando 2.300   fee 0.16823   queda 1.02656
  mando 2.400   fee 1.09478   queda 0.00000   <-- se comió 0.925 ADA
  mando 3.000   fee 0.49478   queda 0.00000   <-- se comió 0.325 ADA
  mando 3.325   fee 0.17025   queda 0.00000   <-- vacía limpio
```

La ventana mide siempre lo mismo, ~1.14 ADA, y está pegada justo debajo de "mandar todo". No hay
saldo inmovilizado: la wallet se puede vaciar entera. Se evita validando el monto antes de firmar y
ofreciendo "mandar todo" como monto válido.

**Depósito de staking.** Los ~2 ADA que se suelen mencionar son el depósito de registro de la stake
key, y solo aplican si se registra la wallet para staking. Las base addresses sin registrar no lo
pagan. Es reembolsable al des-registrar.

**Crear una wallet no cuesta nada.** Cardano no tiene creación de cuenta, ni rent, ni depósito
mínimo. Verificado: transferir a una address que no existía costó exactamente el mismo fee
(0.168405 ADA) que transferir a una ya usada.
