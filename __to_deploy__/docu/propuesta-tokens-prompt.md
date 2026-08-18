# Costo de tokens del prompt del bot: diagnóstico y plan

**Fecha:** 2026-08-17
**Repo que hay que tocar:** `C:\develop\bot\ChatBot-WhatsappOpenIA` (**no** el backend — este archivo vive acá sólo porque es donde llevamos el registro de cambios operativos)
**Origen:** salió de habilitar Cardano en el bot; la sección de Cardano del prompt no llegaba al modelo porque el prompt se recorta a 1.800 caracteres
**Relacionado:** [cambios.md](./cambios.md) — sección `Database changes (bot)`

> **Nada de esto está aplicado.** Es un diagnóstico con números medidos y un plan. Lo único que sí
> se tocó fue `MAX_BASE_PROMPT_CHARS=120000` en el `.env` local del bot, **como valor de prueba para
> poder testear Cardano** — no es una recomendación y hay que reemplazarlo por un número decidido.

---

## 1. El problema, en una línea

Cada llamada al LLM manda **~25.000 tokens de prompt**, se repite en cada turno, y un turno con dos
tool calls cuesta tres veces eso (~75.000 tokens medidos).

## 2. Cómo se arma el prompt (contexto necesario para entender el resto)

El system prompt **se reconstruye en cada request**, no una vez por conversación:

```
app/managers/chat.py :: ChatManager.clean_messages_for_completion()
  ├─ DbManager.get_chat_functions()          -> colección `chat_functions` (32 docs)
  ├─ select_all_tools(enabled)               -> app/handlers/open_ai_tools/tool_selection.py
  ├─ compact_tool_schema(t) por cada una     -> idem
  ├─ DbManager.get_chat_modes()              -> `chat_modes`, el doc con `date` más grande
  └─ PromptBuilder.build_system_prompt(...)  -> app/managers/prompt_builder.py
        ├─ base   = chat_modes.default.start_system_message
        │           recortado a MAX_BASE_PROMPT_CHARS  (default 1800)
        ├─ hints  = "Available tools (hints):\n" + una línea por tool
        │           (MAX_TOOL_HINTS=50, MAX_TOOL_HINT_CHARS_PER_TOOL=280)
        └─ total  recortado a MAX_SYSTEM_PROMPT_CHARS (default 5000)
```

Los schemas de las tools viajan **además** en el parámetro `tools` de la API de OpenAI.

**Detalle que importa:** `_truncate` corta y **no avisa**. Así fue como el 98% de un prompt que se
mantiene activamente quedó muerto sin que nadie lo notara.

## 3. Números medidos

Contra la base local `chatbot-chatterpay-develop` y los logs reales del bot, el 2026-08-17:

| Pieza | Chars | Tokens aprox. |
|---|---|---|
| `chat_modes.default.start_system_message` | 94.219 | ~23.550 |
| Bloque "Available tools (hints)" (dentro del system prompt) | 8.273 | ~2.070 |
| Schemas en el parámetro `tools` (32 tools, ya compactados) | 11.509 | ~2.880 |

Medición directa de `prompt_tokens` en los logs del bot:

| Configuración | Turno simple | 1 tool call | 2 tool calls |
|---|---|---|---|
| `MAX_BASE_PROMPT_CHARS=1800` (default) | ~2.800 | — | — |
| `MAX_BASE_PROMPT_CHARS=120000` (prueba) | **24.953** | 49.886 | 74.829 |

**Cruce que confirma la descomposición:** con el default de 1.800, los ~2.800 tokens salen de 1.800
chars de prompt (~450 tokens) + el bloque de hints (~2.070) + historial. Es decir que **antes de
tocar nada, el 74% de lo que se pagaba por turno ya era el bloque de hints**, no el prompt.

### Dónde está la grasa del prompt

| Sección | Chars | % del prompt |
|---|---|---|
| `### Examples of ChatterPoints / Games / Social Media Flows` | 19.133 | **20,3%** |
| `### Tool Call Rules` | 7.470 | 7,9% |
| `### Education on Smartphone Security` | 6.528 | 6,9% |
| `### ADD CHATTERPOINTS / GAMES / OPERATIONS / SOCIAL MEDIA` | 6.139 | 6,5% |
| `## Available Tools and Functions` | 5.147 | 5,5% |
| `### Education on WhatsApp Security` | 4.506 | 4,8% |
| `### Important Rules` | 4.298 | 4,6% |
| `### Quick Reply / Button Tap Pre-Parsing` | 4.079 | 4,3% |
| `### CARDANO / ADA` | 3.513 | 3,7% |

Repeticiones: `chatterpoints` aparece 64 veces, `enviar_url` 35, `dev.chatterpay.net` 25,
`Depósito rápido` 15.

### Cómo reproducir la medición

