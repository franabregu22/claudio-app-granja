# AGENTS.md — Granja Santo Tomás

## PRINCIPIO GENERAL

Prioridad: RESOLVER, no explorar indefinidamente.

Este proyecto se trabaja de forma incremental y controlada.
Cuando una arquitectura, decisión o fase está marcada como FROZEN,
se considera autoridad y no debe reabrirse salvo que exista una
contradicción real que impida continuar.

---

## MODO DE TRABAJO

1. Cuando recibas una tarea concreta:
   - inspeccioná los archivos necesarios;
   - ejecutá la tarea;
   - verificá el resultado;
   - terminá.

2. No conviertas una tarea de corrección en una nueva auditoría general.

3. No abras nuevas líneas de investigación fuera del alcance solicitado.

4. No generes agentes o subagentes salvo que el usuario lo solicite
   explícitamente o la tarea indique expresamente que deben utilizarse.

5. No postergues una corrección conocida a una futura "pass" si puede
   resolverse dentro de la tarea actual.

6. Si encontrás un problema directamente necesario para completar la
   tarea actual, resolvelo en la misma ejecución.

7. Si encontrás un problema NO relacionado con la tarea actual:
   mencionarlo brevemente al final, pero no expandir el alcance.

8. Si existen varias soluciones técnicamente válidas y ninguna cambia
   una decisión funcional congelada, elegí la solución más simple,
   robusta y consistente con el proyecto.

9. No pedir decisión al owner por detalles puramente técnicos que puedan
   resolverse sin alterar reglas de negocio.

10. Escalar una decisión al owner solamente cuando cambie:
    - comportamiento funcional;
    - reglas de negocio;
    - significado económico/contable;
    - permisos relevantes;
    - datos que serán autoridad;
    - alcance del producto.

---

## ARQUITECTURA CONGELADA

Los documentos marcados como FROZEN son autoridad.

No:
- reinterpretarlos innecesariamente;
- rediseñarlos durante implementación;
- agregar reglas de negocio no aprobadas;
- eliminar reglas congeladas;
- cambiar decisiones funcionales para simplificar código.

Si dos documentos congelados parecen contradecirse:
1. identificar la contradicción exacta;
2. detener solamente la parte afectada;
3. solicitar decisión si realmente cambia el dominio.

No detener trabajo no relacionado.

---

## CORRECCIONES

Cuando recibas una lista de errores o correcciones:

CORREGIR → VERIFICAR → TERMINAR.

No hacer:

AUDITAR → REDISEÑAR → AUDITAR → PROPONER OTRA PASS.

Una correction pass debe modificar los archivos correspondientes,
no limitarse a producir otro informe.

---

## AGENTES

No usar agentes por defecto.

Usarlos solamente cuando:
- el usuario los solicite explícitamente; o
- la tarea indique explícitamente qué agentes utilizar.

Para archivos o decisiones fuertemente acopladas, preferir que el
Codex principal mantenga la coherencia global.

No crear nuevos agentes para volver a revisar trabajo que ya fue
auditado salvo solicitud explícita.

---

## PRECISIÓN

No declarar que algo fue corregido sin verificar el contenido real.

No declarar PASS basándose en intención.

No declarar:
- COMPLETE;
- READY;
- FROZEN;
- 0 BLOCKERS;
- 0 HIGH;

sin comprobar los criterios correspondientes.

Si algo falla, indicar exactamente qué falla.

Evitar lenguaje ambiguo como:
- "debería estar";
- "parece correcto";
- "probablemente";
- "etc.";

cuando el estado pueda verificarse directamente.

---

## ALCANCE

Respetar estrictamente el alcance de cada tarea.

Si la tarea dice modificar 5 archivos:
- trabajar sobre esos 5 archivos;
- no iniciar tareas adicionales;
- no crear documentación paralela salvo necesidad explícita.

Si la tarea es diseño:
- no implementar.

Si la tarea es implementación:
- no rediseñar arquitectura congelada.

Si la tarea es auditoría:
- no modificar salvo autorización.

---

## VERIFICACIÓN

Antes de responder:

1. Confirmar que los archivos solicitados fueron realmente modificados.
2. Verificar los criterios de aceptación de la tarea actual.
3. Comprobar referencias relevantes entre archivos.
4. No abrir una nueva auditoría general.
5. No inventar trabajo futuro para evitar resolver trabajo actual.

Cuando sea posible, usar verificaciones mecánicas:
- búsquedas literales;
- tests;
- typecheck;
- lint;
- constraints;
- referencias de tablas/columnas;
- nombres de funciones;
- conteos reales.

Preferir evidencia verificable sobre afirmaciones generales.

---

## RESPUESTAS

Ser breve, preciso y determinante.

No producir informes extensos salvo que el usuario los solicite.

Formato de cierre por defecto:

MODIFICADO: sí / no

ARCHIVOS:
- ...

CRITERIOS:
- criterio 1: PASS / FAIL
- criterio 2: PASS / FAIL

BLOQUEOS REALES:
- ninguno
o
- descripción concreta

DECISIÓN DEL OWNER REQUERIDA:
- no
o
- decisión concreta

ESTADO:
COMPLETE / BLOCKED

---

## REGLA FINAL

No optimizar para demostrar cuánto se analizó.

Optimizar para avanzar el proyecto correctamente.

Cuando la tarea esté resuelta y verificada, TERMINAR.