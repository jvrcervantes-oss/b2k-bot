// Verifica el orden de prioridad de leadScore() extrayéndolo del panel real (sin duplicar lógica).
// Ejecutar: node qa/leadscore.test.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../panel.html', 'utf8');
const m = src.match(/function leadScore\(l\)\{[\s\S]*?\n  \}/);
if (!m) throw new Error('leadScore no encontrado en panel.html (¿cambió la indentación?)');

const NOW = 1700000000000;
// stubs deterministas: value/overdue vienen precomputados en el lead de prueba
const leadScore = new Function('leadValue', 'isOverdue', 'Date',
  m[0] + '\n return leadScore;'
)(l => l.value || 0, l => !!l.overdue, { now: () => NOW });

const L = (o) => Object.assign({ intent: 'exploring', updatedAt: NOW }, o);
const eq = (a, b, msg) => { if (a !== b) throw new Error(msg + ' → ' + a + ' !== ' + b); };
const gt = (a, b, msg) => { if (!(a > b)) throw new Error(msg + ' → ' + a + ' !<= ' + b); };

// 1. cliente esperando respuesta manda sobre todo lo demás
gt(leadScore(L({ waiting: true })), leadScore(L({ intent: 'booking', value: 4300 })), 'waiting > booking caro');
// 2. jerarquía de intención (mismo valor/recencia)
gt(leadScore(L({ intent: 'booking' })), leadScore(L({ intent: 'interested' })), 'booking > interested');
gt(leadScore(L({ intent: 'interested' })), leadScore(L({ intent: 'exploring' })), 'interested > exploring');
// 3. a igual intención, más valor = más caliente
gt(leadScore(L({ intent: 'booking', value: 4300 })), leadScore(L({ intent: 'booking', value: 0 })), 'valor sube el score');
// 4. seguimiento vencido suma
gt(leadScore(L({ overdue: true })), leadScore(L({})), 'vencido > al día');
// 5. archivado = 0
eq(leadScore(L({ waiting: true, archived: true })), 0, 'archivado = 0');
// 6. un lead que espera cruza el umbral de fila caliente (>=90)
gt(leadScore(L({ waiting: true })), 89, 'waiting cruza umbral hot');

console.log('OK leadscore: 7 asserts');