```bash
# 1. Volcar el prompt activo
mongosh "mongodb://<host>:27017/chatbot-chatterpay-develop" --quiet --eval \
  'print(db.chat_modes.find().sort({date:-1}).limit(1).next().default.start_system_message)' > prompt.txt

# 2. Tamaño por sección
python3 - <<'PY'
import re
s = open('prompt.txt', encoding='utf-8').read()
print(f"total: {len(s):,} chars (~{len(s)//4:,} tokens)")
parts = re.split(r'(?m)^(#{1,3} .*)$', s)
rows = sorted(((len(parts[i]) + len(parts[i+1]), parts[i].strip())
               for i in range(1, len(parts), 2)), reverse=True)
for n, t in rows[:15]:
    print(f"  {n:7,}  {100*n/len(s):5.1f}%  {t[:70]}")
PY

# 3. Tokens reales, del log del bot
grep -aoE "'prompt_tokens': [0-9]+" bot.log | tail -20
```

---

## 4. Plan, ordenado por relación beneficio/riesgo

### Paso 1 — Sacar el bloque de hints duplicado ⭐ empezar por acá

**Qué pasa hoy:** las tools ya viajan en el parámetro `tools` de la API. El system prompt además
agrega una línea de "pista" por cada una. Son ~2.070 tokens por llamada de información que el modelo
ya tiene, en un formato peor.

**Cómo:** una variable de entorno, **sin tocar código**.

```
MAX_TOOL_HINTS=0
```

**Por qué funciona:** `_build_tool_hints` hace `tool_list[:max_tools]`; con 0 la lista queda vacía,
devuelve `""`, y en `build_system_prompt` el `if tool_hints:` es falso, así que el bloque no se
agrega. Verificado leyendo `prompt_builder.py:152-173`.

**Variante intermedia**, si alguien quiere conservar los nombres pero no las descripciones:
`MAX_TOOL_HINT_CHARS_PER_TOOL=0` deja `- nombre_de_la_tool` por línea (32 líneas, ~200 tokens).

| | |
|---|---|
| Ahorro | ~2.070 tokens por llamada (~6.200 en un turno con 2 tool calls) |
| Esfuerzo | una variable de entorno |
| Riesgo | **ninguno** — no se pierde información, sólo deja de mandarse dos veces |
| Verificación | `grep "'prompt_tokens'" bot.log` antes y después; y probar que las tools se siguen llamando (transferir, balance, wallet) |

### Paso 2 — Mover el contenido educativo a `kb_articles`

`### Education on Smartphone Security` (6.528) y `### Education on WhatsApp Security` (4.506) son
11.034 caracteres de texto estático que se manda en **todas** las llamadas, para responder algo que
el usuario pregunta muy de vez en cuando.

La colección `kb_articles` ya existe (95 documentos en `chatterpay-develop`) y ya hay mecanismo de
recuperación. Mover esas dos secciones ahí y dejar en el prompt una línea que diga cuándo consultarla.

| | |
|---|---|
| Ahorro | ~2.750 tokens por llamada |
| Esfuerzo | bajo — mover texto, agregar 1-2 renglones al prompt |
| Riesgo | bajo — si la recuperación falla, el bot responde peor una consulta poco frecuente, no rompe una operación |
| Verificación | preguntarle al bot algo de seguridad del teléfono y confirmar que sigue contestando bien |

### Paso 3 — Cargar los ejemplos de juegos sólo cuando hacen falta

`### Examples of ChatterPoints / Games / Social Media Flows` son **19.133 caracteres, el 20% del
prompt**, y son ejemplos few-shot de Wordle/Ahorcado/misiones sociales. Una conversación sobre una
transferencia los paga completos sin usarlos.

Opción A: moverlos a `kb_articles` y recuperarlos por intención.
Opción B: usar el parámetro `chat_mode` que `build_system_prompt` ya recibe, y tener un modo `games`
con esa sección y un `default` sin ella.

> La opción B es la que menos código nuevo necesita: `_extract_base_prompt_from_chat_modes` ya busca
> `chat_modes_doc[chat_mode]["start_system_message"]` y cae a `default` si no existe. O sea que
> **agregar una clave hermana de `default` en el documento de `chat_modes` ya funciona**; lo que
> falta es quién decide el `chat_mode` por turno.

| | |
|---|---|
| Ahorro | ~4.800 tokens por llamada |
| Esfuerzo | medio |
| Riesgo | medio — si la detección de intención falla, el bot juega peor. No toca plata |
| Verificación | jugar una partida de Wordle completa y una de Ahorcado |

### Paso 4 — Selección de tools por turno ⚠️

`select_tools_for_turn` **ya está escrita** en `tool_selection.py` y **no se usa**:
`clean_messages_for_completion` llama `select_all_tools`. Alguien la escribió exactamente para esto.

| | |
|---|---|
| Ahorro | hasta ~2.000 tokens por llamada |
| Esfuerzo | bajo (cambiar una llamada) |
| Riesgo | **el más alto de la lista** |
| Verificación | no alcanza con probar a mano |

> ⚠️ **Por qué el riesgo es alto aunque el cambio sea de una línea.** Si el scoring falla en un
> turno, el modelo se queda sin la herramienta que necesitaba y el síntoma es "el bot a veces no sabe
> hacer X" — intermitente, difícil de reproducir, y perfectamente capaz de tocar el camino de una
> transferencia. Antes de activarlo hace falta una medición sobre conversaciones reales:
> ¿en qué porcentaje de turnos la tool que efectivamente se llamó estaba en el subconjunto elegido?
> Mientras esa respuesta no sea ~100%, no se activa.

### Paso 5 — Partir el prompt en núcleo + secciones por intención

El arreglo estructural: un núcleo chico siempre presente (identidad, reglas de seguridad, formato) y
secciones que se cargan según de qué se esté hablando.

| | |
|---|---|
| Ahorro | ~15.000 tokens por llamada |
| Esfuerzo | alto |
| Riesgo | alto — es reescribir el prompt |
| Cuándo | sólo si después de 1-3 el número todavía no alcanza |

### Paso 6 — Historial

`OPENAI_HISTORY_LAST_N=10` (`chat.py`, en `clean_messages_for_completion`). Bajarlo a 6 ahorra poco
frente a 23.000 tokens, pero es gratis. Ojo: el historial es lo que le da continuidad a una
confirmación de transferencia ("sí, confirmo" tiene que poder mirar hacia atrás), así que no bajar de
6 sin probar ese flujo.

---

## 5. Resultado esperado

| Escenario | Tokens por llamada |
|---|---|
| Hoy, con el valor de prueba | ~25.000 |
| Con pasos 1 + 2 | ~20.000 |
| Con pasos 1 + 2 + 3 | **~14.000** |
| Con paso 5 además | ~9.000 |

Los pasos 1 a 3 no pierden ninguna regla del prompt: mueven contenido de "siempre" a "cuando hace
falta".

---

## 6. Dos cosas que no son ahorro pero hay que hacer igual

### 6.1 No romper el caché de prefijo de OpenAI

El system prompt es hoy un prefijo **estable y determinístico** (los hints se ordenan por nombre), así
que después de la primera llamada la mayor parte se factura como input cacheado, más barato. Es un
descuento, no gratis, y el caché expira con pocos minutos de inactividad.

> ⚠️ **La regla a respetar en cualquier cambio futuro: nada variable dentro del system prompt.** Si
> alguna vez se inyecta ahí un nombre de usuario, una fecha, un saldo o un id de conversación, el
> caché se invalida entero y se vuelve a pagar el prompt completo en cada turno. Lo dinámico va como
> mensaje aparte al final, nunca en el medio del prefijo.

### 6.2 Que el recorte deje de ser silencioso

Independientemente del número que se elija para `MAX_BASE_PROMPT_CHARS`, hoy `_truncate`
(`prompt_builder.py:40-47`) corta y no dice nada. **Así fue como el 98% de un prompt que se mantiene
activamente quedó muerto sin que nadie lo notara, y así va a volver a pasar cuando el prompt vuelva a
crecer.**

Dos líneas en `build_system_prompt`, antes del `_truncate`:

```python
if len(base) > cls.max_base_prompt_chars():
    logger.warning(
        "PromptBuilder :: base prompt truncated: %d of %d chars discarded",
        len(base) - cls.max_base_prompt_chars(), len(base),
    )
```

Convierte un fallo invisible en uno evidente. Es el cambio más barato de toda la lista y
probablemente el más valioso a largo plazo.

---

## 7. Qué NO hacer

- **No dejar `MAX_BASE_PROMPT_CHARS=120000`.** Es el valor de prueba que se puso para testear
  Cardano. Cuando el prompt esté recortado, fijarlo un poco arriba de su tamaño real: así nunca
  trunca en silencio, pero avisa (con §6.2) cuando el prompt se pasa del presupuesto.
- **No volver a 1.800.** Cualquier regla más allá del carácter 1.800 —incluida toda la sección de
  Cardano, que arranca cerca del 70.000— es inerte. Eso ya se comprobó: con el default, el bot
  respondía que las transferencias de ADA no estaban habilitadas.
- **No activar el paso 4 sin medirlo** (ver la advertencia ahí).
- **No meter valores dinámicos en el system prompt** (§6.1).

## 8. Estado actual del entorno local

| | |
|---|---|
| `.env` del bot | `MAX_BASE_PROMPT_CHARS=120000` y `MAX_SYSTEM_PROMPT_CHARS=200000` agregados el 2026-08-17 |
| Backup | `.env.bak-2026-08-17-cardano` en la carpeta del bot |
| `chat_modes` activo | `6a833b9cc595f145b4544ca7`, 2026-08-17, 94.288 chars, con la sección de Cardano |
| Base | `chatbot-chatterpay-develop` (local) |

Para volver al comportamiento anterior alcanza con borrar las dos líneas `MAX_*` del `.env`. Eso
apaga la sección de Cardano del prompt junto con todo lo demás pasado el carácter 1.800.
